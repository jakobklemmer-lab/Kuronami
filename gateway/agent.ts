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
import { type AnalysenArchiv, createAnalysen } from "./analysen.js";
import { BUEHNE_TOOLS, createBuehne } from "./buehne.js";
import { HAUS_TOOLS, createHaus } from "./haus.js";
import { createYahooMarkets } from "./integrations/markets.js";
import { createKerzenquelle } from "./kerzen.js";
import { type Papierhandel, createPapierhandel } from "./papierhandel.js";
import { createSendePostfach } from "./postfach-werkzeuge.js";
import { konten } from "./postfach.js";
import { type Prognosenbuch, createPrognosen } from "./prognosen.js";
import { type StrategienArchiv, createStrategien } from "./strategien.js";
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
  ...HAUS_TOOLS,
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
  /**
   * Textstücke während der Antwort — die Oberfläche schreibt live mit.
   *
   * `zugId` ist der Grund, warum hier ein zweiter Parameter steht: der Bus trägt die Stücke
   * **aller** Züge derselben Sitzung, und Züge stehen Schlange (`#laufend`). Ohne die Kennung
   * kann ein Empfänger nicht unterscheiden, ob das nächste Stück noch zu seiner Antwort gehört
   * oder schon zur nächsten — und hängt beides aneinander.
   */
  onDelta?(text: string, zugId: string): void;
  /** Kosten und Token nach jedem Zug, für die Anzeige in den Einstellungen. */
  onUsage?(usage: ZugKosten): void;
  /**
   * Ein Ereignis für die Oberfläche: `ui.zeige`/`ui.verberge` von der Bühne, `haus.arbeitet`/
   * `haus.fertig`, wenn ein Bediensteter anfängt oder zurückkommt. Die Präsenz-Oberfläche
   * macht daraus Bewegung im Wasser — ohne diesen Kanal wüsste sie nur vom Butler, nichts vom
   * Personal.
   */
  publish?(type: string, data: Record<string, unknown>): void;
  /** Das Analysen-Archiv. Vorgabe: ein Ordner `analysen/` im Arbeitsbereich. */
  analysen?: AnalysenArchiv;
  /** Das Strategie-Archiv. Vorgabe: ein Ordner `strategien/` im Arbeitsbereich. */
  strategien?: StrategienArchiv;
  /** Der Papierhandel. Vorgabe: ein Ordner `papierhandel/` im Arbeitsbereich, Kurse von Yahoo. */
  papier?: Papierhandel;
  /** Das Prognosebuch. Vorgabe: ein Ordner `prognosen/` im Arbeitsbereich. */
  prognosen?: Prognosenbuch;
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

/**
 * Wie lange eine gesprochene Nachricht auf ihre Fortsetzung wartet.
 *
 * Die Spracherkennung schneidet nach einer Sprechpause (`VOICE_VAD_STOP_SECS`, Vorgabe 0,8 s),
 * und ein Mensch macht mitten im Satz Pausen. Am 2026-09-20 zerfiel ein einziger Gedanke in
 * vier Nachrichten — „Also es ist ja irgendwie jetzt schon" / „länger." / „Ja, ich wollte
 * fragen, wie lang ist ja" —, und Kuro beantwortete jedes Bruchstück einzeln, eines davon mit
 * „Das hatte ich eben schon gesagt". Kein Mensch redet so mit jemandem, der zuhört.
 *
 * Also: kurz sammeln, dann **einen** Zug daraus machen. Kostet eine halbe Sekunde und spart
 * drei Züge und eine unwirsche Antwort.
 */
const BUENDEL_MS = Number(process.env.KURO_BUENDEL_MS ?? 600);

/** Ein Bündel Nachrichten, das noch auf seinen Zug wartet. */
interface Stapel {
  nachrichten: InboundMessage[];
  lauf: Promise<AgentOutcome>;
}

/**
 * Mehrere Nachrichten zu einer machen.
 *
 * Kennung und Absender bleiben die der **ersten** — an ihr hängt der Ereignisstrom, den der
 * Sprachkanal schon geöffnet hat, und dort sollen die Wortstücke ankommen.
 */
