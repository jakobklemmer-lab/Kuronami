import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { KURO_PERSONA } from "../context/persona.js";
import { redactText } from "../runtime/redaction/redact.js";
import { BUEHNE_TOOLS, createBuehne } from "./buehne.js";
import { BEAUFTRAGE_TOOL, createHaus } from "./haus.js";
import { createSendePostfach } from "./postfach-werkzeuge.js";
import { konten } from "./postfach.js";
import type { ChannelRegistry, InboundMessage, Outbound, Sender } from "./types.js";

/**
 * Der Motor: Claude Code als Bibliothek, hinter derselben Kanalgrenze wie zuvor.
 *
 * Diese Datei ersetzt `conversation.ts` + `core.ts` + alles unter `runtime/`, `tools/`,
 * `policy/` und `context/` — rund 23.000 Zeilen selbstgebaute Agentenschleife. Was dort von
 * Hand entstand (Schleife, Sitzungen, Kontextverwaltung, Kompaktierung, Werkzeugkatalog,
 * Freigaben, Subagenten, Prompt-Caching), bringt das Agent-SDK fertig mit.
 *
 * Die Kanäle merken davon nichts: rein kommt eine `InboundMessage`, raus geht `Outbound`
 * über denselben `ChannelPort`. Web, Telegram, Slack und die Sprachschicht bleiben
 * unverändert.
 *
 * Drei Entscheidungen, die hier sichtbar sind:
 *
 *  1. **Eine fortlaufende Sitzung, aber eine, die sich selbst kürzt.** Die alte Runtime hielt
 *     genau eine Session pro Nutzer, für immer, und schickte am Ende 65.000 Token pro Aufruf
 *     — 52.000 davon zum vollen Preis. `resume` setzt dieselbe Unterhaltung fort, aber Claude
 *     Code kompaktiert sie, wenn sie zu lang wird, und setzt die Cache-Haltepunkte selbst.
 *
 *  2. **Rückfragen nehmen Freitext.** `canUseTool` fragt über den Kanal und wartet. Eine
 *     Antwort, die keine Zustimmung ist, wird nicht verworfen und hält auch nichts an: sie
 *     geht als Begründung zurück ins Modell. „Nein, nimm lieber Yahoo" ist damit eine
 *     Anweisung und kein abgeprallter Tastendruck. Genau das ging per Stimme bisher nicht.
 *
 *  3. **Kuro arbeitet in seinem eigenen Verzeichnis**, nicht im Quellbaum. `cwd` ist der
 *     Arbeitsbereich (`KURO_WORKDIR`); der Gateway-Code liegt außerhalb und ist für ihn
 *     weder les- noch schreibbar, solange er nicht ausdrücklich dazugelegt wird.
 */

/** Vorgabe für den Arbeitsbereich, in dem Kuro Dateien anlegt und liest. */
const DEFAULT_WORKDIR = "/opt/kuronami/workspace";

/**
 * Werkzeuge, die ohne Rückfrage laufen.
 *
 * Die Trennlinie ist „liest oder sucht" gegen „verändert etwas außerhalb des Arbeitsbereichs".
 * Lesen, Suchen und Abrufen sind der Alltag eines Butlers; jede Rückfrage dafür wäre die Art
 * Reibung, die das ganze System unbenutzbar macht. Schreiben innerhalb des Arbeitsbereichs
 * zählt dazu — es ist sein Schreibtisch.
 */
const ALLOWED_WITHOUT_ASKING = [
  "WebSearch",
  "WebFetch",
  "Read",
  "Write",
  BEAUFTRAGE_TOOL,
  ...BUEHNE_TOOLS,
];

/**
 * Werkzeuge, die **Kuro** nicht bekommt.
 *
 * Ein Butler hämmert nicht selbst. Jedes Werkzeug kostet sein Schema in jedem Modellaufruf,
 * und `Bash`, `Edit`, `Glob`, `Grep` sind das Handwerkszeug der Bediensteten, nicht seines.
 * `Task`/`Agent` steht hier, weil die Delegation über `mcp__haus__beauftrage` läuft: ein
 * zweiter, allgemeiner Weg dorthin brächte nur Schemakosten und die Versuchung, ihn zu nehmen.
 *
 * Wichtig: diese Liste gilt **nur für diesen Lauf**. Die Bediensteten starten in `haus.ts`
 * ihren eigenen und haben dort ihren vollen Werkzeugkasten. Genau daran war der erste Versuch
 * über die `agents`-Option gescheitert — dort wirkt die Liste global, und Kuros Grundlast
 * stieg von 13.500 auf 24.700 Token, weil die Werkstatt `Bash` brauchte.
 */
