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

## S02 · Postgres-Schema · 2026-09-05

- Eigenes Postgres-Schema `kuronami` (getrennt von `public`/Dashboard) mit fünf Tabellen:
  `sessions`, `tasks`, `steps`, `artifacts`, `approvals`.
- Acht Enum-Typen angelegt, darunter `kuronami.task_status` mit exakt den acht
  Statuswerten aus der Architektur (`queued`, `ready`, `in_progress`, `blocked`,
  `awaiting_user`, `done`, `canceled`, `failed`). `approvals` ist im Datenmodell der
  Architektur nicht als JSON-Beispiel hinterlegt, Felder wurden aus Abschnitt 10
  (Risikostufen, Freigabepfad, Session-Freigabe-Speicherung) abgeleitet.
- Indizes auf `session_id`, `status`, `created_at` überall, wo die Spalte existiert;
  bei `artifacts.source` (jsonb) per Ausdrucksindex auf `source ->> 'session_id'`.
- Migrationswerkzeug `runtime/db/migrate.ts` (kein ORM, nutzt `pg`): liest nummerierte
  SQL-Dateien aus `runtime/db/migrations/`, führt sie transaktional aus, Buchführung in
  `public.kuronami_schema_migrations` (bewusst außerhalb des `kuronami`-Schemas, damit ein
  vollständiges Down das eigene Protokoll nicht mitreißt). Aufruf über `pnpm migrate up`
  bzw. `pnpm migrate down` (optional `--all`).
- Migration `0001_init` getestet: Up (alle 5 Tabellen, 8 Typen, 17 Indizes vorhanden,
  Enum-Constraint, Fremdschlüssel und jsonb-Defaults per Sanity-Insert geprüft), danach
  Down (Schema, Enum-Typen und Tracking-Zeile vollständig entfernt, per
  `pg_namespace`/`pg_type`-Abfrage verifiziert), danach erneut Up, damit die Datenbank im
  migrierten Zustand bleibt.
- `pnpm typecheck && pnpm lint && pnpm test` läuft grün.

Status: abgeschlossen. Nächste Session: S03 Ereignisprotokoll.

## S03 · Ereignisprotokoll · 2026-09-05

- Migration `0002_events` mit der Tabelle `kuronami.events` und exakt den sechs Feldern aus
  Abschnitt 4.4: `event_id` (PK), `session_id` (FK auf `kuronami.sessions`), `seq` (integer,
  dazu `CHECK (seq > 0)`), `type` (text), `payload` (jsonb, Default `'{}'`), `created_at`
  (timestamptz, Default `now()`).
- `type` ist bewusst `text` und kein Enum, also keine Abweichung zu dokumentieren: neue
  Ereignistypen kommen laufend dazu, ein Enum machte jeden neuen Typ zu einer Migration und
  damit zu einem Anreiz, lieber einen bestehenden Typ umzudeuten. Genau das verbietet die
  Architektur.
- Index auf `(session_id, seq)` ist der Lesepfad, wurde aber als UNIQUE angelegt: damit liegt
  die Lückenlosigkeit nicht nur in der Anwendungslogik, sondern strukturell in der Datenbank.
  Dazu `idx_events_created_at` nach dem Muster von S02.
- `seq`-Vergabe race-sicher in derselben Transaktion wie die Einfügung, in zwei Schichten:
  1. `SELECT ... FROM kuronami.sessions WHERE session_id = $1 FOR UPDATE` serialisiert alle
     Schreiber derselben Session. Die Sperre liegt auf der Session-Zeile, nicht auf den
     Ereignissen: auf einen Zeilenbereich, in den erst noch eingefügt wird, lässt sich keine
     Sperre halten, `FOR UPDATE` verhindert kein Phantom-Insert.
  2. Vergabe und Einfügung als eine einzige Anweisung
     (`INSERT ... SELECT coalesce(max(seq), 0) + 1 ... WHERE session_id = $2`).
  Sperrgranularität ist die Session, verschiedene Sessions schreiben weiter nebenläufig.
  Eine eigene Sequenztabelle je Session wurde verworfen: die Architektur nennt für Phase 1
  genau sechs Tabellen, eine siebte allein für Zähler wäre eine Abweichung ohne Gegenwert.