function vereine(nachrichten: InboundMessage[]): InboundMessage {
  const erste = nachrichten[0];
  if (nachrichten.length === 1) return erste;
  return {
    ...erste,
    content: nachrichten
      .map((n) => n.content.trim())
      .filter((t) => t !== "")
      .join(" "),
    attachments: nachrichten.flatMap((n) => n.attachments),
    receivedAt: nachrichten[nachrichten.length - 1].receivedAt,
  };
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
  /** Wohin fertige Analysen gelegt werden, damit Jakob sie vor einem Trade nachlesen kann. */
  readonly #analysen: AnalysenArchiv;
  /** Wohin geprüfte Strategien gelegt werden — Regeln samt ihrem Backtest. */
  readonly #strategien: StrategienArchiv;
  /** Der Betrieb: geprüfte Regeln gegen den laufenden Markt, mit Buchgeld. */
  readonly #papier: Papierhandel;
  readonly #prognosen: Prognosenbuch;
  /** Die Bühne: womit Kuro Jakob etwas hinstellt. */
  readonly #buehne: ReturnType<typeof createBuehne>;
  /** Wohin ein nachgereichter Bericht geht: dorthin, wo zuletzt jemand geschrieben hat. */
  #letzterSender: Sender | null = null;
  /** Steht eine abgeschlossene Wortmeldung im Strom, der noch ein Absatz fehlt? */
  #absatzOffen = false;
  /** Was noch nicht losgelaufen ist und deshalb noch zu einem Zug zusammenfinden kann. */
  #stapel: Stapel | null = null;

  constructor(deps: AgentDeps) {
    this.#deps = deps;
    this.#workdir = deps.workdir ?? process.env.KURO_WORKDIR?.trim() ?? DEFAULT_WORKDIR;
    this.#analysen = deps.analysen ?? createAnalysen({ workdir: this.#workdir });
    this.#strategien = deps.strategien ?? createStrategien({ workdir: this.#workdir });
    this.#papier =
      deps.papier ??
      createPapierhandel({
        workdir: this.#workdir,
        markets: createYahooMarkets(),
        strategien: this.#strategien,
        // Was im Betrieb passiert, gehört auf den Bus: die Oberfläche zeigt es, und ein
        // gesperrtes Konto soll niemand erst beim nächsten Nachfragen erfahren.
        onEreignis: (text) => {
          console.log(`[papier] ${text}`);
          deps.publish?.("papier.ereignis", { text });
        },
      });
    // Das Prognosebuch teilt sich den Kerzenspeicher mit dem Labor: dieselben Kerzen, aus
    // denen der Backtest rechnet, benoten auch die Einzelideen. Zwei Speicher hießen zwei
    // Wahrheiten über denselben Tag.
    this.#prognosen =
      deps.prognosen ??
      createPrognosen({
        workdir: this.#workdir,
        kerzen: async (symbol, vonUnix, bisUnix) => {
          const quelle = createKerzenquelle({
            workdir: this.#workdir,
            markets: createYahooMarkets(),
          });
          const geholt = await quelle.hole({ symbol, intervall: "1d", vonUnix, bisUnix });
          return geholt.kerzen;
        },
      });
    this.#haus = createHaus({
      strategien: this.#strategien,
      papier: this.#papier,
      prognosen: this.#prognosen,
      // Auch die Protokollzeile läuft durch den Filter: der Auftragstext trägt alles weiter,
      // was Jakob vorher geschrieben hat, und journalctl bewahrt es auf.
      //
      // Und — seit dem 2026-09-20 — **nicht nur** die Protokollzeile. Die Oberfläche hat die
      // Gegenstelle für diese drei Ereignisse von Anfang an mitgebracht (`view.ts` setzt die
      // Standzeile, `sphaere.ts` lässt je Bedienstetem einen Boten um den Orb kreisen); nur
      // gesendet hat sie nie jemand. Die Boten sind nie geflogen, und Kuro konnte auf „wie
      // weit ist er?" nichts sagen, obwohl der Gateway es wusste.
      onArbeitet: (wer, auftrag) => {
        console.log(`[haus] ${wer} übernimmt: ${redactText(auftrag.slice(0, 90))}`);
        deps.publish?.("haus.arbeitet", { wer, auftrag: redactText(auftrag.slice(0, 200)) });
      },
      onFortschritt: (wer, text, wobei) => {
        console.log(`[haus] ${wer}${wobei ? ` (${wobei})` : ""}: ${text}`);
        deps.publish?.("haus.fortschritt", { wer, text, ...(wobei ? { wobei } : {}) });
      },
      onFertig: (wer, kosten, dauer) => {
        console.log(
          `[haus] ${wer} fertig nach ${(dauer / 1000).toFixed(1)}s, $${kosten.toFixed(4)}`,
        );
        deps.publish?.("haus.fertig", { wer, kostenUsd: kosten, dauerMs: dauer });
      },
      onNachgereicht: (wer, bericht) => void this.#trageNach(wer, bericht),
      onAnalyse: (eintrag) => {
        void this.#analysen.lege(eintrag).then(
          (gespeichert) => {
            if (gespeichert) {
              console.log(`[analysen] ${eintrag.wer}: ${gespeichert.titel} (${gespeichert.id})`);
              deps.publish?.("analyse.neu", { id: gespeichert.id, titel: gespeichert.titel });
            }
          },
          (fehler) => console.error("[analysen] nicht gespeichert:", fehler),
        );
      },
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

  /** Das Archiv der Analysen — die Oberfläche liest daraus. */
  get analysen(): AnalysenArchiv {
    return this.#analysen;
  }

  get strategien(): StrategienArchiv {
    return this.#strategien;
  }

  get papier(): Papierhandel {
    return this.#papier;
  }

  /** Was die Bediensteten gerade tun. Die Oberfläche zeigt es, wenn kein Zug läuft. */
  get laufendeAuftraege(): Array<{
    wer: string;
    stand: string;
    begonnen: number;
    zuarbeit: string[];
  }> {
    return this.#haus.laufende().map(({ wer, stand, begonnen, zuarbeit }) => ({
      wer,
      stand,
      begonnen,
      zuarbeit,
    }));
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

    // Was noch nicht losgelaufen ist, wird gebündelt statt nacheinander abgearbeitet.
    if (this.#stapel) {
      this.#stapel.nachrichten.push(message);
      return this.#stapel.lauf;
    }

    const stapel: Stapel = { nachrichten: [message], lauf: Promise.resolve() as never };
    this.#stapel = stapel;
    const lauf = this.#laufend.then(async () => {
      // Der Sammelmoment. Nur für die Stimme: ein Tastendruck ist fertig, wenn er abgeschickt
      // wird, ein Satz nicht.
      const sammeln = message.channel === "voice" ? BUENDEL_MS : 0;
      if (sammeln > 0) await new Promise((fertig) => setTimeout(fertig, sammeln).unref?.());
      if (this.#stapel === stapel) this.#stapel = null;
      return this.#run(vereine(stapel.nachrichten));
    });
    stapel.lauf = lauf;
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
        content: `[Der Bericht von ${wer} ist eingetroffen. Trage ihn Jakob jetzt von dir aus vor — er hat zwischenzeitlich etwas anderes getan, also knüpfe kurz an den Auftrag an.]\n\n${bericht}`,
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

    // Ein Zug hat einen Namen, und er sagt an, wann er anfängt und wann er aufhört.
    //
    // Der alte Läufer schrieb `turn.started`/`turn.completed` ins Protokoll; mit dem
    // Motorwechsel fiel das weg, und niemand bemerkte es, weil die Oberfläche dabei nicht
    // abstürzt — sie hängt die Worte des neuen Zugs nur an die des alten. Genau das stand am
    // 2026-09-20 in der Antwortblase: vier Antworten in einem Absatz, ohne Trennung.
    const zug = this.#zug(message);
    this.#absatzOffen = false;
    this.#deps.publish?.("turn.started", zug);

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
            haus: this.#haus.server,
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
        const stueck = this.#verarbeite(nachricht, zug);
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
      this.#deps.publish?.("turn.completed", { ...zug, status: "failed", reason: grund });
      await this.#zustellen(origin, antwort);
      return {
        sessionId: this.#sessionId ?? "",
        status: "failed",
        reason: grund,
        delivered: [antwort],
      };
    }

    const antwort: Outbound = { kind: "reply", text: text.trim() || "(keine Antwort)" };
    // **Vor** der Zustellung: wer den Zug mitliest, soll das Ende kennen, bevor der fertige
    // Text ankommt. Andersherum stünde einen Wimpernschlag lang die Antwort da, während der
    // Zug für den Empfänger noch läuft — und das nächste Textstück landete noch in diesem.
    this.#deps.publish?.("turn.completed", { ...zug, status: "answered", text: antwort.text });
    await this.#zustellen(origin, antwort);
    geliefert.push(antwort);

    return {
      sessionId: this.#sessionId ?? "",
      status: "answered",
      reason: "Beantwortet.",
      delivered: geliefert,
    };
  }

  /**
   * Die Kennung eines Zugs, wie sie auf dem Bus steht.
   *
   * `external_id` steht dabei, weil der Sprach-Kanal seinen Zug darüber wiederfindet: er
   * schickt eine Nachricht und bekommt einen Ereignisstrom, der **alle** Züge der Sitzung
   * trägt. Die Kennung, die er selbst vergeben hat, ist das Einzige, was er schon kennt,
   * bevor der Zug beginnt.
   */
  #zug(message: InboundMessage): {
    session_id: string;
    turn_id: string;
    external_id: string;
    channel: string;
  } {
    return {
      session_id: this.#sessionId ?? "",
      turn_id: `zug_${randomUUID()}`,
      external_id: message.externalId,
      channel: message.channel,
    };
  }

  /** Eine SDK-Nachricht auswerten. Gibt fertigen Antworttext zurück, sonst `null`. */
  #verarbeite(nachricht: SDKMessage, zug: { turn_id: string }): string | null {
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
        // Derselbe Absatz wie unten beim fertigen Text — nur muss er hier vorgezogen werden,
        // weil der Strom die Grenze zwischen zwei Wortmeldungen sonst nicht zeigt. Ohne ihn
        // stand „…im Blick.Ich lasse das Postfach…" in einer Zeile, und die Sprachschicht
        // fand keinen Satz mehr zum Sprechen: ihr Satzende verlangt Leerraum nach dem Punkt.
        if (stueck && this.#absatzOffen) {
          this.#absatzOffen = false;
          this.#deps.onDelta?.("\n\n", zug.turn_id);
        }
        if (stueck) this.#deps.onDelta?.(stueck, zug.turn_id);
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
      // Diese Wortmeldung ist zu Ende. Kommt später noch eine, gehört ein Absatz dazwischen.
      if (text) this.#absatzOffen = true;
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
