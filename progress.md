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