- `runtime/events/log.ts`: `appendEvent(pool, sessionId, type, payload)` in eigener
  Transaktion, `appendEventInTx(client, ...)` für Aufrufer, die bereits eine Transaktion
  offen haben, und `readEvents(pool, sessionId)` sortiert nach `seq`. Die zweite Variante
  existiert, weil ein Checkpoint laut Abschnitt 6 Ereignis und Snapshot in dieselbe
  Transaktion schreiben muss; benutzt wird sie erst ab S04. Abweichung von der
  Aufgabenstellung: der Pool ist erster Parameter statt Modul-Singleton, damit der
  Verbindungslebenszyklus beim Aufrufer bleibt.
- `runtime/db/pool.ts`: `createPool()` als Fabrik, bewusst kein Modul-Singleton.
- `runtime/events/types.ts`: die 27 Ereignistypen der Taxonomie als Konstante `EVENT_TYPES`
  und Union `EventType`, zwölf Namensräume. Dazu `assertEventType()`, das am einzigen
  Schreibtor die Namensform `namensraum.vergangenheitsform` prüft. Die Spalte bleibt offen,
  die Schreibweise nicht, sonst zerfällt ein Ereignis still in zwei Schreibweisen.
- `vitest.setup.ts` lädt `.env` über `process.loadEnvFile`, weil vitest kein Gegenstück zu
  `tsx --env-file` hat; eine bereits gesetzte `DATABASE_URL` gewinnt. Der Test wird bewusst
  nicht übersprungen, wenn keine Datenbank erreichbar ist: ein still übersprungener Test wäre
  ein grüner Lauf, der nichts beweist.
- `runtime/events/log.test.ts`, sieben Tests: Schreibreihenfolge gleich Lesereihenfolge,
  25 gleichzeitige Schreiber ergeben `seq` 1 bis 25 ohne Lücke und ohne Verlust, `seq` zählt
  je Session getrennt ab 1, alle 27 Taxonomie-Typen schreibbar, `payload`-Default, unbekannte
  Session wird abgewiesen, falsche Namensform wird abgewiesen. `runtime/health.test.ts` bleibt
  unverändert daneben stehen.
- Gegenprobe zum Nebenläufigkeitstest: mit entfernter `FOR UPDATE`-Sperre schlägt er fehl
  (`duplicate key value violates unique constraint "idx_events_session_seq"`). Der Test prüft
  also tatsächlich die Sperre und nicht nur sich selbst. Danach zurückgesetzt.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 8 Tests. Migration verifiziert: `down`
  (nimmt nur 0002 zurück, die fünf Tabellen aus S02 bleiben stehen), `down --all` (0002 vor
  0001, andernfalls scheiterte das `DROP SCHEMA` aus 0001), danach `up` für beide. Ergebnis
  geprüft: sechs Tabellen im Schema `kuronami`, beide Tracking-Zeilen (`0001`, `0002`), drei
  Indizes auf `events` (`events_pkey`, `idx_events_session_seq` UNIQUE,
  `idx_events_created_at`). Der Testlauf räumt seine Sessions und Ereignisse wieder ab.
- Bewusst nicht gebaut: der Redaction-Filter aus Abschnitt 4.7, der vor jedem Schreiben ins
  Protokoll laufen soll. Er gehört in die Governance-Schicht und braucht sie; bis dahin
  schreibt noch kein Runtime-Teil Ereignisse, die Secrets enthalten könnten. Offener Punkt
  für S11.
- `tasks.json`: S03 auf `done`, S04 von `queued` auf `ready`, weil dessen einzige
  Abhängigkeit jetzt erfüllt ist.

Status: abgeschlossen. Nächste Session: S04 Runtime-Skelett.

## S04 · Runtime-Skelett · 2026-09-05

