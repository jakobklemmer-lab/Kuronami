import type { PolicyGrant } from "../policy/engine.js";
import type { RiskLevel } from "../policy/risk.js";
import type { JsonValue } from "../runtime/steps/types.js";

/**
 * Was ein Tool ist und was es zurückgibt — unabhängig davon, wer es registriert (Registry)
 * und wer es aufruft (Router). Beide Seiten hängen an diesen Typen, keine an der anderen.
 */

/**
 * Erlaubte Namensräume (Abschnitt 4.8). `dev` ist seit S07 dabei und in Abschnitt 4.8 der
 * Architektur begründet: Prüf-Tools des Harness, die nie in einem echten Tool-Katalog
 * stehen. Ein neuer Namensraum braucht eine Begründung in `docs/` (AGENTS.md).
 *
 * `memory` ist seit S18 dabei, begründet in `docs/GEDAECHTNIS.md`. Kurz: `notes.*` greift seit
 * S15 auf den **Obsidian-Vault des Nutzers** zu (fremdes Gebiet, `hard_write`, jede Änderung
 * mit Freigabe), `memory.*` auf das **Langzeitgedächtnis des Assistenten** (eigene Ablage,
 * `soft_write`, eigenes Git-Repo). Zwei Ablagen mit verschiedenen Eigentümern, verschiedenen
 * Risikostufen und verschiedenen Zonen — sie in einem Namensraum zu führen hieße, den
 * Speicherort davon abhängig zu machen, welches Feld das Modell gerade füllt.
 *
 * `tool` ist seit S18b dabei: das verzögerte Tool-Laden (Abschnitt 9, "Kurzbeschreibung aller
 * Tools, volles Schema erst bei tatsächlicher Nutzung nachgeladen") braucht ein Tool, das über
 * den Katalog selbst spricht (`tool.load`) — kein `fs.*`, `web.*` oder irgendein anderer
 * bestehender Namensraum meint das Gebiet "den eigenen Werkzeugkasten nachschlagen".
 *
 * `skill` ist seit S18c dabei: das Skill-System (progressive Offenlegung, `skills/<name>/
 * SKILL.md`) braucht ein Tool, das über den **Skill-Katalog** spricht (`skill.load`) — ein
 * eigenes Gebiet neben `tool` (das über den *Tool*-Katalog spricht) und neben `memory` (das
 * eigene Ablage des Assistenten ist, keine bereitgestellten Fähigkeiten Dritter).
 */
export const TOOL_NAMESPACES = [
  "fs",
  "web",
  "exec",
  "task",
  "user",
  "agent",
  "mail",
  "cal",
  "notes",
  "memory",
  "github",
  "server",
  "dev",
  "tool",
  "skill",
] as const;

export type ToolNamespace = (typeof TOOL_NAMESPACES)[number];

/**
 * Risikostufen aus Abschnitt 10. Sie sind mit S11 nach `policy/risk.ts` gewandert, wo
 * `policy/README.md` sie ohnehin verortet, und werden hier weiter re-exportiert: eine
 * Tool-Definition soll ihre Stufe angeben können, ohne die Governance-Schicht zu kennen. Die
 * Abhängigkeitsrichtung ist damit `tools → policy`, wie Abschnitt 4.7 sie vorgibt.
 */
export type { RiskLevel };

export type ToolFieldType = "string" | "number" | "boolean" | "object" | "array";

export interface ToolField {
  type: ToolFieldType;
  required: boolean;
  /** Geht so in den Tool-Katalog des Modells. Kein Kommentar, sondern Teil des Vertrags. */
  description: string;
}

/**
 * Bewusst winzig und ohne Bibliothek. Ein vollständiges JSON-Schema samt Validator wäre eine
 * neue Abhängigkeit für einen Aktionsraum, der laut Grundprinzip 4 klein und stabil bleibt;
 * was hier fehlt (verschachtelte Schemata, Aufzählungen, Wertebereiche), fehlt sichtbar und
 * lässt sich nachrüsten, wenn ein echtes Tool es braucht.
 */
export interface ToolInputSchema {
  fields: Record<string, ToolField>;
}

