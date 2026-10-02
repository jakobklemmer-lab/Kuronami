import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type KalenderDienst, type Termin, wienerZeit } from "./kalender.js";

/**
 * Kuros Kalender-Werkzeuge. `termine` liest ohne Rückfrage; `termine_eintragen` legt einen oder
 * mehrere Zeitblöcke an und steht **nicht** in Kuros Freigabeliste — Jakob sieht die Blöcke in
 * einer einzigen Frage und sagt ja oder nein (`beschreibeEintrag`).
 */

const ZONE = "Europe/Vienna";

const tagFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: ZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});
const uhrFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

export function terminZeile(t: Termin): string {
  if (t.ganztags) {
    const tag = tagFormat.format(new Date(`${t.start}T12:00:00Z`));
    return `${tag} ganztags — ${t.titel}${t.ort ? ` (${t.ort})` : ""} · ${t.kalender}`;
  }
  const a = new Date(t.start);
  const b = new Date(t.ende);
  return `${tagFormat.format(a)} ${uhrFormat.format(a)}–${uhrFormat.format(b)} — ${t.titel}${t.ort ? ` (${t.ort})` : ""} · ${t.kalender}`;
}

const block = z.object({
  titel: z.string().min(1).max(120),
  start: z.string().describe("Wiener Zeit, JJJJ-MM-TTTHH:MM, z. B. 2026-10-03T09:00"),
  dauerMin: z.number().int().min(5).max(720).describe("Länge in Minuten."),
  erinnerungMin: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .optional()
    .describe("Minuten vorher erinnern; Vorgabe 10."),
  notiz: z.string().max(1000).optional(),
});
type Block = z.infer<typeof block>;

/** Die Frage an Jakob, bevor Blöcke eingetragen werden — jeder Block eine Zeile. */
export function beschreibeEintrag(input: Record<string, unknown>): string {
  const bloecke = Array.isArray(input.termine) ? (input.termine as Block[]) : [];
  const zeilen = bloecke.map((b) => {
    try {
      const start = wienerZeit(b.start);
      const ende = new Date(start.getTime() + b.dauerMin * 60_000);
      return `${tagFormat.format(start)} ${uhrFormat.format(start)}–${uhrFormat.format(ende)} ${b.titel}`;
    } catch {
      return `${b.start} ${b.titel}`;
    }
  });
  return `Ich möchte in Ihren Kalender eintragen: ${zeilen.join("; ")}`;
}

export const KALENDER_LESEN = "mcp__kalender__termine";

export function createKalenderWerkzeuge(dienst: KalenderDienst) {
  return createSdkMcpServer({
    name: "kalender",
    version: "1.0.0",
    tools: [
      tool(
        "termine",
        "Jakobs Termine aus seinem Kalender (iCloud), nach Zeit sortiert. Vorgabe: heute und die nächsten sechs Tage.",
        {
          von: z.string().optional().describe("Erster Tag, JJJJ-MM-TT; Vorgabe heute."),
          tage: z.number().int().min(1).max(31).optional().describe("Wie viele Tage; Vorgabe 7."),
        },
        async ({ von, tage }) => {
          const heute = new Date().toLocaleDateString("sv-SE", { timeZone: ZONE });
          const start = wienerZeit(`${von ?? heute}T00:00`);
          const ende = new Date(start.getTime() + (tage ?? 7) * 86_400_000);
          const termine = await dienst.termine(start, ende);
          const text =
            termine.length === 0
              ? "Keine Termine in diesem Zeitraum."
              : termine.map(terminZeile).join("\n");
          return { content: [{ type: "text" as const, text }] };
        },
        { annotations: { title: "Termine ansehen", readOnlyHint: true } },
      ),
      tool(
        "termine_eintragen",
        "Einen oder mehrere Zeitblöcke in Jakobs Kalender eintragen, mit Erinnerung — für die " +
          "Tagesplanung alle Blöcke in einem Aufruf. Jakob wird vorher gefragt.",
        { termine: z.array(block).min(1).max(12) },
        async ({ termine }) => {
          const zeilen: string[] = [];
          for (const b of termine) {
            const start = wienerZeit(b.start);
            const ende = new Date(start.getTime() + b.dauerMin * 60_000);
            const r = await dienst.lege({
              titel: b.titel,
              start,
              ende,
              notiz: b.notiz,
              erinnerung: b.erinnerungMin ?? 10,
            });
            zeilen.push(
              `${tagFormat.format(start)} ${uhrFormat.format(start)} ${b.titel} → ${r.kalender}`,
            );
          }
          return {
            content: [{ type: "text" as const, text: `Eingetragen:\n${zeilen.join("\n")}` }],
          };
        },
        { annotations: { title: "Termine eintragen" } },
      ),
    ],
  });
}
