import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPolicyEngine } from "../../policy/engine.js";
import type { AgentProfile } from "../../runtime/agents/types.js";
import { createPool } from "../../runtime/db/pool.js";
import type { ModelClient, ModelResponse } from "../../runtime/model/types.js";
import { readSessionState } from "../../runtime/session/state.js";
import { DEV_TOOLS } from "../dummies.js";
import { buildFsZones, policyResolver } from "../fs/paths.js";
import { createFsTools } from "../fs/tools.js";
import { ToolRegistry } from "../registry.js";
import type { ToolCatalog } from "../types.js";
import { TokenBudgetExceededError, budgetedModel } from "./budget.js";
import { DEFAULT_MAX_PARALLEL_WORKERS, runWorker } from "./worker.js";

/**
 * Die beiden Obergrenzen aus Abschnitt 14, die S20 nachträgt: **Token-Budget** je Agent und
 * **parallele Arbeiter** je Prozess. (Die dritte, die explizite Tool-Beschränkung, steht in
 * `casting.test.ts`.)
 */

const pool = createPool();
const sessionIds: string[] = [];
let sourceRoot: string;
let artifactRoot: string;
let catalog: ToolCatalog;
let policy: ReturnType<typeof createPolicyEngine>;

const USAGE = (tokens: number) => ({
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

beforeAll(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-limits-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "probe.txt"), "Probeinhalt.\n");

  const zones = await buildFsZones({ sourceRoot, artifactRoot });
  policy = createPolicyEngine({ resolvePath: policyResolver(zones) });
  catalog = new ToolRegistry()
    .registerAll(createFsTools({ pool, artifactRoot, zones }))
    .registerAll(DEV_TOOLS)
    .freeze();
});

afterEach(() => {
  process.env.AGENT_MAX_PARALLEL = undefined;
  // biome-ignore lint/performance/noDelete: die Variable muss wirklich weg sein, nicht "undefined".
  delete process.env.AGENT_MAX_PARALLEL;
});

afterAll(async () => {
  if (sessionIds.length > 0) {
    for (const table of ["approvals", "tasks", "steps", "events"]) {
      await pool.query(`DELETE FROM kuronami.${table} WHERE session_id = ANY($1)`, [sessionIds]);
    }
    await pool.query("DELETE FROM kuronami.sessions WHERE session_id = ANY($1)", [sessionIds]);
  }
  await pool.end();
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
});

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentId: `agent_test_${randomUUID().slice(0, 8)}`,
    name: "pruef-agent",
    role: "Prüf-Agent",
    purpose: "Läuft für einen Test.",
    systemPrompt: "Du läufst für einen Test.",
    model: "modell-test",
    tools: ["dev.echo"],
    maxRisk: "read",
    maxSteps: 10,
    tokenBudget: null,
    schedule: null,
    status: "active",
    createdBy: "test",
    createdInSession: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Ein Modell, das immer denselben Werkzeugaufruf macht — der Lauf endet nur an einer Grenze. */
function endlessModel(tokensPerCall: number): ModelClient {
  let call = 0;
  return {
    model: "modell-test",
    async complete(): Promise<ModelResponse> {
      call += 1;
      const id = `call_endless_${call}`;
      const input = { message: `Schritt ${call}` };
      return {
        model: "modell-test",
        stopReason: "tool_use",
        text: `Schritt ${call}.`,
        toolCalls: [{ callId: id, name: "dev__echo", input }],
        usage: USAGE(tokensPerCall),
        content: [
          { type: "text", text: `Schritt ${call}.` },
          { type: "tool_use", id, name: "dev__echo", input },
        ],
      };
    },
  };
}

