import type { ToolDefinition } from "./types.js";

/**
 * Die zwei Prüf-Tools aus dem Auftrag von S07: eines mit kleiner, eines mit riesiger
 * Ausgabe. Sie sind der Nachweis, dass die Auslagerungsschwelle an der gemessenen Größe
 * hängt und nicht daran, dass ein Tool sich selbst für groß erklärt.
 *
 * Namensraum `dev`, in Abschnitt 4.8 der Architektur begründet. Diese Tools gehören in
 * keinen produktiven Katalog: sie tun nichts, was ein Assistent für einen Nutzer tun soll,
 * und ein Katalog mit ihnen darin lehrte das Modell einen Aktionsraum, den es nicht hat
 * (Grundprinzip 4).
 */

/** Grenze für `dev.blob`. Ein Prüf-Tool, das beliebig viel Speicher belegen darf, ist eine Falle. */
export const DEV_BLOB_MAX_BYTES = 4 * 1024 * 1024;

const FILLER = "Fuellzeile fuer den Auslagerungstest, damit die Ausgabe Substanz hat.";

/** Kleine Ausgabe: bleibt unter der Schwelle und geht unverändert in den Kontext. */
export const DEV_ECHO: ToolDefinition = {
  name: "dev.echo",
  description:
    "Gibt die übergebene Nachricht zurück. Prüf-Tool mit kleiner Ausgabe: das Ergebnis bleibt unter der Auslagerungsschwelle und landet direkt im Kontext.",
  risk: "read",
  // Reines Lesen ohne Wirkung nach draußen: ein zweiter Lauf ist folgenlos.
  repeatable: true,
  inputSchema: {
    fields: {
      message: { type: "string", required: true, description: "Text, der zurückkommen soll." },
    },
  },
  handler: async ({ input }) => {
    const message = input.message as string;
    return {
      summary: `Echo mit ${message.length} Zeichen`,
      structured: { message },
      preview: [message.slice(0, 80)],
    };
  },
};

/**
 * Riesige Ausgabe: überschreitet die Schwelle und wird ausgelagert.
 *
 * Der Inhalt ist eine reine Funktion der Eingabe. Das ist kein Zierrat, sondern die
 * Bedingung dafür, dass dieses Tool im Replay-Test brauchbar ist: ein Zufallsinhalt ergäbe
 * bei jedem Lauf ein anderes Artefakt und eine andere Prüfsumme.
 */
export const DEV_BLOB: ToolDefinition = {
  name: "dev.blob",
  description:
    "Erzeugt eine strukturierte Ausgabe von ungefähr der gewünschten Größe. Prüf-Tool mit großer Ausgabe: das Ergebnis überschreitet die Auslagerungsschwelle und kommt als Zusammenfassung plus Handle zurück.",
  risk: "read",
  repeatable: true,
  inputSchema: {
    fields: {
      size_bytes: {
        type: "number",
        required: true,
        description: `Ungefähre Größe der strukturierten Ausgabe in Byte, höchstens ${DEV_BLOB_MAX_BYTES}.`,
      },
    },
  },
  handler: async ({ input }) => {
    const requested = input.size_bytes as number;
    if (!Number.isInteger(requested) || requested < 0 || requested > DEV_BLOB_MAX_BYTES) {
      throw new RangeError(
        `size_bytes muss eine ganze Zahl zwischen 0 und ${DEV_BLOB_MAX_BYTES} sein, war ${requested}`,
      );
    }

    const rows: { index: number; value: string }[] = [];
    let produced = 0;
    while (produced < requested) {
      const row = { index: rows.length, value: `${rows.length}: ${FILLER}` };
      rows.push(row);
      produced += JSON.stringify(row).length;
    }

    return {
      summary: `${rows.length} Zeilen, rund ${produced} Byte strukturierte Ausgabe`,
      structured: { requested_bytes: requested, produced_bytes: produced, rows },
      // Der Kontext bekommt die ersten Zeilen auch dann, wenn der Rest ausgelagert wird:
      // das Modell soll wissen, was in dem Handle steckt, ohne es aufzulösen.
      preview: rows.slice(0, 3).map((row) => row.value),
    };
  },
};

export const DEV_TOOLS: readonly ToolDefinition[] = [DEV_ECHO, DEV_BLOB];
