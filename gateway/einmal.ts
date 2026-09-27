import { query } from "@anthropic-ai/claude-agent-sdk";
import { nurEigeneServer } from "./abschottung.js";
import { type Posten, ausErgebnis } from "./verbrauch.js";

/**
 * Ein einzelner Modellaufruf ohne Werkzeuge, ohne Verlauf, ohne Sitzungsdatei — für Arbeit, die
 * nur Text liest und Text schreibt: die Nachbetrachtung einer Prognose (`lehren.ts`) und die
 * Übergabe an Kuros nächste Unterhaltung (`gespraeche.ts`).
 *
 * `tools: []` nimmt jedes eingebaute Werkzeug aus dem Katalog: wer nur zurückschauen soll, soll
 * nicht nebenbei nachschlagen, und jedes Schema kostet. `persistSession: false`, weil ein solcher
 * Lauf nichts fortsetzt — sonst läge für jede Nachbetrachtung eine weitere Verlaufsdatei neben
 * Kuros eigenen. `settingSources: []`: Kuros Hausregeln (`workspace/CLAUDE.md`) gehören nicht
 * in eine Rückschau.
 *
 * Der Verbrauch wird gebucht wie jeder andere Lauf — er geht übers selbe Abo.
 */
export interface EinmalAuftrag {
  /** Wer im Verbrauchsbuch steht, z. B. `boerse`. */
  wer: string;
  /** Wofür, als `unter` im Verbrauchsbuch: `nachbetrachtung`, `uebergabe`. */
  wofuer: string;
  system: string;
  prompt: string;
  model?: string;
  cwd: string;
  onVerbrauch?(posten: Posten): void;
}

export async function schreibeEinmal(a: EinmalAuftrag): Promise<string> {
  const start = Date.now();
  let text = "";
  let fehler: string | null = null;
  for await (const nachricht of query({
    prompt: a.prompt,
    options: {
      cwd: a.cwd,
      systemPrompt: { type: "custom", prompt: a.system },
      ...(a.model ? { model: a.model } : {}),
      tools: [],
      settingSources: [],
      ...nurEigeneServer(),
      persistSession: false,
      maxTurns: 1,
    },
  })) {
    if (nachricht.type === "assistant" && nachricht.parent_tool_use_id === null) {
      for (const block of nachricht.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
    if (nachricht.type === "result") {
      a.onVerbrauch?.({
        zeit: new Date().toISOString(),
        wer: a.wer,
        unter: a.wofuer,
        ...ausErgebnis(nachricht),
        dauerMs: Date.now() - start,
      });
      if (nachricht.subtype !== "success") fehler = nachricht.subtype;
    }
  }
  if (!text.trim()) throw new Error(fehler ? `Lauf endete mit ${fehler}` : "Keine Antwort.");
  return text;
}
