import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Ab S21: Nur Phase-6-Tests (UI)
    // Alte Tests (Phase 1-5) laufen nicht mehr automatisch
    //
    // Ab S30 kommt `gateway/channels/voice/` dazu, und zwar **nur** dieser Ordner: der
    // Sprach-Kanal ist neue Arbeit, und neue Arbeit ohne laufendes Netz zu bauen wäre der
    // schlechtere Handel. Die 679 alten Tests der Phasen 1–5 bleiben aus dem Lauf, wie vom
    // Nutzer in S21 angeordnet — die Zeile unten schließt sie weiterhin aus, diese eine
    // Ausnahme steht davor und ist damit sichtbar.
    include: ["ui/**/*.test.ts", "phase-6/**/*.test.ts", "gateway/channels/voice/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      "build",
      "context/**/*.test.ts",
      "runtime/**/*.test.ts",
      "gateway/*.test.ts",
      "gateway/channels/slack/**/*.test.ts",
      "gateway/channels/telegram/**/*.test.ts",
      "heartbeat/**/*.test.ts",
      "policy/**/*.test.ts",
      "tools/**/*.test.ts",
      "skills/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
