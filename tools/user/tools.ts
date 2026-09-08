import type { Pool } from "pg";
import type { AskOption } from "../../runtime/session/state.js";
import { UserInputRequiredError, askUserInput } from "../../runtime/session/user-input.js";
import type { JsonValue } from "../../runtime/steps/types.js";
import type { ToolDefinition, ToolInvocation, ToolOutput } from "../types.js";

/**
 * `user.ask` (Abschnitt 9, Abschnitt 10) — der synchrone Haltepunkt mit **strukturierten**
 * Optionen, kein Fließtext, auf dessen Parsbarkeit man hofft.
 *
 * `execution: "runtime"`: kein Schritt, keine Ausführungshülle. Der Mechanismus steckt in
 * `runtime/session/user-input.ts`:
 *
 *   * offene Rückfrage → der Handler wirft `UserInputRequiredError`, den der Router
 *     durchlässt (wie `ToolCatalogMismatchError`); der Lauf hält an, die Session steht auf
 *     `awaiting_user`;
 *   * beantwortete Rückfrage → der Handler gibt die Antwort als Tool-Hülle zurück und der
 *     Lauf geht weiter. Der stabile Schlüssel ist `ask:<call_id>` — ein wiederaufnehmender
 *     Lauf leitet dieselbe `call_id` aus seinem Plan wieder her und trifft damit dieselbe
 *     Frage.
 */

/** Die Optionen sind unbrauchbar (leer, zu wenige, ohne id/label, doppelte id). */
export class UserAskInputError extends Error {}

const OPTION_KEYS = new Set(["id", "label"]);
const MIN_OPTIONS = 2;

function parseOptions(raw: JsonValue | undefined): AskOption[] {
  if (!Array.isArray(raw)) {
    throw new UserAskInputError("options muss eine Liste sein");
  }
  if (raw.length < MIN_OPTIONS) {
    throw new UserAskInputError(
      `options braucht mindestens ${MIN_OPTIONS} Einträge (eine Rückfrage mit einer Option ist keine Wahl)`,
    );
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UserAskInputError(`options[${index}] muss ein Objekt { id, label } sein`);
    }
    for (const key of Object.keys(entry)) {
      if (!OPTION_KEYS.has(key)) {
        throw new UserAskInputError(
          `options[${index}]: unbekanntes Feld "${key}" (erlaubt: id, label)`,
        );
      }
    }
    const id = entry.id;
    const label = entry.label;
    if (typeof id !== "string" || id.trim() === "") {
      throw new UserAskInputError(`options[${index}].id muss eine nicht leere Zeichenkette sein`);
    }
    if (typeof label !== "string" || label.trim() === "") {
      throw new UserAskInputError(
        `options[${index}].label muss eine nicht leere Zeichenkette sein`,
      );
    }
    if (seen.has(id)) {
      throw new UserAskInputError(`options: id "${id}" kommt mehrfach vor`);
    }
    seen.add(id);
    return { id, label };
  });
}

async function askHandler(pool: Pool, inv: ToolInvocation): Promise<ToolOutput> {
  const question = inv.input.question;
  if (typeof question !== "string" || question.trim() === "") {
    throw new UserAskInputError("question muss eine nicht leere Zeichenkette sein");
  }
  const options = parseOptions(inv.input.options);
  const askId = `ask:${inv.callId}`;

  const resolution = await askUserInput(pool, inv.sessionId, { askId, question, options });

  if (resolution.status === "pending") {
    // Der Router lässt das durch: der Lauf hält an, er ist nicht fehlgeschlagen.
    throw new UserInputRequiredError(askId, question, options);
  }

  if (resolution.status === "answered") {
    return {
      summary: `Antwort auf „${question}“: ${resolution.choiceLabel}`,
      structured: {
        ask_id: askId,
        answered: true,
        choice: resolution.choice,
        choice_label: resolution.choiceLabel,
        decided_at: resolution.decidedAt.toISOString(),
      },
      preview: [resolution.choiceLabel],
    };
  }

  return {
    summary: `„${question}“ wurde ohne Antwort abgewiesen${
      resolution.reason ? `: ${resolution.reason}` : ""
    }`,
    structured: {
      ask_id: askId,
      answered: false,
      dismissed: true,
      reason: resolution.reason,
      decided_at: resolution.decidedAt.toISOString(),
    },
    preview: [],
  };
}

export interface UserToolDeps {
  pool: Pool;
}

/** Baut die `user.*`-Definitionen mit dem Pool in den Handlern geschlossen. */
export function createUserTools(deps: UserToolDeps): ToolDefinition[] {
  return [
    {
      name: "user.ask",
      description:
        "Stellt dem Nutzer eine Frage mit einer festen Liste strukturierter Optionen und hält den Lauf an, bis eine Option gewählt ist (Session-Status awaiting_user). Die Antwort setzt den Lauf an derselben Stelle fort. Kein Freitext — nur die angebotenen Optionen.",
      risk: "read",
      repeatable: true,
      execution: "runtime",
      inputSchema: {
        fields: {
          question: {
            type: "string",
            required: true,
            description: "Die Frage an den Nutzer, knapp und entscheidbar.",
          },
          options: {
            type: "array",
            required: true,
            description:
              "Mindestens zwei Einträge { id, label }. id ist stabil und maschinenlesbar, label ist der angezeigte Text.",
          },
        },
      },
      handler: (inv) => askHandler(deps.pool, inv),
    },
  ];
}