const NICHT_FUER_EINEN_BUTLER = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Task",
  "Agent",
  "TodoWrite",
  "NotebookEdit",
  "KillShell",
  "BashOutput",
];

/** Die Zustimmungswörter aus `choices.ts` — dieselbe Liste, damit Stimme und Tastatur
 *  dasselbe bedeuten. Alles andere ist keine Zustimmung, auch nicht „eigentlich schon". */
const YES = new Set([
  "ja",
  "jawohl",
  "jup",
  "jo",
  "klar",
  "genau",
  "okay",
  "ok",
  "mach",
  "machs",
  "mach das",
  "los",
  "gerne",
  "bitte",
  "freigeben",
  "genehmigen",
  "erlauben",
  "zustimmen",
  "einverstanden",
  "passt",
]);

function istZustimmung(text: string): boolean {
  const wort = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "");
  return YES.has(wort);
}

export interface AgentDeps {
  /** Arbeitsbereich. Vorgabe: `KURO_WORKDIR` oder `/opt/kuronami/workspace`. */
  workdir?: string;
  /** Modell. Vorgabe: `KURO_MODEL`, sonst die Vorgabe des SDK. */
  model?: string;
  channels: ChannelRegistry;
  /** Textstücke während der Antwort — die Oberfläche schreibt live mit. */
  onDelta?(text: string): void;
  /** Kosten und Token nach jedem Zug, für die Anzeige in den Einstellungen. */
  onUsage?(usage: ZugKosten): void;
  /**
   * Ein Ereignis für die Oberfläche: `ui.zeige`/`ui.verberge` von der Bühne, `haus.arbeitet`/
   * `haus.fertig`, wenn ein Bediensteter anfängt oder zurückkommt. Die Präsenz-Oberfläche
   * macht daraus Bewegung im Wasser — ohne diesen Kanal wüsste sie nur vom Butler, nichts vom
   * Personal.
   */
  publish?(type: string, data: Record<string, unknown>): void;
}

export interface ZugKosten {
  kostenUsd: number;
  dauerMs: number;
  zuege: number;
  eingabe: number;
  cacheGelesen: number;
  cacheGeschrieben: number;
  ausgabe: number;
}

export interface AgentOutcome {
  sessionId: string;
  status: "answered" | "failed";
  reason: string;
  delivered: Outbound[];
}

/** Eine offene Rückfrage, die auf die Antwort des Nutzers wartet. */
interface OffeneFrage {
  askId: string;
  frage: string;
  /** Wohin sie gestellt wurde — die Kanäle zeigen sie dort wieder an. */
  to: Sender;
  aufloesen(antwort: string): void;
}

export class KuroAgent {
  readonly #deps: AgentDeps;
  readonly #workdir: string;
  /** Die laufende Unterhaltung. `null`, bis die erste Nachricht sie eröffnet hat. */
  #sessionId: string | null = null;
  /** Genau eine Rückfrage kann offen sein — mehr wäre eine Zuordnung, die niemand trifft. */
  #offen: OffeneFrage | null = null;
  /** Ein Zug nach dem anderen. Zwei gleichzeitig würden dieselbe Sitzung überschreiben. */
  #laufend: Promise<unknown> = Promise.resolve();
  /** Das Personal, hinter einem Werkzeug. */
  readonly #haus: ReturnType<typeof createHaus>;
  /** Die Bühne: womit Kuro Jakob etwas hinstellt. */
  readonly #buehne: ReturnType<typeof createBuehne>;
  /** Wohin ein nachgereichter Bericht geht: dorthin, wo zuletzt jemand geschrieben hat. */
  #letzterSender: Sender | null = null;

