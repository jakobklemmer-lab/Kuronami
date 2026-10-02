import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Das Gesprächsarchiv (2026-09-27): Kuros Unterhaltung wird regelmäßig abgelegt, nach Tagen, im
 * Wortlaut — und die nächste beginnt frisch, mit einer Übergabe.
 *
 * Jakob: „Sitzungen regelmäßig mit Datum und ordentlicher Ordnung archivieren, so, dass Kuro
 * danach auch wieder reinschauen kann, um den Kontext zu verkleinern." Kuro setzt seine
 * Unterhaltung mit `resume` fort, und jeder Zug liest sie ganz: am 27.09. waren das 52.000 Token
 * je Nachricht, davon 36.000 Gesprächsgeschichte aus fünf Tagen — auch für ein „Danke". Und alte
 * Geschichte schlägt neue Regeln: am 22.09. verleugnete Kuro einen Bediensteten, den sein
 * Systemprompt längst nannte, weil vier Tage Verlauf es anders sagten (`kuronami-haushalt`).
 *
 * Deshalb nachts, wenn niemand spricht:
 *
 * 1. Die Rohdatei der Sitzung (`~/.claude/projects/…/<id>.jsonl`) wird gelesen und je Kalendertag
 *    (Wiener Zeit) als lesbarer Wortlaut abgelegt: `ablage/gespraeche/2026/2026-09-27.md`. Werkzeug-
 *    aufrufe stehen als eine kursive Zeile da, Berichte der Bediensteten im Wortlaut, Gedanken und
 *    Rohdaten nicht.
 * 2. Ein Modell schreibt die **Übergabe**: was offen ist, was Jakob festgelegt hat, worauf er sich
 *    beziehen könnte — und je Tag eine Zeile Themen fürs Inhaltsverzeichnis.
 * 3. Erst wenn beides steht, wird geschrieben und die Sitzung gewechselt. Scheitert die Übergabe,
 *    bleibt alles, wie es war, und der nächste Takt versucht es wieder: ein frischer Kuro ohne
 *    Übergabe wäre schlechter als ein alter mit langem Gedächtnis.
 *
 * Die Übergabe steht der neuen Sitzung **fest im Systemprompt** (`uebergabeAbschnitt`), nicht als
 * Hinweis „lies zuerst die Datei" — den hat Kuro vorher schon übergangen. Den Wortlaut findet er
 * über `im_archiv_suchen` und das Inhaltsverzeichnis.
 */

export const ZONE = "Europe/Vienna";

/** Zwischen diesen Stunden (Wiener Zeit) wird archiviert — da spricht niemand. */
export const ARCHIV_FENSTER: readonly [number, number] = [3, 6];

/** So viel Wortlaut bekommt das Modell für die Übergabe höchstens — die jüngsten Zeichen zählen. */
const UEBERGABE_EINGABE_MAX = 160_000;

export interface Eintrag {
  zeit: string;
  wer: "jakob" | "kuro" | "bericht" | "hinweis";
  /** Bei Jakob: über welchen Kanal (`web`, `voice`, `telegram`). */
  kanal?: string;
  /** Bei einem Bericht: welcher Bedienstete. */
  von?: string;
  text: string;
  /** Bei Kuro: was er vor diesem Satz aufgerufen hat, je ein kurzer Satz. */
  werkzeuge?: string[];
}

// ------------------------------------------------------------------------------ Lesen

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

const NACHTRAG = /^\[Der Bericht von (\S+) ist eingetroffen[^\]]*\]\s*/;
const KOPF = /^\[(\w+), [^\]]*\]\n?/;

/** Was ein Werkzeugergebnis an Text trägt. */
function ergebnisText(inhalt: unknown): string {
  if (typeof inhalt === "string") return inhalt;
  if (Array.isArray(inhalt))
    return inhalt
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as Block).text) : ""))
      .join("\n");
  return "";
}

