import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPort, InboundMessage, Outbound, Sender } from "./types.js";

/**
 * Jakobs Stopp-Knopf (`KuroAgent.abbrechen`). Was stimmen muss: der Zug endet sofort und als
 * „abgebrochen", nicht als „misslungen"; was Kuro bis dahin gesagt hat, bleibt stehen; und wer
 * anhält, während nichts läuft, bekommt das so gesagt.
 *
 * Das SDK ist nachgebaut: ein Lauf, der ein Wortstück sagt und dann wartet, bis sein
 * `abortController` auslöst — einmal mit Fehler (so beendet das SDK einen Lauf meist), einmal
 * still.
 */

const ART = vi.hoisted(() => ({ wirft: true }));

vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => {
  const echt = await original<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...echt,
    query: ({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sitzung-1" };
        yield {
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Ich sehe" } },
        };
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "Ich sehe nach." }] },
        };
        // Die zweite Wortmeldung ist erst angefangen, als Jakob anhält.
        yield {
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "Der DAX" } },
        };
        await new Promise<void>((fertig) =>
          options.abortController.signal.addEventListener("abort", () => fertig()),
        );
        if (ART.wirft) throw new echt.AbortError("Claude Code process aborted by user");
      })(),
  };
});

const { ABGEBROCHEN, KuroAgent } = await import("./agent.js");

const JAKOB: Sender = {
  channel: "web",
  channelUserId: "jakob",
  displayName: "Jakob",
  replyTo: "web-1",
};

function nachricht(text: string): InboundMessage {
  return {
    channel: "web",
    sender: JAKOB,
    content: text,
    attachments: [],
    receivedAt: new Date(),
    externalId: `web:${text}`,
  };
}

async function baue() {
  const workdir = await mkdtemp(path.join(tmpdir(), "kuro-abbruch-"));
  const zugestellt: Outbound[] = [];
  const ereignisse: Array<{ type: string; data: Record<string, unknown> }> = [];
  const web: ChannelPort = {
    deliver: async (_an, m) => {
      zugestellt.push(m);
    },
  } as ChannelPort;
  const agent = new KuroAgent({
    workdir,
    channels: new Map([["web", web]]),
    publish: (type, data) => ereignisse.push({ type, data }),
  });
  return { agent, zugestellt, ereignisse };
}

/** Bis der nachgebaute Lauf beim Warten angekommen ist. */
async function bisErWartet(ereignisse: Array<{ type: string }>): Promise<void> {
  for (let i = 0; i < 200 && !ereignisse.some((e) => e.type === "turn.started"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 20));
}

afterEach(() => {
  ART.wirft = true;
});

describe("abbrechen", () => {
  it("hält den laufenden Zug an und behält, was Kuro schon gesagt hat, auch angefangen", async () => {
    const { agent, zugestellt, ereignisse } = await baue();
    const lauf = agent.receive(nachricht("Wie steht der DAX?"));
    await bisErWartet(ereignisse);

    expect(agent.abbrechen()).toEqual({ zug: true, auftraege: [] });
    const ergebnis = await lauf;

    expect(ergebnis.status).toBe("canceled");
    expect(zugestellt).toEqual([
      { kind: "reply", text: `Ich sehe nach.\n\nDer DAX\n\n${ABGEBROCHEN}` },
    ]);
    const ende = ereignisse.find((e) => e.type === "turn.completed");
    expect(ende?.data.status).toBe("canceled");
  });

  it("gilt auch, wenn das SDK den Lauf ohne Fehler beendet", async () => {
    ART.wirft = false;
    const { agent, ereignisse } = await baue();
    const lauf = agent.receive(nachricht("Und der S&P?"));
    await bisErWartet(ereignisse);

    agent.abbrechen();
    expect((await lauf).status).toBe("canceled");
  });

  it("sagt, dass nichts lief, wenn kein Zug läuft", async () => {
    const { agent } = await baue();
    expect(agent.abbrechen()).toEqual({ zug: false, auftraege: [] });
    expect(agent.abbrechen(true)).toEqual({ zug: false, auftraege: [] });
  });

  it("lässt den nächsten Zug normal laufen", async () => {
    const { agent, ereignisse } = await baue();
    const erster = agent.receive(nachricht("Erste Frage"));
    await bisErWartet(ereignisse);
    agent.abbrechen();
    await erster;

    ereignisse.length = 0;
    const zweiter = agent.receive(nachricht("Zweite Frage"));
    await bisErWartet(ereignisse);
    // Der zweite Zug wartet wieder — er ist also angelaufen, und das Anhalten trifft ihn.
    expect(agent.abbrechen().zug).toBe(true);
    expect((await zweiter).status).toBe("canceled");
  });
});
