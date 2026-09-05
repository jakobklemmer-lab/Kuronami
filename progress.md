# Fortschrittslog

## S01 · Repo-Grundgerüst · 2026-09-05

- Git-Repo initialisiert.
- Ordnerstruktur für die fünf Schichten plus `memory/`, `skills/`, `evals/`, `docs/`
  angelegt, jeweils mit README.md.
- `package.json` mit Scripts `dev`, `build`, `test`, `lint`, `format`, `typecheck`.
- `tsconfig.json` (strict, ESM, NodeNext, ES2023), `biome.json`, `vitest.config.ts`.
- `.gitignore` und `.claudeignore` synchron gehalten.
- `.env.example` mit `DATABASE_URL`, `ARTIFACT_ROOT`, `ANTHROPIC_API_KEY`, `LOG_LEVEL`.
- `AGENTS.md` verdichtet auf die täglichen Arbeitsregeln.
- `README.md` mit den fünf Schichten und Startanleitung.
- `tasks.json` mit allen 24 Sessions aus Abschnitt 16 der Architektur angelegt.
- `docker-compose.yml` mit Platzhaltern für `runtime`, `postgres` (16-alpine) und `n8n`.
- Trivialer Test unter `runtime/health.test.ts` angelegt.
- Fertig-Kriterium `pnpm install && pnpm typecheck && pnpm lint && pnpm test` ausgeführt,
  Ergebnis siehe Commit-Historie / Session-Log.

Status: abgeschlossen. Nächste Session: S02 Postgres-Schema.