function kuerze(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Ein Werkzeugaufruf als kurzer Satz fürs Archiv. `null` für Verwaltungskram wie ToolSearch. */
export function werkzeugZeile(name: string, input: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "ToolSearch":
      return null;
    case "mcp__haus__beauftrage":
      return `beauftragt ${s("wer")}: „${kuerze(s("auftrag"), 160)}"`;
    case "mcp__haus__stand":
      return "fragt nach dem Stand der Aufträge";
    case "mcp__haus__abbrechen":
      return `bricht ${s("wer") || "einen Auftrag"} ab`;
    case "mcp__buehne__zeige":
      return `zeigt die Tafel „${s("tafel")}"`;
    case "mcp__buehne__verberge":
      return null;
    case "mcp__gedaechtnis__im_archiv_suchen":
      return `sucht im Archiv nach „${kuerze(s("suche"), 60)}"`;
    case "WebSearch":
      return `sucht im Netz: „${kuerze(s("query"), 80)}"`;
    case "WebFetch": {
      try {
        return `ruft ${new URL(s("url")).host} ab`;
      } catch {
        return "ruft eine Seite ab";
      }
    }
    case "Read":
      return `liest ${path.basename(s("file_path"))}`;
    case "Write":
      return `schreibt ${path.basename(s("file_path"))}`;
    default:
      if (name.startsWith("mcp__versand__")) return "legt eine Mail zum Versand vor";
      return `ruft ${name.replace(/^mcp__/, "").replace(/__/g, ".")}`;
  }
}

/**
 * Die Rohdatei einer Sitzung in Einträge. Gedanken, Zwischenstände und Werkzeugergebnisse bleiben
 * draußen — außer den Berichten der Bediensteten: die sind der Inhalt, um den es ging.
 */
export function leseVerlauf(jsonl: string): Eintrag[] {
  const eintraege: Eintrag[] = [];
  const aufrufe = new Map<string, { name: string; input: Record<string, unknown> }>();
  let offeneWerkzeuge: string[] = [];

  const kuro = (zeit: string, text: string) => {
    const letzter = eintraege[eintraege.length - 1];
    // Zwei Wortmeldungen desselben Zugs ohne Jakob dazwischen: ein Eintrag.
    if (letzter?.wer === "kuro" && offeneWerkzeuge.length === 0 && text) {
      letzter.text = letzter.text ? `${letzter.text}\n\n${text}` : text;
      return;
    }
    eintraege.push({
      zeit,
      wer: "kuro",
      text,
      ...(offeneWerkzeuge.length > 0 ? { werkzeuge: offeneWerkzeuge } : {}),
    });
    offeneWerkzeuge = [];
  };

  for (const zeile of jsonl.split("\n")) {
    if (!zeile.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(zeile) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.isSidechain || d.isMeta) continue;
    if (d.type !== "user" && d.type !== "assistant") continue;
    const zeit = typeof d.timestamp === "string" ? d.timestamp : "";
    const inhalt = (d.message as { content?: unknown } | undefined)?.content;
    const bloecke: Block[] =
      typeof inhalt === "string"
        ? [{ type: "text", text: inhalt }]
        : Array.isArray(inhalt)
          ? inhalt
          : [];

    if (d.type === "assistant") {
      for (const b of bloecke) {
        if (b.type === "tool_use" && b.name) {
          aufrufe.set(b.id ?? "", { name: b.name, input: b.input ?? {} });
          const z = werkzeugZeile(b.name, b.input ?? {});
          if (z) offeneWerkzeuge.push(z);
        }
        if (b.type === "text" && b.text?.trim()) {
          const text = b.text.trim();
          if (text === "No response requested.") continue;
          if (/^You've hit your .*limit/i.test(text)) {
            eintraege.push({ zeit, wer: "hinweis", text: `Abo-Grenze erreicht: ${text}` });
            continue;
          }
          kuro(zeit, text);
        }
      }
      continue;
    }

    for (const b of bloecke) {
      if (b.type === "tool_result") {
        const aufruf = aufrufe.get(b.tool_use_id ?? "");
        if (aufruf?.name !== "mcp__haus__beauftrage") continue;
        const text = ergebnisText(b.content).trim();
        // „… arbeitet noch daran" ist keine Auskunft; der Bericht kommt später als Nachtrag.
        if (!text || /arbeitet noch daran/.test(text.slice(0, 200))) continue;
        eintraege.push({ zeit, wer: "bericht", von: String(aufruf.input.wer ?? "?"), text });
        continue;
      }
      if (b.type !== "text" || !b.text?.trim()) continue;
      const kopf = KOPF.exec(b.text);
      const rumpf = kopf ? b.text.slice(kopf[0].length) : b.text;
      const nachtrag = NACHTRAG.exec(rumpf);
      if (nachtrag) {
        eintraege.push({
          zeit,
          wer: "bericht",
          von: nachtrag[1],
          text: rumpf.slice(nachtrag[0].length).trim(),
        });
        continue;
      }
      if (offeneWerkzeuge.length > 0) kuro(zeit, "");
      eintraege.push({
        zeit,
        wer: "jakob",
        ...(kopf ? { kanal: kopf[1] } : {}),
        text: rumpf.trim(),
      });
    }
  }
  if (offeneWerkzeuge.length > 0) kuro(eintraege.at(-1)?.zeit ?? "", "");
  return eintraege;
}