- Migration `0003_session_identity` mit einem UNIQUE-Index auf `kuronami.sessions
  (thread_id, channel)`. Abweichung von der Aufgabenstellung, die nur ein neues Modul
  vorsah: Wiederfinden braucht einen Schlüssel, den ein neu gestarteter Prozess kennt, und
  das ist nicht die `session_id`. Ohne Index wäre "keine doppelte Session" eine Hoffnung
  auf die Reihenfolge zweier gleichzeitig startender Prozesse; mit ihm ist es eine Zusage
  der Datenbank, nach dem Muster von `idx_events_session_seq` aus S03. Zusammengesetzt und
  nicht allein auf `thread_id`, weil `channel` im Datenmodell ein Feld der Session ist:
  derselbe Faden auf zwei Kanälen sind zwei Sessions.
- `runtime/session/manager.ts`: `createOrResumeSession(pool, criteria)` legt an oder gibt
  die bestehende Zeile zurück. Pool als erster Parameter, kein Modul-Singleton, kein Cache
  — Muster aus S03 fortgesetzt. Der Zustand liegt ausschließlich in `kuronami.sessions`;
  im Speicher steht nur, was bei jedem Start neu von dort abgeleitet wird.
- Anlegen und Wiederfinden sind eine einzige Anweisung
  (`INSERT ... ON CONFLICT (thread_id, channel) DO NOTHING RETURNING ...`), bei Kollision
  gefolgt von einem `SELECT`. Ein vorgeschaltetes `SELECT` wäre ein Blick auf einen
  Zustand, der beim folgenden `INSERT` schon ein anderer sein kann: zwei gleichzeitig
  startende Prozesse fänden beide nichts und legten beide an. Der zweite Blick sieht die
  fremde Zeile verlässlich, weil der Konflikt auf deren Transaktion wartet und READ
  COMMITTED für jede Anweisung einen frischen Snapshot nimmt. Bleibt er trotzdem leer,
  fliegt ein Fehler statt eines stillen `undefined`.
- Zeile und Ereignis (`session.created` bzw. `session.resumed`) entstehen in derselben
  Transaktion, über `appendEventInTx` aus S03 — der erste Aufrufer dieser Funktion, wie
  dort angekündigt. Das ist ein Checkpoint im Sinne von Abschnitt 6: sonst gäbe es einen
  Moment, in dem die Session existiert, das Protokoll ihre Entstehung aber nicht kennt.
- `criteria` trägt neben `threadId` und `channel` ein verschachteltes `defaults`. Damit
  bleibt die Signatur `(pool, criteria)` und die Trennung steht im Typ statt nur im
  Kommentar: Startwerte gelten ausschließlich bei der Neuanlage. `model_profile` oder
  `tool_catalog_version` beim Wiederfinden zu überschreiben, bräche die Cache-Stabilität
  (Grundprinzip 2) und baute den Toolsatz mitten in der Session um (Anti-Muster 2).
  Startwerte selbst aus dem Session-Beispiel in Abschnitt 5 und aus Abschnitt 13.
- `runtime.started` und `runtime.stopped` in `EVENT_TYPES` ergänzt, ein dreizehnter
  Namensraum über die Taxonomie aus Abschnitt 4.4 hinaus. Begründung: die Taxonomie kennt
  nur den Lebenslauf der Session, nicht den des Prozesses, der sie bedient — und genau
  darin liegt das Ergebnis dieser Session. Ohne eigenen Namensraum wäre ein Neustart im
  Protokoll nicht von einer neuen Session zu unterscheiden. Die Zahl der Namensräume steht
  weiterhin fest im Test (12 → 13), damit ein neuer eine Entscheidung bleibt und nicht
  nebenbei entsteht.
- `startRuntime(pool, criteria)` liefert einen `RuntimeHandle` mit `stop()`. Die
  `runtimeId` benennt eine Prozess-Inkarnation und macht im Protokoll unterscheidbar,
  welcher Lauf welchen Eintrag geschrieben hat. `runtime.started` läuft bewusst in einer
  zweiten Transaktion: es ist eine Beobachtung über den Prozess, kein Session-Zustand.
  `stop()` schreibt nur beim ersten Aufruf, weil Signalbehandler doppelt kommen (SIGINT,
  danach SIGTERM) und zwei `runtime.stopped` zu einem Lauf eine Falschaussage wären. Das
  ist keine Schritt-Idempotenz — die gehört nach S05.
