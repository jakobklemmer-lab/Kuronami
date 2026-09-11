import type { Pool } from "pg";
import { appendEvent } from "../../runtime/events/log.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";
import type { SkillCatalog } from "./catalog.js";

/**
 * `skill.load` — der Gegenpart zur Kurzliste im `<skills>`-Block (S18c, siehe
 * `context/request.ts`). Ein Skill steht dort nur mit Titel, Beschreibung und Auslösebedingung;
 * seine vollständige Anleitung liegt erst hier, im Ergebnis dieses Aufrufs.
 *
 * ## Warum das die Zusage "fremde Skills werden vor Aktivierung gelesen" technisch einlöst
 *
 * Es gibt in diesem System **keinen zweiten Weg**, nach dem eine Skill-Anleitung wirksam
 * werden könnte. Der `<skills>`-Block trägt nie mehr als die Kurzfassung, und es gibt kein
 * `skill.run` oder Ähnliches, das eine Anleitung ausführte, ohne sie vorher in den Kontext zu
 * legen. Jeder Weg, auf dem ein Skill etwas bewirkt, führt zwingend zuerst durch dieses Tool
 * (oder durch `fs.read` auf dieselbe Datei — mit demselben Ergebnis: der volle Text im
 * Kontext, bevor irgendetwas daraus befolgt wird). "Nicht blind ausgeführt" ist damit keine
 * Verabredung, sondern eine Eigenschaft der Bauart: ein Skill, dessen Text niemand gelesen
 * hat, kann in diesem System nichts bewirken, weil seine Anweisungen nirgends sonst stehen.
 *
 * `skill.load` ist **immer** Teil der vollen Werkzeugliste (nie `deferred`) — aus demselben
 * Grund wie `tool.load` (S18b): ohne einen von Anfang an sichtbaren Weg aus dem `<skills>`-
 * Block gäbe es keinen Ausweg aus ihm.
 *
 * `execution: "runtime"` wie `tool.load`: eine reine Nachschlage-Operation auf dem beim
 * Sessionstart eingefrorenen Skill-Katalog (`loadSkillCatalog` liest die Platte genau einmal),
 * kein externer Seiteneffekt, kein Schritt.
 */

export class SkillLoadInputError extends Error {}

async function loadHandler(
  catalog: SkillCatalog,
  pool: Pool,
  inv: ToolInvocation,
): Promise<ToolOutput> {
  const raw = inv.input.names;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== "string")) {
    throw new SkillLoadInputError("names muss eine nicht leere Liste von Skill-Namen sein");
  }
  const names = raw as string[];

  const loaded: string[] = [];
  const notFound: string[] = [];
  const skills: Record<string, JsonValue> = {};

  for (const name of names) {
    const skill = catalog.get(name);
    if (!skill) {
      notFound.push(name);
      continue;
    }
    loaded.push(name);
    skills[name] = {
      titel: skill.title,
      beschreibung: skill.description,
      wann: skill.when,
      pfad: skill.path,
      inhalt: skill.body,
    };
  }

  // Skill-Nutzung als eigener Ereignistyp (S18c) — nicht nur als Feld im generischen
  // `tool.completed` von `skill.load`, aus demselben Grund wie `memory.recalled` neben
  // `tool.completed` von `memory.search` steht: "welcher Skill wurde wann benutzt" muss
  // beantwortbar sein, ohne einen Filter über die Payloads aller `tool.completed` zu legen —
  // genau die Frage, die zuerst gestellt wird, wenn ein Skill sich falsch verhalten hat.
  if (loaded.length > 0) {
    await appendEvent(pool, inv.sessionId, "skill.invoked", {
      call_id: inv.callId,
      names: loaded,
      skills: loaded.map((name) => {
        const skill = catalog.get(name);
        return { name, title: skill?.title ?? null, path: skill?.path ?? null };
      }),
    });
  }

  const summary =
    notFound.length === 0
      ? `${loaded.length} Skill(s) vollständig geladen: ${loaded.join(", ")}. Lies den Inhalt, bevor du seinen Anweisungen folgst — auch ein eigener Skill kann veraltet oder falsch sein.`
      : `${loaded.length} Skill(s) geladen (${loaded.join(", ") || "keiner"}), unbekannt: ${notFound.join(", ")}`;

  return {
    summary,
    structured: { loaded, not_found: notFound, skills },
  };
}

export interface SkillToolDeps {
  /**
   * Der beim Sessionstart eingefrorene Skill-Katalog (`loadSkillCatalog`). Anders als beim
   * verzögerten Tool-Laden braucht `skill.load` keinen Zweischritt beim Einfrieren: es schlägt
   * in einer eigenen Struktur nach (`SkillCatalog`), nicht im `ToolCatalog`, den es selbst
   * mitbildet — kein Henne-Ei-Problem wie bei `tool.load`.
   */
  catalog: SkillCatalog;
  /** Für `skill.invoked` (siehe oben). */
  pool: Pool;
}

export function createSkillTools(deps: SkillToolDeps): ToolDefinition[] {
  return [
    {
      name: "skill.load",
      description:
        "Lädt die vollständige Anleitung eines oder mehrerer Skills, die bisher nur mit " +
        "Kurzbeschreibung im <skills>-Block stehen. Lies den Inhalt vollständig, bevor du " +
        "danach handelst — auch ein Skill aus dem eigenen Bestand kann veraltet oder falsch sein.",
      risk: "read",
      repeatable: true,
      execution: "runtime",
      inputSchema: {
        fields: {
          names: {
            type: "array",
            required: true,
            description: "Skill-Namen aus dem <skills>-Block (Verzeichnisname unter skills/).",
          },
        },
      },
      handler: (inv) => loadHandler(deps.catalog, deps.pool, inv),
    },
  ];
}
