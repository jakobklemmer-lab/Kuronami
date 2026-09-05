import { existsSync } from "node:fs";

// Tests gegen Postgres brauchen DATABASE_URL. `pnpm migrate` bekommt sie über
// `tsx --env-file=.env`, vitest hat kein Gegenstück dazu. Eine bereits gesetzte
// Umgebungsvariable gewinnt, damit CI die .env des Entwicklungsrechners überstimmt.
if (!process.env.DATABASE_URL && existsSync(".env")) {
  process.loadEnvFile(".env");
}
