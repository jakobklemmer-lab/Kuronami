import { redactText } from "../../runtime/redaction/redact.js";
import type { ToolCatalog } from "../types.js";

/**
 * Der Entwurf eines Agentenprofils (S19): aus einem Satz des Nutzers wird ein JSON-Profil.
 *
 * Das ist der Teil von `agent.create`, den **das Modell** tut, und er ist bewusst eng
 * geschnitten: der Prompt gibt die Felder vor, zählt die tatsächlich vorhandenen Werkzeuge
 * samt Risikostufe auf und verlangt JSON und sonst nichts. Was danach kommt — Prüfung
 * (`checkAgentDraft`), Bestätigung durch den Nutzer, Eintrag — passiert ohne das Modell.
 *
 * Dieselbe Arbeitsteilung wie bei der Zusammenfassung ins Langzeitgedächtnis (S18,
 * `tools/memory/summary.ts`): das Modell formuliert, die Runtime entscheidet und schreibt.
 */

/** Die Antwort des Modells ist kein verwertbares JSON-Profil. */
export class AgentDraftParseError extends Error {}

export interface DraftPromptInput {
  /** Der Auftrag des Nutzers, wörtlich. */
  request: string;
  /** Der Katalog dieses Prozesses — daraus wählt das Profil seine Werkzeuge. */
  catalog: ToolCatalog;
  /** Tools, die ein Agent nie bekommt (siehe `DraftCheck.forbiddenTools`). */
  forbiddenTools?: readonly string[];
  /** Die Modellnamen, zwischen denen gewählt werden kann (Abschnitt 11). */
  models: { routine: string; thinking: string };
}

/**
 * Der Prompt. Kurz, mit einer vollständigen Werkzeugliste und einer ausdrücklichen Warnung vor
 * der Stelle, an der ein Entwurf typischerweise zu großzügig wird: der Risiko-Obergrenze.
 *
 * Die Liste nennt zu jedem Tool seine Risikostufe, weil die Obergrenze sonst geraten würde —
 * und eine geratene Stufe sieht aus wie eine entschiedene (AGENTS.md).
 */
export function buildAgentDraftPrompt(input: DraftPromptInput): string {
  const forbidden = new Set(input.forbiddenTools ?? []);
  const tools = input.catalog.tools
    .filter((tool) => !forbidden.has(tool.name))
    .map((tool) => `- ${tool.name} (${tool.risk}): ${tool.description.split("\n")[0]}`);

  return [
    "Du entwirfst das Profil eines Subagenten für Kuronami. Der Nutzer hat gesagt:",
    "",
    redactText(input.request.trim()),
    "",
    "Antworte mit **einem** JSON-Objekt und sonst nichts — kein Vorwort, keine Erklärung,",
    "keine Code-Auszeichnung. Felder:",
    "",
    '  "name"          Kurzname, kleingeschrieben, Bindestriche als Trenner (z. B. "mail-waechter").',
    '  "role"          Die Rolle in einem Wort oder zweien (z. B. "Mail-Agent").',
    '  "purpose"       Ein Satz: wofür es diesen Agenten gibt.',
    '  "system_prompt" Die stehende Anweisung an den Agenten. Was er tut, woran er sich hält,',
    "                  wann er sich meldet und wann nicht. Zweiter Person, knapp.",
    `  "model"         "${input.models.routine}" für Routine (nachsehen, sortieren, melden) oder`,
    `                  "${input.models.thinking}" für Denkarbeit (planen, schreiben, entscheiden).`,
    '  "tools"         Liste der Werkzeugnamen, die er braucht — **nur die**, nichts auf Vorrat.',
    '  "max_risk"      "read", "soft_write", "hard_write" oder "destructive": die höchste Stufe,',
    "                  die dieser Agent je erreichen darf. Sie muss mindestens so hoch sein wie",
    "                  das schärfste Werkzeug in der Liste — und keinen Schritt höher.",
    '  "max_steps"     Werkzeugaufrufe je Lauf, 1 bis 200. Ein enger Auftrag braucht selten mehr als 15.',
    '  "schedule"      Cron-Ausdruck mit fünf Feldern (m h dom mon dow), wenn der Nutzer einen',
    '                  Rhythmus genannt hat ("alle 20 Minuten" → "*/20 * * * *"), sonst null.',
    "",
    "Zur Risiko-Obergrenze: sie ist keine Vermutung über das, was gebraucht werden könnte,",
    "sondern eine stehende Erlaubnis für jeden künftigen Lauf dieses Agenten — auch für die,",
    "die nach Zeitplan laufen, während niemand zusieht. Im Zweifel die niedrigere Stufe.",
    "",
    "Verfügbare Werkzeuge (Name, Risikostufe, Zweck):",
    ...tools,
  ].join("\n");
}

/**
 * Zieht das JSON-Objekt aus der Antwort. Toleriert eine Code-Auszeichnung und Text davor oder
 * danach — aber **nicht** stillschweigend: was nicht als Objekt lesbar ist, wirft mit dem
 * Wortlaut der Antwort im Fehlertext (AGENTS.md: Fehler nie verstecken oder glätten).
 */
export function parseAgentDraft(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new AgentDraftParseError(
      `Der Entwurf enthält kein JSON-Objekt. Antwort war: ${trimmed.slice(0, 400)}`,
    );
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    throw new AgentDraftParseError(
      `Der Entwurf ist kein gültiges JSON (${error instanceof Error ? error.message : String(error)}). Antwort war: ${trimmed.slice(0, 400)}`,
    );
  }
}