// ------------------------------------------------------------------------------ Tage

/** Kalendertag (JJJJ-MM-TT) und Uhrzeit in Wien. */
export function wienerZeit(iso: string, zone = ZONE): { tag: string; uhr: string; stunde: number } {
  const d = new Date(iso);
  const tag = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const uhr = new Intl.DateTimeFormat("de-DE", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return { tag, uhr, stunde: Number(uhr.slice(0, 2)) };
}

export function nachTagen(eintraege: readonly Eintrag[], zone = ZONE): Map<string, Eintrag[]> {
  const tage = new Map<string, Eintrag[]>();
  for (const e of eintraege) {
    if (!e.zeit) continue;
    const { tag } = wienerZeit(e.zeit, zone);
    const liste = tage.get(tag) ?? [];
    liste.push(e);
    tage.set(tag, liste);
  }
  return tage;
}

/** „Sonntag, 27. September 2026" — aus dem Tagesschlüssel, ohne Zeitzonen-Rutschen. */
export function tagName(tag: string): string {
  const [j, m, t] = tag.split("-").map(Number);
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(j ?? 1970, (m ?? 1) - 1, t ?? 1)));
}

const KANAL: Record<string, string> = { voice: "gesprochen", telegram: "Telegram" };

export function eintragMarkdown(e: Eintrag, zone = ZONE): string {
  const { uhr } = wienerZeit(e.zeit, zone);
  if (e.wer === "jakob") {
    const kanal = e.kanal && KANAL[e.kanal] ? ` · ${KANAL[e.kanal]}` : "";
    return `### ${uhr} · Jakob${kanal}\n\n${e.text}`;
  }
  if (e.wer === "bericht") {
    const zitat = e.text
      .split("\n")
      .map((z) => (z ? `> ${z}` : ">"))
      .join("\n");
    return `### ${uhr} · Bericht von ${e.von ?? "?"}\n\n${zitat}`;
  }
  if (e.wer === "hinweis") return `### ${uhr} · Hinweis\n\n_${e.text}_`;
  const werkzeuge = e.werkzeuge?.length ? `\n\n_${e.werkzeuge.join(" · ")}_` : "";
  return `### ${uhr} · Kuro${werkzeuge}${e.text ? `\n\n${e.text}` : ""}`;
}

export function wechselZahl(eintraege: readonly Eintrag[]): number {
  return eintraege.filter((e) => e.wer === "jakob").length;
}

export function tagesMarkdown(
  tag: string,
  eintraege: readonly Eintrag[],
  sitzung: string,
  themen?: string,
  zone = ZONE,
): string {
  const erste = eintraege[0];
  const letzte = eintraege.at(-1);
  const spanne =
    erste && letzte
      ? `${wienerZeit(erste.zeit, zone).uhr} bis ${wienerZeit(letzte.zeit, zone).uhr}`
      : "";
  const kanaele = [
    ...new Set(
      eintraege.filter((e) => e.wer === "jakob").map((e) => KANAL[e.kanal ?? ""] ?? "Web"),
    ),
  ].join(", ");
  return [
    `# Gespräch vom ${tagName(tag)}`,
    "",
    `Sitzung \`${sitzung}\` · ${wechselZahl(eintraege)} Nachrichten von Jakob · ${spanne}${kanaele ? ` · ${kanaele}` : ""}`,
    ...(themen ? ["", `**Worum es ging:** ${themen}`] : []),
    "",
    "---",
    "",
    eintraege.map((e) => eintragMarkdown(e, zone)).join("\n\n"),
    "",
  ].join("\n");
}

