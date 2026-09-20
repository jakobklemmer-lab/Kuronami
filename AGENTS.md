# AGENTS.md

Dauerhafte Konventionen und Arbeitsregeln — die verdichtete Fassung für den Alltag beim
Codeschreiben.

**Stand 2026-09-20.** Am 18.09. wurde der eigene Ausführungsmotor durch das Claude Agent SDK
ersetzt, am 20.09. ist sein Code aus dem Baum geflogen (Archiv: `git checkout
archiv/eigener-motor`). `docs/ARCHITEKTUR.md` beschreibt in weiten Teilen diesen alten Aufbau
und ist damit **Historie, keine Anleitung** — verbindlich ist, was hier steht.

## Der Motor ist das Agent-SDK

`gateway/agent.ts` fährt jeden Zug über `query()` aus `@anthropic-ai/claude-agent-sdk`.
`gateway/core.ts` ist nur noch der Adapter dorthin; die Kanäle (Web, Telegram, Slack, Sprache)
kennen ausschließlich `receiveMessage`/`receiveDecision`/`redeliverPending`.

Neue Fähigkeiten kommen als **MCP-Server im Prozess** (`gateway/haus.ts`, `kurse.ts`,
`buehne.ts`, `postfach-werkzeuge.ts`) oder als Hausregel in `workspace/CLAUDE.md` — nicht als
neue Tool-Definition mit eigener Registry. Jedes Werkzeugschema kostet Token in **jedem**
Modellaufruf; die Grundlast steht unter Beobachtung (Jakobs Ziel: eine kurze Frage unter 2 ct).

Kuro arbeitet in `/opt/kuronami/workspace` (`KURO_WORKDIR`), nicht im Quellbaum.

## Das Personal läuft hinter einem einzigen Werkzeug

Die Bediensteten (`context/bedienstete.ts`) sind **keine** `agents`-Option des SDK: die wirkt
global, und `disallowedTools` hätte damit auch Kuros eigenen Katalog aufgebläht. Stattdessen
startet `gateway/haus.ts` hinter dem Werkzeug `beauftrage` je Auftrag einen eigenen `query()`
mit eigenem Prompt, Werkzeugkasten, Modell und Budget.

Text aus einem Bedienstetenlauf gehört nie ungefiltert in Kuros Antwort — auf
`parent_tool_use_id !== null` prüfen. Der letzte Textblock ist der Bericht, alles davor geht
als Fortschritt an die Oberfläche.

## Bash nur im Sandkasten

Die Bediensteten bekommen Bash **ausschließlich**, wenn `sandkastenLage()` beim Start trägt
(`gateway/sandkasten.ts`: bwrap, socat, verschachtelte Namensräume). Trägt sie nicht, fliegt
Bash aus dem Katalog — kein ungeschützter Lauf als root. `allowUnsandboxedCommands` bleibt
`false`, das Netz auf die Kursquelle beschränkt, `.env` und Zugangsdaten sind weder lesbar noch
in der Umgebung.

Eine Rückfrage, die im Hintergrund niemand beantworten kann, ist keine Sicherheit: `canUseTool`
gibt eine **Absage mit Begründung** zurück, damit der Lauf weiterarbeitet statt sich in
Umformulierungen zu verfangen.

## Jeder MCP-Server hat eine Risikostufe

`read`, `soft_write`, `hard_write` oder `destructive`. **Keine Vorgabe** für einen Server, der
keine angibt: eine geratene Stufe sieht aus wie eine entschiedene. Geprüft in
`runtime/mcp/config-store.ts`, weil eine Server-Konfiguration aus JSON entsteht und damit am
Compiler vorbeikommt. Die Stufe ist immer eine lokale Obergrenze — nie aus der Fernbeschreibung
eines Servers abgeleitet.

## Secrets laufen durch den Redaction-Filter

Jeder Weg, der fremden oder eigenen Text auf die Platte oder in den Modellkontext bringt, läuft
durch `redact`/`redactText` aus `runtime/redaction/`. Heute sind das die Berichte und
Fortschrittszeilen der Bediensteten (`gateway/haus.ts`, `handelstisch.ts`), die
Artefaktmetadaten und der Notiztext im Langzeitgedächtnis. Kommt ein weiterer dazu, wird er
dort angeschlossen — nicht mit einer eigenen Prüfung an der Aufrufstelle.

Der Gedächtnispfad ist der heikelste: eine Notiz mit einem Zugangsschlüssel läge nicht nur im
Klartext auf der Platte, sondern **dauerhaft in einer Git-Historie**, und sie käme bei jedem
thematisch verwandten Lauf erneut in den Modellkontext.

Ein Wert, der als Schlüssel wieder nachgeschlagen wird, darf vom Filter nicht verändert werden.
Passiert es doch, wird abgewiesen statt einen kaputten Schlüssel entstehen zu lassen.