/**
 * Die einheitliche Rückgabehülle aus Abschnitt 9, verbindlich für **jedes** Tool. Feldnamen
 * in snake_case, weil das hier kein internes TypeScript-Objekt ist, sondern ein
 * Übertragungsformat: es geht als `result` durch jsonb, ins Ereignisprotokoll und in den
 * Modellkontext.
 */
export type ToolResult = {
  status: "ok" | "error";
  /** Kurz und für das Modell gedacht. Bei `error` der Grund, nicht die Beschönigung. */
  summary: string;
  /** Maschinenlesbares Ergebnis. Wird ausgelagert, sobald die Hülle zu groß wird. */
  structured: JsonValue;
  artifact_refs: string[];
  preview: string[];
  // Ein `type` und kein `interface`: nur ein Typalias bekommt in TypeScript die implizite
  // Indexsignatur, mit der die Hülle als `JsonValue` durchgeht. Und genau das muss sie —
  // sie ist das `result` eines Schritts und geht als jsonb durch die Datenbank.
};

/**
 * Was ein Handler zurückgibt. `status` fehlt mit Absicht: ob ein Aufruf geglückt ist,
 * entscheidet der Router an der Frage, ob der Handler zurückkam oder geworfen hat — nicht
 * das Tool über ein Feld, das es auch falsch setzen könnte.
 */
export interface ToolOutput {
  summary: string;
  structured?: JsonValue;
  artifact_refs?: string[];
  preview?: string[];
}

/** Was ein Handler über seinen eigenen Aufruf weiß. */
export interface ToolInvocation {
  readonly input: Record<string, JsonValue>;
  readonly sessionId: string;
  /** Die Aufrufkennung (S07). Ein `execution: "runtime"`-Tool leitet daraus seinen stabilen Schlüssel ab. */
  readonly callId: string;
  /**
   * Der Schritt, in dem dieser Aufruf läuft — die Herkunft eines Artefakts. `null` für ein
   * `execution: "runtime"`-Tool: das läuft ohne Ausführungshülle und ohne Schritt (siehe
   * `ToolDefinition.execution`).
   */
  readonly stepId: string | null;
  readonly attempt: number;
  /** Bricht bei Zeitüberschreitung und bei Abbruch von außen (S05). */
  readonly signal: AbortSignal;
  /**
   * Die Freigabe der Policy-Engine für genau diesen Aufruf (S11).
   *
   * Pflichtfeld, und das ist der eigentliche Punkt: `PolicyGrant` hat ein privates Feld und
   * wird nur als Typ exportiert, also lässt sich außerhalb von `policy/engine.ts` keine
   * herstellen — auch nicht als Objektliteral. Ein Handler kann damit gar nicht aufgerufen
   * werden, ohne dass die Engine entschieden hat. Abschnitt 4.7 ("Es gibt keinen Pfad, auf
   * dem ein Tool ohne Policy-Prüfung ausgeführt wird") steht so im Typsystem statt in einer
   * Verabredung, an die sich jede künftige Aufrufstelle erinnern müsste.
   *
   * Die meisten Handler lesen sie nie. `fs.write`/`fs.edit` tun es: sie prüfen, ob die Engine
   * denselben Schreibzugriff gesehen hat, den sie gleich ausführen (siehe `assertWritableZone`).
   */
  readonly policy: PolicyGrant;
}

export type ToolHandler = (invocation: ToolInvocation) => Promise<ToolOutput>;

