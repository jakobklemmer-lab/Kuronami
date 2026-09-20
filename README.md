# Kuronami

Persönlicher AI-Assistent: ein Butler mit Personal, dauerhaftem Zustand, ausgelagertem
Gedächtnis und austauschbarer Oberfläche. Der Motor ist seit 2026-09-18 das Claude Agent SDK;
die Arbeitsregeln stehen in [`AGENTS.md`](AGENTS.md).

## Der Baum

| Teil | Aufgabe | Ordner |
|---|---|---|
| Gateway | Motor, Personal, Kanäle (Web, Telegram, Slack, Sprache), HTTP-API | `gateway/` |
| Oberfläche | Präsenz, Kurstafel, Postfach, Analysen, Einstellungen | `ui/` |
| Zustand | Postgres-Schema, Ereignisprotokoll, Sessions, Artefakte, Redaction | `runtime/` |
| Kontext | Persona, Bedienstete, Kostentabellen | `context/` |
| Ablagen | Langzeitgedächtnis, n8n-Brücke | `tools/` |
| Sprachschicht | Pipecat-Prozess (Python), hinter seiner Prozessgrenze | `voice/` |

Dazu: `memory/` (Langzeitgedächtnis), `workspace/` (Kuros Arbeitsbereich), `docs/` (Architektur
des alten Motors — Historie, siehe `AGENTS.md`).

**Harte Regel:** Die Oberfläche ist austauschbar. `runtime/`, `context/` und `tools/` dürfen
niemals von `gateway/` abhängen (geprüft in `gateway/layering.test.ts`).

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
