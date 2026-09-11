import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTINE_MODEL,
  DEFAULT_THINKING_MODEL,
  type ModelRouterDeps,
  resolveModelRouteConfig,
  routeTask,
} from "./router.js";
import type { ModelClient, ModelResponse } from "./types.js";

/**
 * Reines Einheitentest ohne Datenbank und ohne Loop — wie `context/compaction.test.ts` für
 * Kontextstufe 3: `routeTask` ist eine Funktion von Eingabe zu Entscheidung, geprüft mit einem
 * Fake-Modell statt einem Drehbuch (`scripted.ts` passt nicht: das zählt Werkzeugergebnisse in
 * einer Loop-Historie, hier gibt es keine).
 */

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

function fixedTextModel(name: string, text: string): ModelClient {
  return {
    model: name,
    async complete(): Promise<ModelResponse> {
      return {
        model: name,
        stopReason: "end_turn",
        text,
        toolCalls: [],
        usage: ZERO_USAGE,
        content: [{ type: "text", text }],
      };
    },
  };
}

function deps(classifierText: string): ModelRouterDeps {
  return {
    routineModel: fixedTextModel("routine-modell", classifierText),
    thinkingModel: fixedTextModel("denk-modell", "wird für Klassifikation nie benutzt"),
  };
}

describe("Modell-Routing (S18e)", () => {
  it("wählt das günstige Modell bei ROUTINE", async () => {
    const decision = await routeTask(
      deps("ROUTINE: kurzer Status-Ping ohne Planung"),
      "Wie ist der Serverstatus?",
    );

    expect(decision.taskClass).toBe("routine");
    expect(decision.model.model).toBe("routine-modell");
    expect(decision.reason).toBe("kurzer Status-Ping ohne Planung");
    expect(decision.classifierModel).toBe("routine-modell");
  });

  it("wählt das starke Modell bei THINKING", async () => {
    const decision = await routeTask(
      deps("THINKING: mehrstufiger Plan mit Abwägung nötig"),
      "Entwirf einen Migrationsplan für die nächsten drei Sessions.",
    );

    expect(decision.taskClass).toBe("thinking");
    expect(decision.model.model).toBe("denk-modell");
    expect(decision.reason).toBe("mehrstufiger Plan mit Abwägung nötig");
  });

  it("akzeptiert die Klasse ohne Doppelpunkt-Trenner", async () => {
    const decision = await routeTask(deps("ROUTINE kurz"), "ping");
    expect(decision.taskClass).toBe("routine");
    expect(decision.reason).toBe("kurz");
  });

  it("fällt bei uneindeutiger Antwort sicher auf Denkarbeit zurück", async () => {
    const decision = await routeTask(deps("Das kommt darauf an."), "irgendeine Aufgabe");

    expect(decision.taskClass).toBe("thinking");
    expect(decision.model.model).toBe("denk-modell");
    expect(decision.reason).toContain("nicht eindeutig");
  });

  it("gibt einen Fehler des Klassifikators weiter, statt ihn zu verschlucken", async () => {
    const failing: ModelRouterDeps = {
      routineModel: {
        model: "routine-modell",
        complete: async () => {
          throw new Error("Anbieter nicht erreichbar");
        },
      },
      thinkingModel: fixedTextModel("denk-modell", "unbenutzt"),
    };

    await expect(routeTask(failing, "ping")).rejects.toThrow("Anbieter nicht erreichbar");
  });
});

describe("resolveModelRouteConfig (S18e)", () => {
  it("liefert die Startwerte ohne Umgebungsvariablen und Overrides", () => {
    const previous = { routine: process.env.MODEL_ROUTINE, thinking: process.env.MODEL_THINKING };
    process.env.MODEL_ROUTINE = "";
    process.env.MODEL_THINKING = "";
    try {
      expect(resolveModelRouteConfig()).toEqual({
        routineModel: DEFAULT_ROUTINE_MODEL,
        thinkingModel: DEFAULT_THINKING_MODEL,
      });
    } finally {
      restoreEnv("MODEL_ROUTINE", previous.routine);
      restoreEnv("MODEL_THINKING", previous.thinking);
    }
  });

  it("Overrides gehen vor Umgebungsvariablen, die vor den Startwerten", () => {
    const previous = process.env.MODEL_ROUTINE;
    process.env.MODEL_ROUTINE = "aus-der-umgebung";
    try {
      expect(resolveModelRouteConfig({ routineModel: "aus-dem-override" }).routineModel).toBe(
        "aus-dem-override",
      );
      expect(resolveModelRouteConfig().routineModel).toBe("aus-der-umgebung");
    } finally {
      restoreEnv("MODEL_ROUTINE", previous);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
