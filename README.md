# Kuronami

Persönlicher AI-Assistent als vollständiges Agent Harness: eigener Ausführungsmotor,
dauerhafter Zustand, ausgelagertes Gedächtnis, erzwungene Freigaben, austauschbare
Oberfläche. Vollständiger Kontext in [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md).

## Die fünf Schichten

| Schicht | Aufgabe | Ordner |
|---|---|---|
| Execution Runtime | Loop, Sessions, Checkpoints, Wiederaufnahme, Abbruch, Retry | `runtime/` |
| Context System | Prompt-Aufbau, Artefakt-Referenzen, Kompaktierung, Cache-Disziplin | `context/` |
| Capability Surface | Tool-Router, Kern-Tools, n8n-Brücke, Skills, Subagenten | `tools/`, `skills/` |
| Governance | Freigaben, Hooks, Allow/Deny, Sandbox, Risikostufen | `policy/` |
| Surface / Protokoll | Kanal-Normalisierung, Web, Telegram, Mail, Sprache | `gateway/` |

Dazu: `memory/` (Langzeitgedächtnis), `evals/` (Harness-Evals), `docs/` (Architektur und
Folgeentscheidungen).

**Harte Regel:** Die Surface-Schicht ist austauschbar. Die Runtime darf niemals von ihr
abhängen.

## Start

Voraussetzung: Node.js 24 LTS, pnpm, Docker Desktop (für Postgres und n8n).

```
pnpm install
cp .env.example .env
pnpm typecheck
pnpm lint
pnpm test
```

Postgres und n8n laufen später über `docker-compose.yml` (Platzhalter, ab S02/S13
lauffähig).

## Benutzen

Der Weg für Nachrichten ist seit S16 das Gateway — ein eigener Prozess, der
authentifiziert, Kanäle normalisiert und Web wie Telegram in **eine** Unterhaltung führt
(siehe [`gateway/README.md`](gateway/README.md)):

```
pnpm gateway                          # Gateway starten (Web + Telegram)
pnpm say "Was steht heute an?"        # Nachricht über den Web-Kanal
pnpm say --pending                    # offene Freigaben
pnpm say --answer <ask_id> <option>   # eine Freigabe erteilen
```

Daneben, zum Prüfen: `pnpm run:task "…"` fährt einen Lauf **ohne Kanal** direkt in der
Runtime (keine Authentifizierung, eigener Faden, eigenes Gedächtnis), `pnpm devui` öffnet
die Wegwerf-Oberfläche aus S12b, `pnpm migrate up|down` wandert durch das Schema.

## Konventionen

Siehe [`AGENTS.md`](AGENTS.md) für Tool-Namenskonvention, Rückgabehülle, Fehlerbehandlung
und Codestil. Fortschritt in [`progress.md`](progress.md), Aufgabengraph in
[`tasks.json`](tasks.json).