- `runtime/index.ts` ist vom Platzhalter zum lauffähigen Skelett geworden: Session
  aufnehmen, auf SIGINT/SIGTERM sauber stoppen. Kleine Erweiterung des Auftrags, aber ein
  Skelett, das man nicht starten kann, ist keins. Dazu `dev` auf
  `tsx watch --env-file=.env` (wie `migrate`, sonst fehlt `DATABASE_URL`) und ein
  `setInterval`-Anker: ohne ihn schlösse der Pool nach seinem Leerlauf-Timeout die
  Verbindungen, der Prozess endete von selbst und `runtime.stopped` bliebe ungeschrieben.
  Faden und Kanal kommen vorerst aus der Umgebung; woher wirklich, entscheidet S16.
- `runtime/session/manager.test.ts`, sieben Tests: Neustart über zwei unabhängige Pools
  liefert dieselbe `session_id` und genau eine Zeile; das Protokoll liest sich danach als
  `session.created, runtime.started, runtime.stopped, session.resumed, runtime.started,
  runtime.stopped` mit lückenloser `seq`; zehn gleichzeitige Starts ergeben genau ein
  `session.created` und neun `session.resumed`; verschiedene Fäden und verschiedene Kanäle
  bleiben getrennt; Startwerte greifen nur bei der Neuanlage; Vorgabewerte stimmen;
  doppelter Stop schreibt einmal. Der Testlauf räumt seine Sessions und Ereignisse ab.
- Zwei Gegenproben, beide danach zurückgesetzt. Ohne `ON CONFLICT` scheitern vier Tests an
  `duplicate key value violates unique constraint "idx_sessions_thread_channel"`, auch der
  Nebenläufigkeitstest — der erzeugt also echte gleichzeitige Kollisionen und läuft nicht
  zufällig serialisiert durch. Mit zurückgenommener Migration 0003 scheitern alle sieben an
  `there is no unique or exclusion constraint matching the ON CONFLICT specification`, der
  Code hängt also nachweislich am Index und nicht an einer Zufälligkeit.
- Nachweis außerhalb von vitest, weil ein einzelner Testprozess ein Modul teilt und einen
  versehentlichen Cache im Prozessspeicher nicht auffliegen ließe: dasselbe Skript in drei
  getrennten Betriebssystem-Prozessen (pid 7520, 6956, 21424) ergab dieselbe `session_id`,
  ein `session.created`, zwei `session.resumed`. Danach `runtime/index.ts` selbst zweimal
  gestartet, der zweite Lauf meldete "Session wiederaufgenommen" mit derselben Kennung.
  Probe-Sessions und -Ereignisse anschließend gelöscht.
- Nebenbefund, bewusst offen: ein hart abgeschossener Prozess schreibt kein
  `runtime.stopped` — beim Test unter Windows kam kein SIGINT an, im Protokoll blieb ein
  `runtime.started` ohne Gegenstück stehen. Genau dieser hängende Lauf ist der Fall, den
  S05 erkennen muss ("den letzten offenen Schritt finden und entscheiden, ob er wiederholt
  oder als fehlgeschlagen markiert wird"). Hier bewusst nicht behandelt.
- Bewusst nicht gebaut: Idempotenz- und Retry-Logik für Schritte, Wiederaufnahme mitten im
  Lauf, Abbruch. Das ist S05 und Abschnitt 6, hier ging es nur ums Überleben eines
  Neustarts.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 15 Tests. Migration verifiziert: `down`
  (nimmt nur 0003 zurück, die sechs Tabellen aus S02/S03 bleiben stehen, der Index
  verschwindet), danach `up` (Index wieder da, Tracking-Zeilen 0001, 0002, 0003).
- `tasks.json`: S04 auf `done`, S05 von `queued` auf `ready`, weil dessen einzige
  Abhängigkeit jetzt erfüllt ist.

Status: abgeschlossen. Nächste Session: S05 Wiederaufnahme und Abbruch.