// ------------------------------------------------------------------------------ Übergabe

export const UEBERGABE_SYSTEM = `Du schreibst die Übergabe für Kuro, den Butler von Jakob. Kuros Gespräch wurde eben archiviert; ab jetzt beginnt er frisch und kennt vom alten nur, was hier steht. Den Wortlaut kann er im Archiv nachschlagen — die Übergabe ist, was er wissen muss, ohne zu suchen.

Schreib an Kuro in der zweiten Person, knapp und konkret, mit Zahlen, wie sie standen:
## Was offen ist
Zugesagtes, das nicht erledigt ist; Aufträge ohne Bericht; Fragen, die Jakob noch beantworten wollte.
## Was Jakob festgelegt hat
Entscheidungen, Vorlieben, Regeln aus diesem Gespräch, die weiter gelten.
## Worauf er sich beziehen könnte
Laufende Themen, je ein Satz.

Übernimm aus der vorigen Übergabe, was noch offen ist oder weiter gilt; was erledigt ist, lass weg. Erfinde nichts — was du nicht sicher aus dem Wortlaut weißt, lass weg. Leere Abschnitte lässt du aus. Höchstens 450 Wörter.

Dazu je Tag eine Zeile fürs Inhaltsverzeichnis: die Themen, kommagetrennt, höchstens zwölf Wörter.

Antworte in genau dieser Form, ohne Text davor oder danach:
<uebergabe>
## Was offen ist
…
</uebergabe>
<themen>
2026-09-27: Wetter, DAX-Analyse, Watchlist Siemens
</themen>`;

export function uebergabePrompt(wortlaut: string, vorige: string | null): string {
  const text =
    wortlaut.length > UEBERGABE_EINGABE_MAX
      ? `[… der Anfang ist gekürzt, er steht im Archiv …]\n\n${wortlaut.slice(-UEBERGABE_EINGABE_MAX)}`
      : wortlaut;
  return [
    "## Die vorige Übergabe",
    vorige?.trim() || "(keine)",
    "",
    "## Das Gespräch, das jetzt archiviert wird",
    text,
  ].join("\n");
}

/**
 * Die Antwort des Übergabe-Laufs lesen.
 *
 * Verlangt sind zwei Abschnitte in Markierungen, **kein JSON** mehr. Am 2026-09-27 scheiterte
 * das Archivieren von Hand an Position 70 der Antwort: in einem JSON-String stand ein deutsches
 * Zitat „…" mit geradem Schlusszeichen, und ein einziges unmaskiertes `"` machte die ganze
 * Übergabe unlesbar. Eine Übergabe ist Fließtext mit Zitaten; zwischen zwei Markierungen muss
 * darin nichts maskiert werden. Das alte JSON wird weiter gelesen, falls ein Modell es doch
 * schickt.
 */
export function leseUebergabe(antwort: string): {
  uebergabe: string;
  themen: Record<string, string>;
} {
  const markiert = /<uebergabe>([\s\S]*?)(?:<\/uebergabe>|<themen>|$)/i.exec(antwort);
  let uebergabe = "";
  const themen: Record<string, string> = {};
  const nimmThema = (tag: string, t: unknown): void => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(tag) && typeof t === "string" && t.trim())
      themen[tag] = kuerze(t.trim(), 140);
  };
  if (markiert) {
    uebergabe = (markiert[1] ?? "").trim();
    const block = /<themen>([\s\S]*?)(?:<\/themen>|$)/i.exec(antwort)?.[1] ?? "";
    for (const zeile of block.split("\n")) {
      const m = /^\s*[-*]?\s*(\d{4}-\d{2}-\d{2})\s*[:|–-]\s*(.+)$/.exec(zeile);
      if (m) nimmThema(m[1] as string, m[2]);
    }
  } else {
    const anfang = antwort.indexOf("{");
    const ende = antwort.lastIndexOf("}");
    if (anfang < 0 || ende <= anfang) throw new Error("Die Übergabe kam ohne ihre Markierungen.");
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(antwort.slice(anfang, ende + 1)) as Record<string, unknown>;
    } catch {
      throw new Error("Die Übergabe kam als kaputtes JSON statt in ihren Markierungen.");
    }
    uebergabe = typeof o.uebergabe === "string" ? o.uebergabe.trim() : "";
    if (o.themen && typeof o.themen === "object") {
      for (const [tag, t] of Object.entries(o.themen as Record<string, unknown>)) nimmThema(tag, t);
    }
  }
  if (uebergabe.length < 20) throw new Error("Die Übergabe ist leer.");
  return { uebergabe, themen };
}