describe("Token-Budget", () => {
  it("zählt jeden Aufruf und lehnt den nächsten ab, sobald das Budget aufgebraucht ist", async () => {
    const budgeted = budgetedModel(endlessModel(8_000), 20_000);
    const request = { system: [], tools: [], messages: [], maxTokens: 100 };

    await budgeted.complete(request);
    expect(budgeted.spent()).toBe(8_000);
    await budgeted.complete(request);
    expect(budgeted.spent()).toBe(16_000);
    // 16k < 20k: der dritte Aufruf läuft noch und überzieht — geprüft wird **vor** dem Aufruf,
    // nicht mittendrin.
    await budgeted.complete(request);
    expect(budgeted.spent()).toBe(24_000);

    await expect(budgeted.complete(request)).rejects.toThrow(TokenBudgetExceededError);
    // Und der abgelehnte Aufruf hat nichts zusätzlich gekostet.
    expect(budgeted.spent()).toBe(24_000);
  });

  it("beendet einen Arbeiterlauf am Budget und lässt keinen offenen Zug zurück", async () => {
    const run = await runWorker(
      {
        pool,
        artifactRoot,
        catalog,
        policy,
        model: endlessModel(12_000),
        conventions: "# Test",
      },
      {
        profile: profile({ tokenBudget: 20_000, maxSteps: 50 }),
        task: "Lauf, bis das Budget aufgebraucht ist.",
        threadId: `thread_agent_budget_${randomUUID()}`,
      },
    );
    sessionIds.push(run.sessionId);

    expect(run.stop).toBe("token_budget");
    expect(run.reason).toContain("Token-Budget aufgebraucht");
    expect(run.tokensSpent).toBe(24_000);

    // Kein offener Zug, den nie jemand fortsetzt: die Session ist sichtbar beendet.
    const state = await readSessionState(pool, run.sessionId);
    expect(state.status).toBe("canceled");
  });

  it("zählt ohne Budget gar nicht", async () => {
    const run = await runWorker(
      {
        pool,
        artifactRoot,
        catalog,
        policy,
        model: {
          model: "modell-test",
          async complete(): Promise<ModelResponse> {
            const text = "Nichts zu tun.";
            return {
              model: "modell-test",
              stopReason: "end_turn",
              text,
              toolCalls: [],
              usage: USAGE(5_000),
              content: [{ type: "text", text }],
            };
          },
        },
        conventions: "# Test",
      },
      {
        profile: profile({ tokenBudget: null }),
        task: "Antworte einfach.",
        threadId: `thread_agent_nobudget_${randomUUID()}`,
      },
    );
    sessionIds.push(run.sessionId);

    expect(run.stop).toBe("done");
    expect(run.tokensSpent).toBeNull();
  });
});

describe("Obergrenze für parallele Arbeiter", () => {
  it("lässt nur so viele gleichzeitig laufen, wie erlaubt sind — und den Rest warten", async () => {
    expect(DEFAULT_MAX_PARALLEL_WORKERS).toBe(2);
    process.env.AGENT_MAX_PARALLEL = "1";

    const entered: string[] = [];
    const finished: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstInside = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    function gatedModel(name: string): ModelClient {
      return {
        model: "modell-test",
        async complete(): Promise<ModelResponse> {
          entered.push(name);
          // Der erste Arbeiter hält seinen Platz, bis der Test ihn freigibt.
          if (name === "a") await firstInside;
          const text = `${name} fertig.`;
          return {
            model: "modell-test",
            stopReason: "end_turn",
            text,
            toolCalls: [],
            usage: USAGE(10),
            content: [{ type: "text", text }],
          };
        },
      };
    }

    const start = (name: string) =>
      runWorker(
        { pool, artifactRoot, catalog, policy, model: gatedModel(name), conventions: "# Test" },
        {
          profile: profile({ name: `pruef-agent-${name}` }),
          task: "Antworte.",
          threadId: `thread_agent_parallel_${name}_${randomUUID()}`,
        },
      ).then((run) => {
        sessionIds.push(run.sessionId);
        finished.push(name);
        return run;
      });

    const a = start("a");
    const b = start("b");

    // Genug Zeit, dass `b` losliefe, wenn es dürfte: es legte sonst längst seine Session an und
    // fragte sein Modell.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(entered).toEqual(["a"]);
    expect(finished).toEqual([]);

    releaseFirst?.();
    const [runA, runB] = await Promise.all([a, b]);

    expect(runA.stop).toBe("done");
    expect(runB.stop).toBe("done");
    // `b` kam erst dran, nachdem `a` seinen Platz freigegeben hatte.
    expect(entered).toEqual(["a", "b"]);
    expect(finished).toEqual(["a", "b"]);
  });
});
