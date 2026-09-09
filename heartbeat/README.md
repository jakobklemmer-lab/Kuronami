Hierhin gehört der Heartbeat: der Dienst für **proaktives Verhalten** (S17). Ein eigener Prozess (`pnpm heartbeat`), der die Runtime als Bibliothek benutzt und — wie das Gateway — nie von `runtime/`, `context/`, `tools/` oder `policy/` importiert wird (geprüft in `layering.test.ts`).

Zwei Auslöser:

- **Zeitplan** (`schedule.ts`) — ein Cron-Ausdruck (`HEARTBEAT_DIGEST_CRON`, Vorgabe `0 7 * * *`) stößt den **Morgen-Digest** an: eine Zusammenfassung aus Mail, Kalender, News und Servermetriken, abgelegt als Artefakt und über den bevorzugten Kanal zugestellt.
- **Ereignis** (`server.ts`, `POST /notify`) — eine neue Mail, eine Kalenderänderung oder ein Server-Alarm (von einem n8n-Workflow oder einem Monitoring-Hook gemeldet) startet einen Hintergrundlauf, der nachsieht und **nur dann** eine Nachricht schickt, wenn es etwas zu melden gibt.

Jeder dieser Läufe ist ein **Hintergrundlauf**: Session auf dem Kanal `heartbeat`, Modus `background`, ein Katalog mit engerer Whitelist und ein Regelsatz, der das Schreiben in die Quellzone — und damit ins Langzeitgedächtnis `memory/` — technisch zu `deny` macht (`policy/rules.ts`, `BACKGROUND_RULES`). Ein proaktiver Lauf liest und schlägt vor; ins Gedächtnis schreibt ein Mensch.

Eine **Tagesobergrenze** (`HEARTBEAT_MAX_RUNS_PER_DAY`, Vorgabe 8) deckelt die Läufe. Gezählt wird aus dem Protokoll einer eigenen Diarium-Session (`thread_heartbeat`), damit der Zähler einen Neustart überlebt.

Die Zustellung (`delivery.ts`) geht über Telegram (derselbe SDK-freie Client wie das Gateway) oder — ohne konfigurierten Kanal — auf die Konsole; der Digest liegt in beiden Fällen als Artefakt.