  constructor(deps: AgentDeps) {
    this.#deps = deps;
    this.#workdir = deps.workdir ?? process.env.KURO_WORKDIR?.trim() ?? DEFAULT_WORKDIR;
    this.#haus = createHaus({
      // Auch die Protokollzeile läuft durch den Filter: der Auftragstext trägt alles weiter,
      // was Jakob vorher geschrieben hat, und journalctl bewahrt es auf.
      onArbeitet: (wer, auftrag) =>
        console.log(`[haus] ${wer} übernimmt: ${redactText(auftrag.slice(0, 90))}`),
      onFertig: (wer, kosten, dauer) =>
        console.log(
          `[haus] ${wer} fertig nach ${(dauer / 1000).toFixed(1)}s, $${kosten.toFixed(4)}`,
        ),
      onNachgereicht: (wer, bericht) => void this.#trageNach(wer, bericht),
    });
    this.#buehne = createBuehne({
      publish: (type, data) => deps.publish?.(type, data),
    });
  }

  get workdir(): string {
    return this.#workdir;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** Steht eine Rückfrage offen? Die Oberfläche zeigt das an, die Kanäle fragen danach. */
  get offeneFrage(): { askId: string; frage: string; to: Sender } | null {
    if (!this.#offen) return null;
    const { askId, frage, to } = this.#offen;
    return { askId, frage, to };
  }

  async start(): Promise<void> {
    await mkdir(this.#workdir, { recursive: true });
    this.#sessionId = await leseSitzung(this.#workdir);
  }

  /**
   * Eine Nachricht verarbeiten.
   *
   * Steht eine Rückfrage offen, ist **diese Nachricht die Antwort darauf** — egal wie sie
   * lautet. Das ist der Unterschied zur alten Runtime: dort prallte alles ab, was nicht
   * wörtlich eine der angebotenen Optionen traf, und die Unterhaltung stand still.
   */
  async receive(message: InboundMessage): Promise<AgentOutcome> {
    if (this.#offen) {
      const offen = this.#offen;
      this.#offen = null;
      offen.aufloesen(message.content);
      return {
        sessionId: this.#sessionId ?? "",
        status: "answered",
        reason: `Antwort auf ${offen.askId} übernommen.`,
        delivered: [],
      };
    }

    const lauf = this.#laufend.then(() => this.#run(message));
    this.#laufend = lauf.catch(() => undefined);
    return lauf;
  }

  /**
   * Einen nachgereichten Bericht vortragen.
   *
   * Das ist kein Sonderweg neben dem Gespräch, sondern ein gewöhnlicher Zug: der Bericht geht
   * als Eingabe an Kuro, und was er daraus macht, geht an den Kanal. Deshalb klingt eine
   * nachgereichte Meldung wie er und nicht wie ein Systemhinweis — und deshalb kann Jakob
   * darauf antworten, als hätte Kuro von sich aus etwas gesagt.
   */
  async #trageNach(wer: string, bericht: string): Promise<void> {
    const to = this.#letzterSender;
    if (!to) return;

    const lauf = this.#laufend.then(() =>
      this.#run({
        channel: to.channel,
        sender: to,
        content:
          `[Der Bericht von ${wer} ist eingetroffen. Trage ihn Jakob jetzt von dir aus vor — ` +
          `er hat zwischenzeitlich etwas anderes getan, also knüpfe kurz an den Auftrag an.]\n\n` +
          bericht,
        attachments: [],
        receivedAt: new Date(),
        externalId: `nachtrag_${randomUUID()}`,
      }),
    );
    this.#laufend = lauf.catch(() => undefined);
    await lauf.catch((error) => console.error("[haus] Nachtrag misslungen:", error));
  }

  async #run(message: InboundMessage): Promise<AgentOutcome> {
    const origin = message.sender;
    this.#letzterSender = origin;
    const geliefert: Outbound[] = [];
    let text = "";

    try {
      for await (const nachricht of query({
        prompt: renderEingabe(message),
        options: {
          cwd: this.#workdir,
          model: this.#deps.model ?? process.env.KURO_MODEL?.trim(),
          // Ein **eigener** Prompt statt des `claude_code`-Presets. Der Preset brachte rund
          // 44.000 Token Programmieranleitung mit, die bei jeder Nachricht mitliefen — auch
          // bei „wie ist das Wetter" — und die den Butler-Ton übertönten. Siehe persona.ts.
          systemPrompt: { type: "custom", prompt: KURO_PERSONA },
          // Lädt CLAUDE.md aus dem Arbeitsbereich — Kuros Hausregeln.
          settingSources: ["project"],
          allowedTools: ALLOWED_WITHOUT_ASKING,
          disallowedTools: NICHT_FUER_EINEN_BUTLER,
          // Das Gesindehaus als ein einzelnes Werkzeug. Die Bediensteten selbst laufen
          // dahinter in eigenen Läufen (`haus.ts`) — ihre Werkzeuge stehen nicht in Kuros
          // Katalog, und was sie lesen und denken, landet nicht in seinem Kontext.
          mcpServers: {
            haus: this.#haus,
            buehne: this.#buehne,
            // Der Versand liegt bei Kuro, nicht beim Sekretär — und steht bewusst **nicht**
            // in `ALLOWED_WITHOUT_ASKING`. Er fragt also vor jeder Mail, die hinausgeht.
            ...(konten().length > 0 ? { versand: createSendePostfach() } : {}),
          },
          // Obergrenze für Kuros eigenen Lauf. Die Aufträge an Bedienstete haben je eine
          // eigene (`haus.ts`), damit ein Bauauftrag nicht sein Gesprächsbudget aufzehrt.
          maxBudgetUsd: Number(process.env.KURO_BUDGET_USD ?? 3),
          canUseTool: this.#fragen(origin),
          includePartialMessages: true,
          ...(this.#sessionId ? { resume: this.#sessionId } : {}),
        },
      })) {
        const stueck = this.#verarbeite(nachricht);
        // Mit Absatz trennen: Kuro spricht oft zweimal — einmal beim Abschicken eines
        // Auftrags („ich lasse das ansehen"), einmal beim Vortragen des Ergebnisses. Ohne
        // Trenner klebte beides aneinander.
        if (stueck) text += (text ? "\n\n" : "") + stueck;
      }
    } catch (error) {
      const grund = error instanceof Error ? error.message : String(error);
      const antwort: Outbound = {
        kind: "reply",
        text: `Das ist mir misslungen: ${grund}`,
      };
      await this.#zustellen(origin, antwort);
      return {
        sessionId: this.#sessionId ?? "",
        status: "failed",
        reason: grund,
        delivered: [antwort],
      };
    }

    const antwort: Outbound = { kind: "reply", text: text.trim() || "(keine Antwort)" };
    await this.#zustellen(origin, antwort);
    geliefert.push(antwort);

    return {
      sessionId: this.#sessionId ?? "",
      status: "answered",
      reason: "Beantwortet.",
      delivered: geliefert,
    };
  }

  /** Eine SDK-Nachricht auswerten. Gibt fertigen Antworttext zurück, sonst `null`. */
  #verarbeite(nachricht: SDKMessage): string | null {
    if (nachricht.type === "system" && "session_id" in nachricht) {
      // Die Sitzung merken, sobald sie feststeht — auch bei der allerersten Nachricht,
      // sonst eröffnete die nächste eine zweite statt fortzusetzen.
      const id = (nachricht as { session_id?: string }).session_id;
      if (id && id !== this.#sessionId) {
        this.#sessionId = id;
        void schreibeSitzung(this.#workdir, id);
      }
      return null;
    }

    if (nachricht.type === "stream_event") {
      // Auch hier: was ein Bediensteter denkt, geht nicht auf Jakobs Bildschirm.
      if ((nachricht as { parent_tool_use_id?: string | null }).parent_tool_use_id) return null;
      // Textstücke live an die Oberfläche. Nur Text — Werkzeugaufrufe gehören nicht in den
      // Antwortstrom, die Oberfläche zeigt sie über die Statuszeile.
      const ereignis = (
        nachricht as { event?: { type?: string; delta?: { type?: string; text?: string } } }
      ).event;
      if (ereignis?.type === "content_block_delta" && ereignis.delta?.type === "text_delta") {
        const stueck = ereignis.delta.text ?? "";
        if (stueck) this.#deps.onDelta?.(stueck);
      }
      return null;
    }

    if (nachricht.type === "assistant") {
      // Was Kuro gerade anfasst, geht als Ereignis an die Oberfläche. Ohne das sind die
      // Sekunden zwischen Frage und erstem Wort stumm — er holt Daten, stellt eine Tafel hin,
      // und niemand sieht es. Nur die eigenen Aufrufe, nicht die der Bediensteten.
      if (nachricht.parent_tool_use_id === null) {
        for (const block of nachricht.message.content) {
          if (block.type === "tool_use") {
            this.#deps.publish?.("kuro.werkzeug", { name: block.name });
          }
        }
      }
      // **Nur der Butler spricht.** Nachrichten aus einer Bedienstetenunterhaltung tragen
      // `parent_tool_use_id`; ihr Text ist ein interner Bericht an Kuro und nicht für Jakob
      // bestimmt. Ohne diese Zeile stand der komplette Rohbericht des Analysten mitsamt
      // Markdown-Überschriften und Quellenliste in der Antwort, eingeklemmt zwischen Kuros
      // Ankündigung und seinem eigentlichen Vortrag.
      if (nachricht.parent_tool_use_id !== null) return null;

      let text = "";
      for (const block of nachricht.message.content) {
        if (block.type === "text") text += block.text;
      }
      return text || null;
    }

    if (nachricht.type === "result") {
      if (nachricht.subtype === "success") {
        const u = nachricht.usage;
        this.#deps.onUsage?.({
          kostenUsd: nachricht.total_cost_usd,
          dauerMs: nachricht.duration_ms,
          zuege: nachricht.num_turns,
          eingabe: u.input_tokens ?? 0,
          cacheGelesen: u.cache_read_input_tokens ?? 0,
          cacheGeschrieben: u.cache_creation_input_tokens ?? 0,
          ausgabe: u.output_tokens ?? 0,
        });
      }
      return null;
    }

    return null;
  }

  /**
   * Die Freigabe-Rückfrage.
   *
   * Sie stellt die Frage über denselben Kanal, über den der Nutzer gerade schreibt, und
   * wartet auf seine nächste Nachricht — getippt oder gesprochen, das ist hier dasselbe.
   *
   * Der entscheidende Teil steht im `else`-Zweig: eine Antwort, die keine Zustimmung ist,
   * wird als `deny.message` zurückgegeben und landet damit **im Modell**. Kuro liest „nein,
   * nimm lieber Yahoo Finance" und versucht Yahoo, statt die Unterhaltung anzuhalten.
   */
  #fragen(origin: Sender): CanUseTool {
    return async (toolName, input, { signal }): Promise<PermissionResult> => {
      const askId = `ask_${randomUUID()}`;
      const frage = `${beschreibe(toolName, input)} — einverstanden?`;

      const antwort = await new Promise<string>((resolve) => {
        this.#offen = { askId, frage, to: origin, aufloesen: resolve };
        void this.#zustellen(origin, {
          kind: "approval",
          askId,
          question: frage,
          options: [
            { id: "ja", label: "Ja, mach das" },
            { id: "nein", label: "Nein, lass es" },
          ],
        });
        signal.addEventListener("abort", () => {
          if (this.#offen?.askId === askId) this.#offen = null;
          resolve("nein");
        });
      });

      if (istZustimmung(antwort)) return { behavior: "allow" };

      return {
        behavior: "deny",
        message: `Der Nutzer hat diesen Schritt nicht freigegeben und stattdessen geantwortet: „${antwort}". Richte dich danach.`,
      };
    };
  }

  async #zustellen(to: Sender, message: Outbound): Promise<void> {
    const kanal = this.#deps.channels.get(to.channel);
    if (!kanal) throw new Error(`Kanal ${to.channel} ist nicht eingerichtet.`);
    await kanal.deliver(to, message);
  }
}

