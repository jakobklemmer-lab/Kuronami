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

## Konventionen

Siehe [`AGENTS.md`](AGENTS.md) für Tool-Namenskonvention, Rückgabehülle, Fehlerbehandlung
und Codestil. Fortschritt in [`progress.md`](progress.md), Aufgabengraph in
[`tasks.json`](tasks.json).
