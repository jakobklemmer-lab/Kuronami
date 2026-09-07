import { SECRET_PATTERNS, isSecretFieldName, redactionMarker } from "./patterns.js";

/**
 * Der Redaction-Filter aus Abschnitt 4.7: Secrets erreichen nie den Prompt, nie ein
 * Artefakt, nie das Ereignisprotokoll.
 *
 * **Nicht abschaltbar, mit Absicht.** Es gibt keinen Parameter, keine Umgebungsvariable und
 * kein Flag, mit dem sich der Filter umgehen ließe, und es gibt keine Fassung von
 * `redactText`, die eine Ausnahmeliste entgegennimmt. Ein Schalter wäre irgendwann gesetzt —
 * beim Debuggen, "nur kurz", in genau dem Lauf, dessen Protokoll später jemand liest. Eine
 * stille Ausnahme ist das Verstecken eines Fehlers, das AGENTS.md untersagt, nur mit
 * umgekehrtem Vorzeichen: hier versteckt sie nicht den Fehler, sondern das Leck.
 *
 * Wer die Reichweite ändern will, ändert die Liste in `patterns.ts`. Das ist eine sichtbare
 * Änderung an einer versionierten Datei, kein Aufrufargument.
 *
 * Schicht: `runtime/`, nicht `policy/`. Die Notiz aus S03 ("gehört in die
 * Governance-Schicht") wird damit ausdrücklich revidiert, aus zwei Gründen. Erstens trifft
 * dieser Filter keine Entscheidung: eine Policy hat Optionen, Allow/Deny/Ask, Risikostufen —
 * dieser Filter hat nichts davon, und zwar prinzipiell nicht. Zweitens sind die Schreibtore
 * `appendEventInTx` und `writeArtifact` selbst Runtime; die Policy-Engine (S11) wird
 * umgekehrt Ereignisse schreiben und damit auf `runtime/events` zeigen. Läge der Filter in
 * `policy/`, zeigten beide Schichten aufeinander.
 */

/** Der Wert enthält einen Zyklus und ließe sich ohnehin nicht als JSON schreiben. */
export class RedactionCycleError extends Error {}

/**
 * Ersetzt bekannte Geheimnisformate in einer Zeichenkette. Jedes Muster aus `patterns.ts`
 * läuft einmal, in der dort festgelegten Reihenfolge.
 */
export function redactText(text: string): string {
  let out = text;
  for (const entry of SECRET_PATTERNS) {
    out = out.replace(entry.pattern, entry.replacement);
  }
  return out;
}

/**
 * Ersetzt Geheimnisse in einem beliebig verschachtelten Wert.
 *
 * Rekursiv, nicht nur auf oberster Ebene: ein Ereignis-Payload ist ein Baum, und genau die
 * tiefen Blätter — `source.tool`, `result.structured.config.api_key` — sind die Stellen, an
 * denen niemand nachschaut. Ein Filter, der nur die Wurzel prüft, prüft die Stelle, an der
 * ein Geheimnis am seltensten steht.
 *
 * Zwei Wege führen zu einer Ersetzung, und beide werden gebraucht:
 *   * die **Form des Wertes** (`sk-ant-…`, `postgres://u:p@…`) — greift, wo der Feldname
 *     harmlos ist;
 *   * der **Name des Feldes** (`api_key`, `password`) — greift, wo der Wert keine erkennbare
 *     Form hat. `{ "api_key": "hunter2" }` ist über den Wert allein nicht zu finden.
 *
 * Der Rückgabetyp ist `unknown` und nicht generisch `T`. Ein Wert unter einem geheimen
 * Feldnamen wird durch eine Zeichenkette ersetzt, gleich welchen Typ er hatte — ein `T`
 * verspräche also mehr, als der Rückweg hält. Dieselbe Überlegung wie bei `JsonValue` in
 * `steps/types.ts`.
 */
export function redactValue(value: unknown): unknown {
  return walk(value, new Set<object>());
}

function walk(value: unknown, path: Set<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;

  // Bytes sind kein Text. Ein Muster über einen Binärpuffer laufen zu lassen, hieße Zufall
  // gegen Zufall zu prüfen; was als Artefakt auf die Platte geht, ist ohnehin nie ein
  // Ereignis-Payload, sondern ein Handle darauf.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

  // Nur der aktuelle Pfad, nicht alles Gesehene: derselbe Teilbaum darf zweimal vorkommen,
  // ein Zyklus nicht. Ohne diese Prüfung liefe die Rekursion in einen Stapelüberlauf statt
  // in eine Aussage, und JSON.stringify scheiterte danach ohnehin.
  if (path.has(value)) {
    throw new RedactionCycleError(
      "Der Wert enthält einen Zyklus und ist als JSON nicht schreibbar; der Redaction-Filter bricht ab, statt in die Tiefe zu laufen",
    );
  }
  path.add(value);

  try {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, path));

    // Date und alles andere, was selbst bestimmt, was von ihm in JSON landet. Das Ergebnis
    // wird gefiltert, nicht das Objekt — sonst prüfte der Filter etwas anderes, als der
    // Schreiber später serialisiert.
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      return walk((toJson as () => unknown).call(value), path);
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Auch der Schlüssel selbst kann ein Geheimnis tragen, etwa in einer Map von Token
      // auf Metadaten.
      const name = redactText(key);
      out[name] =
        isSecretFieldName(key) && entry !== null && entry !== undefined
          ? redactionMarker("secret-field")
          : walk(entry, path);
    }
    return out;
  } finally {
    path.delete(value);
  }
}