export interface ToolDefinition {
  /** `namensraum.aktion`, kleingeschrieben, Punkt als Trenner (Abschnitt 4.8). */
  name: string;
  /** Was das Tool tut, in der Fassung, die das Modell zu lesen bekommt. */
  description: string;
  inputSchema: ToolInputSchema;
  risk: RiskLevel;
  /**
   * Darf ein unterbrochener Aufruf wiederholt werden? Pflichtfeld ohne Vorgabewert, aus
   * demselben Grund wie in `StepSpec` (S05): das ist eine Aussage über die Außenwelt, und
   * treffen kann sie nur, wer das Tool schreibt. Aus der Risikostufe abzuleiten wäre
   * naheliegend und falsch — ein `soft_write` legt beim zweiten Lauf ein zweites Artefakt an.
   *
   * Für `execution: "runtime"`-Tools ohne Belang: sie laufen ohne Schritt, es gibt keinen
   * unterbrochenen Versuch zu wiederholen.
   */
  repeatable: boolean;
  /**
   * Wie der Router diesen Aufruf ausführt. Vorgabe `"step"`: durch die Ausführungshülle aus
   * S05 — Checkpoint davor und danach, Idempotenzschlüssel, Zeitfenster, automatische
   * Auslagerung. Das ist richtig für jedes Tool mit einem **externen** Seiteneffekt.
   *
   * `"runtime"` für Tools, die nur **lokalen** Zustand ändern und ihre eigenen Ereignisse in
   * einer Transaktion schreiben — `task.set`/`task.update` (Plan in `kuronami.tasks` +
   * `task.*`) und `user.ask` (`approval.requested`). Sie brauchen keine Schritt-Idempotenz
   * (ihr Determinismus folgt aus der Form der Operation, nicht aus einem Schlüssel gegen ein
   * Wiederverschicken) und dürfen keinen Schritt stundenlang parken, während ein Mensch
   * überlegt. Der Router prüft weiter den Katalog, das Schema und schreibt
   * `tool.requested`/`tool.completed`, ruft den Handler aber direkt.
   *
   * Zählt **nicht** in den Katalog-Fingerabdruck (interne Weiche, wie der Handler-Rumpf).
   */
  execution?: "step" | "runtime";
  /**
   * Verzögertes Tool-Laden (S18b, Abschnitt 9). Vorgabe `false`: das volle Eingabeschema steht
   * von Anfang an in der Werkzeugliste der Anfrage, wie bei jedem Tool seit S07.
   *
   * `true` markiert ein Tool als **Assistenz-Tool** im Sinn von Abschnitt 9 (`mail.*`, `cal.*`,
   * `memory.*`, `server.*`, generische n8n-Workflows — alles, was nicht zu den Kern-Primitiven
   * zählt): sein volles Schema steht erst in der Werkzeugliste, nachdem `tool.load` es für
   * diese Session nachgeladen hat (`context/request.ts`, `deriveLoadedToolNames`). Bis dahin
   * sieht der Prompt nur Name und Kurzbeschreibung, im `<deferred_tools>`-Block neben den
   * Konventionen. Der **Katalog** kennt das Tool die ganze Zeit — der Router prüft und führt es
   * unverändert aus, ob geladen oder nicht (Abschnitt 4.7 kennt keine Ausnahme dafür); betroffen
   * ist nur, was in der an den Anbieter gesendeten `tools`-Liste steht.
   *
   * Zählt **nicht** in den Katalog-Fingerabdruck (`fingerprintTools`) — dieselbe Begründung wie
   * bei `execution`: eine Stellgröße für die Prompt-Ökonomie ist kein Teil des Vertrags, den das
   * Modell mit seinen Aufrufen eingeht, und soll keine laufende Session ungültig machen können.
   */
  deferred?: boolean;
  handler: ToolHandler;
}

/** Ein Tool, wie es im Prompt-Katalog erscheint. Deckt sich mit `ToolStub` in `context/`. */
export interface ToolStub {
  name: string;
  description: string;
  risk: RiskLevel;
}

/**
 * Der eingefrorene Katalog einer Session. Es gibt keinen Weg, ihm nachträglich ein Tool
 * hinzuzufügen: `ToolRegistry.freeze()` gibt diese Sicht zurück, und sie hat keine
 * schreibende Methode. Den Toolsatz mitten in der Session umzubauen ist Anti-Muster 2 und
 * entwertet nach Abschnitt 7 den gesamten Cache darunter.
 */
export interface ToolCatalog {
  /** Aus dem Inhalt abgeleitet, siehe `registry.ts`. */
  readonly version: string;
  /** Nach Namen sortiert, damit die Serialisierung nicht an der Registrierreihenfolge hängt. */
  readonly tools: readonly ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  stubs(): ToolStub[];
}