Der Filter ist **nicht abschaltbar** und bekommt kein Flag. Die Reichweite ändert man über die
Musterliste in `runtime/redaction/patterns.ts`, also durch eine sichtbare Änderung an einer
versionierten Datei.

## Fehler nie verstecken oder glätten

Fehlgeschlagene Aktionen, Stacktraces und Ablehnungsgründe bleiben im Verlauf und im
Fehlertext erhalten. Kein Abfangen, das den Fehler in eine freundliche Zusammenfassung
verwandelt.

## Halbe Wege gibt es nicht

Wenn die Oberfläche etwas verlangt, wofür sie selbst keinen Weg anbietet, ist das ein Fehler
und kein dokumentiertes Verhalten. Den fehlenden Weg bauen, nicht den Hinweistext schärfen.
Eine Statuszeile sagt nie „Angenommen.", wenn nichts angenommen wurde.

## Schema-Änderungen nur über Migrationen

Nummerierte SQL-Dateien in `runtime/db/migrations/`, kein ORM. Keine manuellen
Schemaänderungen an der laufenden Datenbank.

## Ereignistypen nie umbenennen

Namensform `namensraum.vergangenheitsform`. Neue Ereignistypen kommen dazu, bestehende werden
nie umbenannt und nie in ihrer Bedeutung verändert — auch die nicht, die nur noch der alte
Bestand im Protokoll trägt.

## Konventionen hierher, Erkenntnisse ins Gedächtnis

Was **immer** gilt — Arbeitsregeln, Vorlieben, Dauerregeln — steht in dieser Datei. Was
**geschehen** ist und was daraus folgt, steht als Notiz in `memory/`: Ereignisse mit Folgen
für später, widerlegte Annahmen, Entscheidungen samt ihrem Grund. Festgemacht ist die Trennung
am Feld `art` einer Notiz, das genau zwei Werte kennt (`ereignis`, `erkenntnis`) und keinen
für eine Konvention.

**Nicht alles wird gespeichert.** Die meisten Läufe hinterlassen keine Notiz; das ist der
Normalfall und keine Panne.

Eine neue Notiz überschreibt nie eine alte. Widerspricht sie einer, wird das über `supersedes`
vermerkt und **beide bleiben stehen** — die Entscheidung, welche gilt, trifft der Leser mit
beiden Daten vor Augen, nicht der Speicher hinter seinem Rücken.

## Artefakte sind unveränderlich

Ein bestehender Artefaktname wird nie überschrieben, bei Kollision hängt der Speicher
`-2`, `-3` an.

## Jede Session endet mit einem Commit

Sobald `pnpm typecheck && pnpm lint && pnpm test` grün sind, wird committet — ohne
Rückfrage, ohne Ausnahme. Commit-Message im Format der bisherigen Historie. Kein
Zwischenzustand bleibt uncommittet liegen, auch nicht "bis zur nächsten Freigabe".

## Die Sprachschicht ist Python und bleibt hinter ihrer Prozessgrenze

`voice/` (seit S30) ist der einzige Python-Teil des Systems. Er importiert **nichts** aus
`gateway/`, `runtime/`, `tools/` oder `context/` und spricht mit dem Gateway ausschließlich
über den Sprach-Kanal (`POST /channels/voice/messages`). Umgekehrt kennt kein TypeScript-Modul
einen Pfad unter `voice/`. Das ist keine Stilfrage, sondern der Grund, warum Pipecat überhaupt
zulässig ist — eine Prozessgrenze, kein zweiter Stack im Kern.

Python läuft nicht auf dem Entwicklungsrechner, sondern im Container. Auch die Tests:

```
docker compose run --rm voice-test
```

## Testbefehl

```
pnpm install && pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test` läuft seit 2026-09-20 wieder über **alles** im Baum (`**/*.test.ts`, ohne `voice/`).
Die lange Ausnahmeliste in `vitest.config.ts` gehörte zu den Tests des alten Motors; die sind
mit ihm gelöscht. Ein Test, der still nicht läuft, ist schlimmer als keiner — wer eine neue
Ausnahme einträgt, begründet sie dort.

Gateway-Codeänderungen brauchen `systemctl restart kuronami-gateway` (tsx, kein Watch); die
Oberfläche (`kuronami-ui`) transpiliert im Zugriff.

## Codestil

TypeScript, strict, ESM, NodeNext, Node 24 LTS. Biome für Lint und Format, kein ESLint,
kein Prettier. Kein ORM. pnpm als Paketmanager, vitest als Testrunner.

Kommentare erklären das **Warum**, auf Deutsch, in ganzen Sätzen. Ein Verweis auf eine Datei,
die es nicht mehr gibt, ist ein Fehler wie ein toter Import.
