import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Seit 2026-09-20 läuft wieder **alles**, was im Baum liegt. Bis dahin stand hier eine lange
    // Liste von Ausnahmen: die Tests der Phasen 1–5 gehörten zum alten Motor, liefen nicht mehr
    // und wurden einzeln ausgeschlossen, während drei neue namentlich wieder hereingeholt werden
    // mussten. Mit dem alten Motor sind diese Tests gelöscht — was übrig ist, prüft laufenden
    // Code, und ein Test, der still nicht läuft, ist schlimmer als keiner.
    //
    // `voice/` bleibt draußen: die Sprachschicht ist Python und wird über
    // `docker compose run --rm voice-test` gefahren.
    include: ["**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      "build",
      "voice/**",
      "desktop/node_modules/**",
      "desktop/dist/**",
      "workspace/**",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
