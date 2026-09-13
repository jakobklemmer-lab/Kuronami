# S32 — Provider- und MCP-Anbindung produktiv machen

**Vor dem ersten Schritt:** `progress.md` und `tasks.json` lesen (Eintrag `S32`), nicht den
Kontext aus der Codebasis rekonstruieren (ARCHITEKTUR.md §16, "Ablauf jeder Session"). Tests
der Vorsession laufen lassen: `pnpm install && pnpm typecheck && pnpm lint && pnpm test`
sowie `docker compose run --rm voice-test`.

## Ausgangslage

Der Mechanismus steht in allen drei Fällen, der Betrieb nicht:

* **`ANTHROPIC_API_KEY`** ist seit S16 leer — der Agent-Loop läuft nur gegen Tests/Stubs, nie
  gegen ein echtes Modell.
* **`DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY`** sind seit S30 leer — die Sprachschicht ist an
  genau einer Stelle angebunden (`voice/pipeline/services.py`) und im gebauten Graphen
  nachgewiesen (`tests/test_app.py`), aber nie mit einem echten Anbieter gelaufen (offener
  Befund seit S30/S31, siehe `progress.md`).
* **MCP (S27)** baute den Mechanismus samt Härtung (Risikostufe pro Server, Namensraum-
  Isolation `mcp.<serverId>__<fernname>`, einmalige Entdeckung beim Katalogbau —
  ARCHITEKTUR.md §9, Abschnitt "MCP absichern"), verkabelte aber bewusst **keinen** echten
  Server. `tools/mcp/client.ts` / `tools/mcp/tools.ts` hängen an keinem Prozess; anbinden
  heißt: `CatalogConfig.mcp` an `buildCatalog` (`runtime/loop/api.ts`) reichen.
* Offene Entscheidung aus ARCHITEKTUR.md §17, hier fällig: **welcher MCP-Server zuerst**
  (dort genannte Kandidaten: Game-Tools oder Trading-Tools). Mit dem Nutzer klären, nicht
  raten — die Frage steht dort absichtlich offen.

## Auftrag

1. `.env` aus `.env.example` anlegen (lokal, **nicht committen** — `.gitignore:25` schließt
   es aus). Werte kommen vom Nutzer; nicht raten, nicht aus einer anderen Quelle übernehmen.
2. Mindestens: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` +
   `ELEVENLABS_VOICE_ID`, `VOICE_MODE=live`, `VOICE_SESSION_TOKEN`, `VOICE_BRIDGE_TOKEN`.
   Nach Nutzerentscheidung zusätzlich, je nach gewünschtem Kanalumfang: `GATEWAY_*`,
   `TELEGRAM_*`, `SLACK_*`, `N8N_*`, `OBSIDIAN_VAULT_PATH`, `WEB_EGRESS_ALLOWLIST` — jede
   dieser Gruppen schaltet laut Kommentaren in `.env.example` eigene Tools/Kanäle frei,
   keine Gruppe ist für S32 selbst Pflicht.
3. Einen echten MCP-Server auswählen (Rücksprache Nutzer, §17) und über `CatalogConfig.mcp`
   verkabeln. Die Härtungstests aus S27 (`tools/mcp/tools.test.ts`) müssen gegen den echten
   Server weiter grün bleiben, nicht nur gegen den Fake-Server aus dem Testaufbau.
4. Einen echten Ende-zu-Ende-Lauf je Achse nachweisen: ein Agent-Loop mit echtem
   Modellaufruf, eine Sprachsitzung in `VOICE_MODE=live` mit beiden Anbietern, ein
   MCP-Tool-Aufruf über den echten Server — jede der drei mit Beleg (Log-Auszug oder Test),
   nicht nur "sollte laufen".

## Fertig, wenn

Agent antwortet über einen echten Anthropic-Modellaufruf; `VOICE_MODE=live` läuft Ende-zu-
Ende gegen echte Deepgram- und ElevenLabs-Antworten; ein produktiver MCP-Server ist
angebunden, seine Tools erscheinen im gebauten Katalog, und die S27-Härtungsprüfung bleibt
dagegen grün.

## Bewusst nicht Teil dieser Session

* Kein separates API-Billing-Konto oder Budget-Obergrenze — eigener offener Punkt in §17,
  eigene Session wert.
* Kein neuer Kanal, der heute nicht schon im Code steht (Slack/Telegram sind seit S26/S16
  fertig gebaut; hier geht es ums Verbinden, nicht ums Bauen).
* S25 (Centerpiece/3D-Welt) bleibt auf Nutzeranweisung vom 2026-09-13 stillgelegt.

## Danach

`progress.md` und `tasks.json` aktualisieren (`S32` → `done`, hier tatsächlich geschlossene
offene Befunde streichen), Commit `S32: <Thema>` (AGENTS.md, "Jede Session endet mit einem
Commit" — ohne Rückfrage, ohne Ausnahme), dann `/clear`.
