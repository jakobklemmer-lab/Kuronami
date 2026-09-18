import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Konto, entwurf, konten, liste, lies, sende } from "./postfach.js";

/**
 * Die Postfach-Werkzeuge, aufgeteilt nach dem, wer sie haben darf.
 *
 * `createLesePostfach()` geht an die Korrespondenz: auflisten, lesen, Entwurf ablegen. Alles
 * umkehrbar.
 *
 * `createSendePostfach()` geht an **Kuro allein** und steht bei ihm nicht in der Freigabeliste
 * — er fragt also vor jedem Versand. Das ist keine Förmlichkeit: eine Mail, die im Namen des
 * Hausherrn hinausging, holt niemand zurück, und ein Sekretär, der im Hintergrund Post
 * verschickt, ist genau das, was man an einem Assistenten fürchtet.
 */

const kontoFeld = z
  .string()
  .optional()
  .describe("Name des Postfachs. Weglassen heißt: alle.");

export function createLesePostfach(alle: Konto[] = konten()) {
  const werkzeuge = [
    tool(
      "liste",
      "Die neuesten Nachrichten als Übersicht — Absender, Betreff, Zeit, gelesen oder nicht. " +
        "Ohne Volltext; zum Lesen einer einzelnen Nachricht das Werkzeug `lies`.",
      {
        konto: kontoFeld,
        anzahl: z.number().int().min(1).max(50).optional().describe("Vorgabe 15."),
        nurUngelesen: z.boolean().optional(),
      },
      async ({ konto, anzahl, nurUngelesen }) => {
        const koepfe = await liste(alle, { konto, anzahl, nurUngelesen });
        if (koepfe.length === 0) {
          return { content: [{ type: "text" as const, text: "Keine Nachrichten gefunden." }] };
        }
        const zeilen = koepfe.map(
          (k) =>
            `[${k.konto} #${k.uid}]${k.ungelesen ? " •" : ""} ${k.am.slice(0, 16)} — ` +
            `${k.von}: ${k.betreff}`,
        );
        return { content: [{ type: "text" as const, text: zeilen.join("\n") }] };
      },
      { annotations: { readOnlyHint: true, title: "Postfach sichten" } },
    ),

    tool(
      "lies",
      "Eine einzelne Nachricht im Volltext. Konto und Nummer stammen aus `liste`.",
      {
        konto: z.string().describe("Name des Postfachs, wie in der Übersicht."),
        nummer: z.number().int().describe("Die Nummer aus der Übersicht."),
      },
      async ({ konto, nummer }) => {
        const m = await lies(alle, konto, nummer);
        return {
          content: [
            {
              type: "text" as const,
              text: `Von: ${m.von}\nAn: ${m.an}\nBetreff: ${m.betreff}\nAm: ${m.am}\n\n${m.text}`,
            },
          ],
        };
      },
      { annotations: { readOnlyHint: true, title: "Nachricht lesen" } },
    ),

    tool(
      "entwurf",
      "Einen Antwortentwurf im Postfach ablegen. Verschickt nichts — der Entwurf wartet auf " +
        "Jakob.",
      {
        konto: z.string(),
        an: z.string().describe("Empfängeradresse."),
        betreff: z.string(),
        text: z.string(),
      },
      async ({ konto, an, betreff, text }) => ({
        content: [{ type: "text" as const, text: await entwurf(alle, konto, an, betreff, text) }],
      }),
      { annotations: { title: "Entwurf ablegen" } },
    ),
  ];

  return createSdkMcpServer({
    name: "postfach",
    version: "1",
    instructions:
      alle.length > 0
        ? `Jakobs Postfächer: ${alle.map((k) => k.name).join(", ")}.`
        : "Es ist noch kein Postfach eingerichtet. Sage das, statt etwas zu erfinden.",
    tools: werkzeuge,
  });
}

export function createSendePostfach(alle: Konto[] = konten()) {
  return createSdkMcpServer({
    name: "versand",
    version: "1",
    instructions: "Post verschicken. Jeder Versand wird Jakob vorgelegt.",
    tools: [
      tool(
        "sende",
        "Eine Nachricht tatsächlich verschicken. Nur nach ausdrücklicher Zustimmung Jakobs, " +
          "und nur mit einem Text, den er gesehen hat.",
        {
          konto: z.string(),
          an: z.string(),
          betreff: z.string(),
          text: z.string(),
        },
        async ({ konto, an, betreff, text }) => ({
          content: [{ type: "text" as const, text: await sende(alle, konto, an, betreff, text) }],
        }),
        { annotations: { title: "Post verschicken" } },
      ),
    ],
  });
}

export const SENDE_WERKZEUG = "mcp__versand__sende";