// ------------------------------------------------------------------------------ Suchen

export interface Fund {
  datei: string;
  tag: string;
  kopf: string;
  auszug: string;
}

/**
 * Suchen im Archiv: jede Wortmeldung ist ein Abschnitt, gefunden wird, wo **alle** Wörter
 * vorkommen. Neueste zuerst — wer „neulich" sagt, meint selten den ersten Tag.
 */
export function sucheImArchiv(
  dateien: readonly { pfad: string; inhalt: string }[],
  suche: string,
  hoechstens = 6,
): Fund[] {
  const woerter = suche
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (woerter.length === 0) return [];
  const funde: Fund[] = [];
  const sortiert = [...dateien].sort((a, b) => b.pfad.localeCompare(a.pfad));
  for (const { pfad, inhalt } of sortiert) {
    const tag = /(\d{4}-\d{2}-\d{2})\.md$/.exec(pfad)?.[1] ?? "";
    const abschnitte = inhalt
      .split(/\n(?=### \d\d:\d\d · )/)
      .slice(1)
      .reverse();
    for (const a of abschnitte) {
      const klein = a.toLowerCase();
      if (!woerter.every((w) => klein.includes(w))) continue;
      const kopf = a.split("\n")[0]?.replace(/^### /, "") ?? "";
      const rumpf = a.slice(a.indexOf("\n") + 1);
      const stelle = Math.max(0, rumpf.toLowerCase().indexOf(woerter[0] as string));
      const von = Math.max(0, stelle - 160);
      const auszug = `${von > 0 ? "…" : ""}${kuerze(rumpf.slice(von, stelle + 240), 400)}`;
      funde.push({ datei: pfad, tag, kopf, auszug });
      if (funde.length >= hoechstens) return funde;
    }
  }
  return funde;
}

// ------------------------------------------------------------------------------ Wann

/**
 * Ist jetzt Zeit zu archivieren? Nachts im Fenster, und nur eine Sitzung, die vor dem heutigen
 * Tag begann — wer um halb vier noch spricht, wird um vier nicht aus dem Gespräch gerissen.
 */
export function istArchivZeit(jetzt: Date, sitzungSeit: string, zone = ZONE): boolean {
  const heute = wienerZeit(jetzt.toISOString(), zone);
  if (heute.stunde < ARCHIV_FENSTER[0] || heute.stunde >= ARCHIV_FENSTER[1]) return false;
  return wienerZeit(sitzungSeit, zone).tag < heute.tag;
}

// ------------------------------------------------------------------------------ Die Ablage

export interface TagImArchiv {
  tag: string;
  datei: string;
  nachrichten: number;
  themen?: string;
  sitzungen: string[];
}

interface Verzeichnis {
  tage: Record<string, TagImArchiv>;
  sitzungen: Record<string, { archiviert: string; anlass: string; tage: string[] }>;
}

export interface ArchivErgebnis {
  sitzung: string;
  tage: string[];
  nachrichten: number;
}

export interface GespraecheDeps {
  workdir: string;
  schreibe(system: string, prompt: string): Promise<string>;
  jetzt?(): Date;
}

export interface Gespraechsarchiv {
  /**
   * Eine Sitzung ablegen. Schreibt erst, wenn die Übergabe steht; wirft sonst, und nichts ist
   * verändert. `aktuell: false` für eine alte Sitzung, deren Übergabe schon geschrieben ist.
   */
  archiviere(
    sitzung: string,
    datei: string,
    anlass: string,
    aktuell?: boolean,
  ): Promise<ArchivErgebnis>;
  /** Der Abschnitt für Kuros Systemprompt, leer ohne Übergabe. */
  uebergabeAbschnitt(): Promise<string>;
  suche(text: string, hoechstens?: number): Promise<Fund[]>;
  tage(): Promise<TagImArchiv[]>;
}

export function createGespraechsarchiv(deps: GespraecheDeps): Gespraechsarchiv {
  const wurzel = path.join(deps.workdir, "ablage", "gespraeche");
  const verzeichnisDatei = path.join(wurzel, "verzeichnis.json");
  const uebergabeDatei = path.join(deps.workdir, "notizen", "uebergabe.md");
  const jetzt = deps.jetzt ?? (() => new Date());

  async function lies(datei: string): Promise<string | null> {
    try {
      return await readFile(datei, "utf8");
    } catch {
      return null;
    }
  }

  async function verzeichnis(): Promise<Verzeichnis> {
    const roh = await lies(verzeichnisDatei);
    if (!roh) return { tage: {}, sitzungen: {} };
    try {
      return JSON.parse(roh) as Verzeichnis;
    } catch {
      return { tage: {}, sitzungen: {} };
    }
  }

  function inhaltsverzeichnis(v: Verzeichnis): string {
    const zeilen = Object.values(v.tage)
      .sort((a, b) => b.tag.localeCompare(a.tag))
      .map((t) => `| [${tagName(t.tag)}](${t.datei}) | ${t.nachrichten} | ${t.themen ?? "—"} |`);
    return [
      "# Kuros Gespräche mit Jakob",
      "",
      "Jeder Tag eine Datei, im Wortlaut, neueste zuerst. Suchen geht mit `im_archiv_suchen`;",
      "die Übergaben an die jeweils nächste Unterhaltung liegen unter `uebergaben/`.",
      "",
      "| Tag | Nachrichten | Worum es ging |",
      "|---|---|---|",
      ...zeilen,
      "",
    ].join("\n");
  }

  async function alleDateien(): Promise<{ pfad: string; inhalt: string }[]> {
    const funde: { pfad: string; inhalt: string }[] = [];
    let jahre: string[] = [];
    try {
      jahre = (await readdir(wurzel)).filter((n) => /^\d{4}$/.test(n));
    } catch {
      return [];
    }
    for (const jahr of jahre) {
      for (const name of await readdir(path.join(wurzel, jahr))) {
        if (!name.endsWith(".md")) continue;
        const inhalt = await lies(path.join(wurzel, jahr, name));
        if (inhalt) funde.push({ pfad: `ablage/gespraeche/${jahr}/${name}`, inhalt });
      }
    }
    return funde;
  }

  return {
    async archiviere(sitzung, datei, anlass, aktuell = true) {
      const roh = await readFile(datei, "utf8");
      const tage = nachTagen(leseVerlauf(roh));
      if (tage.size === 0) throw new Error("Die Sitzung enthält kein Gespräch.");

      // Erst alles im Speicher, dann die Übergabe — geschrieben wird nur, wenn beides steht.
      const wortlaut = [...tage.entries()]
        .map(([tag, e]) => tagesMarkdown(tag, e, sitzung))
        .join("\n\n");
      const vorige = await lies(uebergabeDatei);
      const { uebergabe, themen } = leseUebergabe(
        await deps.schreibe(UEBERGABE_SYSTEM, uebergabePrompt(wortlaut, aktuell ? vorige : null)),
      );

      const v = await verzeichnis();
      let nachrichten = 0;
      for (const [tag, eintraege] of tage) {
        const jahr = tag.slice(0, 4);
        const relativ = `${jahr}/${tag}.md`;
        await mkdir(path.join(wurzel, jahr), { recursive: true });
        const ziel = path.join(wurzel, relativ);
        const vorhanden = await lies(ziel);
        const alt = v.tage[tag];
        const text = vorhanden
          ? `${vorhanden.trimEnd()}\n\n---\n\n## Weiter in Sitzung \`${sitzung}\`\n\n${eintraege.map((e) => eintragMarkdown(e)).join("\n\n")}\n`
          : tagesMarkdown(tag, eintraege, sitzung, themen[tag]);
        await writeFile(ziel, text, "utf8");
        nachrichten += wechselZahl(eintraege);
        v.tage[tag] = {
          tag,
          datei: relativ,
          nachrichten: (alt?.nachrichten ?? 0) + wechselZahl(eintraege),
          themen: [alt?.themen, themen[tag]].filter(Boolean).join("; ") || undefined,
          sitzungen: [...(alt?.sitzungen ?? []), sitzung],
        };
      }
      const liste = [...tage.keys()];
      v.sitzungen[sitzung] = { archiviert: jetzt().toISOString(), anlass, tage: liste };
      await writeFile(verzeichnisDatei, JSON.stringify(v, null, 2), "utf8");
      await writeFile(path.join(wurzel, "INDEX.md"), inhaltsverzeichnis(v), "utf8");

      const letzterTag = liste.at(-1) as string;
      await mkdir(path.join(wurzel, "uebergaben"), { recursive: true });
      const kopf = `# Übergabe nach dem Gespräch bis ${tagName(letzterTag)}\n\n`;
      await writeFile(
        path.join(wurzel, "uebergaben", `${letzterTag}.md`),
        kopf + uebergabe,
        "utf8",
      );
      if (aktuell) {
        await mkdir(path.dirname(uebergabeDatei), { recursive: true });
        // Erst daneben, dann umbenennen: ein halb geschriebener Systemprompt wäre schlimmer als
        // der alte.
        await writeFile(
          `${uebergabeDatei}.neu`,
          `<!-- bis ${letzterTag} -->\n${uebergabe}\n`,
          "utf8",
        );
        await rename(`${uebergabeDatei}.neu`, uebergabeDatei);
      }
      return { sitzung, tage: liste, nachrichten };
    },

    async uebergabeAbschnitt() {
      const roh = await lies(uebergabeDatei);
      if (!roh?.trim()) return "";
      const bis = /<!-- bis (\d{4}-\d{2}-\d{2}) -->/.exec(roh)?.[1];
      return [
        "",
        "",
        "## Übergabe aus deinem letzten Gespräch",
        "",
        `Dein voriges Gespräch mit Jakob${bis ? ` (bis ${tagName(bis)})` : ""} ist archiviert. Hier steht, was davon weiter gilt. Den Wortlaut findest du mit \`im_archiv_suchen\` oder über \`ablage/gespraeche/INDEX.md\` — schau dort nach, bevor du Jakob nach etwas fragst, das ihr schon besprochen habt.`,
        "",
        roh.replace(/<!--[^>]*-->\n?/, "").trim(),
      ].join("\n");
    },

    async suche(text, hoechstens = 6) {
      return sucheImArchiv(await alleDateien(), text, hoechstens);
    },

    async tage() {
      return Object.values((await verzeichnis()).tage).sort((a, b) => b.tag.localeCompare(a.tag));
    },
  };
}

// ------------------------------------------------------------------------------ Kuros Werkzeug

export const ARCHIV_TOOL = "mcp__gedaechtnis__im_archiv_suchen";

export function createGedaechtnis(archiv: Gespraechsarchiv) {
  const suchen = tool(
    "im_archiv_suchen",
    [
      "Im Archiv deiner früheren Gespräche mit Jakob suchen — Wortlaut, nach Tagen abgelegt.",
      "Nimm das, wenn Jakob sich auf etwas bezieht, das nicht in deiner Übergabe steht, bevor du",
      "ihn danach fragst. Gefunden wird, wo alle Wörter vorkommen; du bekommst Tag, Uhrzeit,",
      "Sprecher und einen Auszug. Die ganze Stelle liest du mit Read in der genannten Datei.",
    ].join("\n"),
    {
      suche: z.string().min(2).max(120).describe("Ein bis drei Wörter, z. B. „Siemens Watchlist“."),
      hoechstens: z.number().int().min(1).max(12).optional(),
    },
    async ({ suche, hoechstens }) => {
      const funde = await archiv.suche(suche, hoechstens ?? 6);
      const text =
        funde.length === 0
          ? `Nichts gefunden für „${suche}". Mit weniger oder anderen Wörtern versuchen; das Inhaltsverzeichnis steht in ablage/gespraeche/INDEX.md.`
          : funde.map((f) => `${f.tag} ${f.kopf}\n${f.auszug}\n→ ${f.datei}`).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
    { annotations: { title: "Im Gesprächsarchiv suchen", readOnlyHint: true } },
  );
  return createSdkMcpServer({ name: "gedaechtnis", version: "1.0.0", tools: [suchen] });
}