/**
 * Die Nachricht, wie das Modell sie liest.
 *
 * Kanal und Zeit stehen dabei, weil sie den Inhalt verändern können — „schick mir das gleich
 * zu" heißt per Telegram etwas anderes als im Web. Dieselbe Begründung wie in der alten
 * `renderTurnInput`, nur kürzer: den Rest weiß Claude Code selbst.
 */
function renderEingabe(message: InboundMessage): string {
  const kopf = `[${message.channel}, ${message.receivedAt.toLocaleString("de-AT")}]`;
  const anhaenge = message.attachments.length
    ? `\nAnhänge: ${message.attachments.map((a) => `${a.name} (${a.mimeType})`).join(", ")}`
    : "";
  return `${kopf}\n${message.content}${anhaenge}`;
}

/** Ein Werkzeugaufruf in einem Satz, den man vorgelesen bekommen kann. */
function beschreibe(toolName: string, input: Record<string, unknown>): string {
  const pfad = typeof input.file_path === "string" ? input.file_path : null;
  const befehl = typeof input.command === "string" ? input.command : null;

  if (toolName === "Bash" && befehl) return `Ich möchte ausführen: ${befehl}`;
  if (pfad) return `Ich möchte ${toolName} auf ${pfad} anwenden`;
  return `Ich möchte ${toolName} benutzen`;
}

const SITZUNGSDATEI = ".kuro-session";

async function leseSitzung(workdir: string): Promise<string | null> {
  try {
    const roh = (await readFile(path.join(workdir, SITZUNGSDATEI), "utf8")).trim();
    return roh || null;
  } catch {
    // Keine Datei heißt: erste Unterhaltung. Kein Fehler.
    return null;
  }
}

async function schreibeSitzung(workdir: string, sessionId: string): Promise<void> {
  try {
    await writeFile(path.join(workdir, SITZUNGSDATEI), `${sessionId}\n`, "utf8");
  } catch {
    // Die Sitzung läuft auch ohne Notiz weiter; nur ein Neustart begänne von vorn.
    // Das ist kein Grund, den laufenden Zug scheitern zu lassen.
  }
}
