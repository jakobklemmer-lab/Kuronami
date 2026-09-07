import { redactText, redactValue } from "../runtime/redaction/redact.js";

/**
 * Der Prompt-Aufbau aus Abschnitt 7, in der dort festgelegten Reihenfolge.
 *
 * Bewusst klein gehalten. Diese Datei entsteht als dritter Schreibpfad des
 * Redaction-Filters — was Text in den Modellkontext bringt, muss durch denselben Filter wie
 * das Protokoll und die Artefaktmetadaten (Abschnitt 4.7: "nie den Prompt, nie ein
 * Artefakt, nie das Ereignisprotokoll"). Prompt-Caching, Kompaktierung (Stufen 2 bis 4) und
 * das Umschreiben alter Tool-Ergebnisse in Referenzen sind hier ausdrücklich **nicht**
 * gebaut; sie gehören nach S09 und S12. Was hier steht, ist die Reihenfolge, das eine
 * Filtertor und die Grenze zwischen stabilem Präfix und veränderlichem Rest.
 */

/**
 * Die fünf Abschnitte aus Abschnitt 7, in bindender Reihenfolge. Sie ist keine Geschmacks-
 * frage: die Cache-Hierarchie läuft von Tools über System-Prompt zu Nachrichten, und eine
 * Änderung weiter oben entwertet alles darunter.
 */
export const PROMPT_SECTION_ORDER = [
  "system",
  "memory",
  "session_state",
  "recent",
  "user_input",
] as const;

export type PromptSectionId = (typeof PROMPT_SECTION_ORDER)[number];

/**
 * Die ersten beiden Abschnitte ändern sich innerhalb einer Session nicht. Alles danach
 * ändert sich mit jedem Zug. Genau an dieser Kante liegt der Cache-Präfix.
 */
const CACHEABLE_SECTIONS: ReadonlySet<PromptSectionId> = new Set(["system", "memory"]);

/** Ein Tool, wie es im immer vorhandenen Stub-Block erscheint. */
export interface ToolStub {
  name: string;
  description: string;
  risk: string;
}

export interface PromptTurn {
  role: "user" | "assistant" | "tool";
  /** Text oder ein strukturiertes Tool-Ergebnis. Beides läuft durch den Filter. */
  content: unknown;
}

export interface PromptInput {
  /** Abschnitt 7.1, statischer Teil. */
  systemPrompt: string;
  /**
   * Abschnitt 7.1, Tool-Stubs. Werden nach Namen sortiert, damit die Serialisierung nicht
   * an der Aufrufreihenfolge hängt — schon eine Umsortierung bricht den Cache.
   */
  toolStubs?: readonly ToolStub[];
  /** Abschnitt 7.2: Personengedächtnis und dauerhafte Konventionen. */
  memory?: readonly string[];
  /** Abschnitt 7.3: Zusammenfassung des Sessionzustands. */
  sessionSummary?: string;
  /** Abschnitt 7.4: letzte Nachrichten und Tool-Ergebnisse. */
  recent?: readonly PromptTurn[];
  /** Abschnitt 7.5. */
  userInput: string;
}

export interface PromptSection {
  id: PromptSectionId;
  /** Gehört dieser Abschnitt zum stabilen Präfix? */
  cacheable: boolean;
  /** Bereits gefiltert. Es gibt keine ungefilterte Fassung dieses Feldes. */
  text: string;
}

export interface BuiltPrompt {
  sections: PromptSection[];
  /**
   * Der stabile Präfix. Bleibt er über die Züge einer Session byteweise gleich, trägt das
   * Prompt-Caching; ändert er sich, ist alles darunter entwertet (Abschnitt 7).
   */
  cachePrefix: string;
  text: string;
}

/**
 * Das einzige Tor dieses Moduls. Jeder Abschnittstext entsteht hier und nirgends sonst,
 * deshalb kann keiner am Filter vorbei entstehen.
 *
 * Strukturierte Inhalte werden **vor** dem Serialisieren gefiltert, nicht danach. Im
 * fertigen JSON steht `"api_key": "hunter2"` — der Feldname ist dort von seinem Wert durch
 * ein Anführungszeichen getrennt, und ein Textmuster sähe kein Schlüssel-Wert-Paar mehr.
 * Über den Baum gefiltert greift die Namensregel; über den Text gefiltert nicht.
 */
function render(value: unknown): string {
  if (typeof value === "string") return redactText(value);
  return JSON.stringify(redactValue(value), null, 2) ?? "";
}

function section(id: PromptSectionId, body: string): PromptSection {
  return {
    id,
    cacheable: CACHEABLE_SECTIONS.has(id),
    text: `<${id}>\n${body}\n</${id}>`,
  };
}

function renderStubs(stubs: readonly ToolStub[]): string {
  return [...stubs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((stub) => render(`- ${stub.name} (${stub.risk}): ${stub.description}`))
    .join("\n");
}

function renderTurns(turns: readonly PromptTurn[]): string {
  return turns.map((turn) => `[${render(turn.role)}] ${render(turn.content)}`).join("\n");
}

/**
 * Setzt den Prompt zusammen.
 *
 * Alle fünf Abschnitte stehen immer da, auch die leeren. Ein Abschnitt, der mal fehlt und
 * mal auftaucht, verschöbe den Text darunter und entwertete bei jedem Auftauchen den Cache —
 * die zwei gesparten Zeilen wären mit einem verlorenen Präfix bezahlt.
 */
export function buildPrompt(input: PromptInput): BuiltPrompt {
  const sections: PromptSection[] = [
    section(
      "system",
      [
        render(input.systemPrompt),
        "",
        "<tools>",
        renderStubs(input.toolStubs ?? []),
        "</tools>",
      ].join("\n"),
    ),
    section("memory", (input.memory ?? []).map((note) => render(note)).join("\n")),
    section("session_state", render(input.sessionSummary ?? "")),
    section("recent", renderTurns(input.recent ?? [])),
    section("user_input", render(input.userInput)),
  ];

  const byOrder = PROMPT_SECTION_ORDER.map((id) => {
    const found = sections.find((entry) => entry.id === id);
    if (!found) throw new Error(`Prompt-Abschnitt "${id}" fehlt`);
    return found;
  });

  return {
    sections: byOrder,
    cachePrefix: byOrder
      .filter((entry) => entry.cacheable)
      .map((entry) => entry.text)
      .join("\n\n"),
    text: byOrder.map((entry) => entry.text).join("\n\n"),
  };
}
