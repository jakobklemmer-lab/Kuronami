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

## S05 · Wiederaufnahme und Abbruch · 2026-09-05

- Tests der Vorsession vorab gelaufen: 15 grün (health, events, session), unverändert.
- Migration `0004_step_idempotency` erweitert `kuronami.steps` um `idempotency_key`,
  `attempt`, `repeatable`, `result` und einen UNIQUE-Index auf
  `(session_id, idempotency_key)`. Abweichung von Abschnitt 6, die begründet werden muss:
  dort ist `step_id` der Idempotenzschlüssel. Das trägt nur, solange die Zeile schon
  existiert — nach einem Absturz leitet der neue Prozess seinen Plan neu ab und würfelte
  für dieselbe logische Arbeit eine neue `step_id`. Der Schlüssel muss aus der Arbeit
  folgen, nicht aus der Zeile. `step_id` bleibt die Identität der Zeile,
  `idempotency_key` wird die Identität der Arbeit; bestehende Zeilen bekommen im Up ihre
  eigene `step_id` als Schlüssel, für sie gilt die Lesart aus Abschnitt 6 also weiter.
  UNIQUE nach dem Muster von S03/S04: die Zusage liegt in der Datenbank.
- `repeatable` mit `DEFAULT false` in SQL (vorsichtige Seite: wer nichts sagt, bekommt
  keinen zweiten Seiteneffekt), aber als Pflichtfeld ohne Default in `StepSpec`. Ob ein
  unterbrochener Seiteneffekt wiederholt werden darf, ist eine Aussage über die Außenwelt.
  Nur die Aufrufstelle kann sie treffen; ein Default in TypeScript wäre genau das Raten,
  das Abschnitt 6 verbietet.
- `step.canceled` in `EVENT_TYPES` ergänzt. Kein neuer Namensraum, die Zahl 13 im Test aus
  S03 bleibt also stehen. Begründung: `kuronami.step_status` hat seit S02 den Wert
  `canceled`; ohne eigenes Ereignis wäre das der einzige Zustand, den der Snapshot tragen
  kann und das Protokoll nicht — und damit wäre der Snapshot nicht mehr aus dem Protokoll
  herleitbar (Abschnitt 4.4). `step.failed` dafür zu nehmen, hieße einen bestehenden Typ
  umzudeuten.
- `runtime/steps/hull.ts`, die Ausführungshülle: `beginStep` (Checkpoint vor dem
  Seiteneffekt), `finishStep` (Checkpoint danach), `executeStep` als Klammer mit
  Zeitfenster. Beide Hälften sind bewusst öffentlich und nicht in `executeStep` versteckt:
  ein abgestürzter Prozess ist genau der Fall, in dem nur der erste Checkpoint
  stattgefunden hat, und wer diesen Fall herstellen oder prüfen will, braucht sie einzeln.
- Zeile und Ereignis entstehen in beiden Checkpoints in derselben Transaktion, über
  `appendEventInTx` aus S03. Anlegen und Wiederfinden des Schritts ist wieder eine einzige
  Anweisung (`INSERT ... ON CONFLICT (session_id, idempotency_key) DO NOTHING`), bei
  Kollision gefolgt von `SELECT ... FOR UPDATE`.
- Die Sessionsperre aus S03 (`SELECT ... FROM sessions FOR UPDATE`) trägt jetzt eine zweite
  Bedeutung: wer den Schrittbestand einer Session ändert, hält sie. Eine Sperre je Session,
  damit es zwischen Schritt-Start, Wiederaufnahme und Abbruch keine Sperrreihenfolge zu
  beachten gibt.
- Ausgänge von `reclaimStep`, wenn der Schlüssel schon da ist: `completed` gibt das
  gespeicherte Ergebnis zurück, ohne den Effekt noch einmal auszulösen (das ist der Zweck
  des Schlüssels) und ohne ein Ereignis zu schreiben, weil sich nichts geändert hat.
  `running` wirft — von außen ist ein fremder Ausführer nicht von einem abgestürzten Lauf
  zu unterscheiden, und auflösen darf das nur `resumeSession`. `failed`/`pending` erlauben
  einen neuen Versuch, aber nur bei `repeatable` und nur bis `maxAttempts` (Vorgabe 3, also
  ein erster Versuch plus zwei Wiederholungen, das untere Ende von Abschnitt 13).
- Nicht wiederholbar heißt nicht wiederholbar, auch bei einem sauber geworfenen Fehler:
  auch ein Effekt, der eine Ausnahme wirft, kann vorher die Mail verschickt haben. Die
  Hülle unterscheidet nicht nach Fehlerart, weil sie es nicht kann.
- Zeitfenster je Schritt (Vorgabe 60 s aus Abschnitt 13) als Rennen zwischen Effekt und
  Timer, danach `step.failed`. Ein dabei gefundener Fehler, der ohne Test durchgerutscht
  wäre: `interrupt()` muss erst das Rennen ablehnen und dann `controller.abort()` rufen.
  Umgekehrt gewinnt ein Effekt, der auf sein Signal hört — `abort()` ruft seinen Zuhörer
  sofort auf, dessen Auflösung stünde vor der Ablehnung in der Warteschlange, und ein
  abgelaufenes Zeitfenster käme als ordentliches Ergebnis zurück. Wer aufs Signal hört,
  würde damit bestraft.
- Ein Timeout ist kein sauberer Fehler und wird auch nicht als einer protokolliert:
  JavaScript kann eine laufende Zusage nicht abschießen, der Effekt läuft weiter. Deshalb
  trägt `step.failed` `effect_outcome: "unknown"` und `effect_still_running`. Der verlierende
  Zweig bekommt ein `.catch()`, sonst risse eine späte Ablehnung den Prozess ab.
- `runtime/session/lifecycle.ts`: `resumeSession(pool, id)` und
  `cancelSession(pool, id, reason)` — die geforderten `session.resume(id)` und
  `session.cancel(id)`, mit Pool als erstem Parameter wie überall seit S03.
- Wiederaufnahme findet die Schritte auf `running` und entscheidet über jeden: `repeat`
  oder `failed_final`, allein anhand der Zusage `repeatable` beim Start. Beide enden im
  Status `failed` — der Unterschied liegt nicht im Zustand, sondern darin, ob die Hülle
  einen neuen Versuch zulässt. "Wiederholen" heißt: darf wieder angefasst werden, nicht:
  wird jetzt heimlich noch einmal ausgeführt. Der Fehlertext benennt den unbekannten
  Ausgang statt ihn zu glätten.
- Abbruch wirkt über Prozessgrenzen ohne Signal: `beginStep` liest `session.canceled` in
  derselben Transaktion und unter derselben Sessionsperre, in der der Schritt entstünde.
  Ein Blick davor wäre eine Momentaufnahme mit einem Spalt, in den ein gleichzeitiger
  Abbruch fiele. Zusätzlich hat `RuntimeHandle` jetzt ein `signal`, das bei `stop()` bricht,
  damit ein Effekt im selben Prozess nicht bis zu seinem Zeitfenster weiterläuft.
- `finishStep` prüft bewusst **nicht** auf Abbruch: der Seiteneffekt ist dann trotzdem
  gelaufen. Überholt ein Abbruch einen laufenden Schritt, trägt sein Ausführer den
  tatsächlichen Ausgang nach und das Ereignis vermerkt `after_cancel`. Die Faltung nimmt
  das letzte Schritt-Ereignis. Das Protokoll behält recht, nicht der Abbruch.
- Zweiter Abbruch schreibt nichts (wie `stop()` in S04). Eine abgebrochene Session wird
  nicht wiederaufgenommen: das wäre keine Wiederaufnahme, sondern eine Übergehung der
  Nutzerentscheidung. Weiterarbeiten heißt neue Session.
- `runtime/session/state.ts`: `deriveSessionState(sessionId, events)` faltet das Protokoll
  zum Zustand, `replaySession(pool, sessionId)` liest und faltet. Dass ein Replay nichts
  nach draußen tut, ist keine Zusage der Sorgfalt, sondern eine Eigenschaft der Signatur —
  es gibt keinen Parameter, über den ein Effekt hereinkäme. Unbekannte Ereignistypen werden
  übersprungen, die Taxonomie wächst; ein Schritt-Ereignis ohne passendes `step.started`
  wirft, denn dann ist der Zustand wirklich nicht herleitbar.
- Damit Snapshot und Faltung exakt gleich ausfallen, setzt der zweite Versuch in der Hülle
  `result`, `error` und `ended_at` per SQL zurück, genau wie die Faltung bei `step.started`.
  Die Zeitstempel passen ohne Zutun: `now()` ist in Postgres die Transaktionszeit, und Zeile
  und Ereignis entstehen in derselben Transaktion — `created_at` der Zeile ist damit
  buchstäblich derselbe Wert wie `created_at` des ersten `step.started`.
- `readSessionState` liest die Schritte aus der Tabelle, den Sessionstatus aber aus dem
  Protokoll: `kuronami.sessions` hat dafür keine Spalte, Abschnitt 5 sieht keine vor. Die
  Aussage "Replay ergibt denselben Endzustand" trägt deshalb bei den Schritten ihr ganzes
  Gewicht — dort stehen zwei unabhängig geschriebene Wege nebeneinander (UPDATE gegen
  Faltung), beim Status nur einer. Der geforderte Test vergleicht beide ausdrücklich.
- Umbau an S04-Code, klein aber nötig: die Session-Typen sind nach `session/types.ts`
  gewandert (Manager und Lebenszyklus brauchen sie beide, und der Manager ruft den
  Lebenszyklus auf — lägen sie weiter im Manager, zeigten die Module aufeinander; die Typen
  bleiben aus `manager.ts` re-exportiert). Und `createOrResumeSession` läuft im
  Wiederfindungsfall jetzt über `resumeSessionInTx`, löst also die offenen Schritte mit auf.
  Damit gibt es nicht zwei Arten der Wiederaufnahme, von denen nur eine aufräumt — genau der
  in S04 offen notierte Punkt ist damit geschlossen.
- 20 neue Tests, zusammen 35. `runtime/steps/hull.test.ts` (9): Seiteneffekt läuft bei
  zweimal gleichem Schlüssel genau einmal und schreibt beim zweiten Mal kein Ereignis;
  hängender Schritt endet am Zeitfenster statt zu warten; Fehlertext samt Stacktrace steht
  in Zeile und Ereignis gleich; wiederholbarer Schritt bekommt Versuch 2 und verliert dabei
  den alten Fehler; nicht wiederholbarer Schritt wird abgewiesen; Obergrenze greift; nach
  Abbruch entsteht keine Schritt-Zeile mehr; ein offener Schritt wird nicht nebenbei
  übernommen; ein Signal von außen bricht den Effekt ab.
- `runtime/session/lifecycle.test.ts` (7) stellt den Absturz nicht nach, sondern führt ihn
  vor: `crash-mid-step.process.ts` läuft als eigener Betriebssystem-Prozess
  (`node --import tsx`, nicht über die pnpm-Hülle, die unter Windows eine .cmd ist und einen
  zweiten Prozess dazwischenstellte), beginnt einen Schritt, meldet ihn und wird vom Test
  mit `SIGKILL` abgeschossen. Innerhalb eines Testprozesses ließe sich das nicht ehrlich
  bauen — dort liefe immer noch ein `finally` oder wenigstens die Möglichkeit dazu.
  Geprüft: der Schritt bleibt auf `running`, das Protokoll endet auf einem `step.started`
  ohne Gegenstück, `resumeSession` entscheidet `repeat`, danach läuft derselbe Schlüssel als
  Versuch 2 durch, und die Ereignisfolge liest sich vollständig als
  `session.created, step.started, step.completed, step.started, session.resumed, step.failed,
  step.started, step.completed`. Das ist das Fertig-Kriterium der Session, mit einem Befehl
  nachweisbar. Dazu: nicht wiederholbarer Schritt bleibt nach dem Absturz liegen; die
  Wiederaufnahme über `thread_id` räumt genauso auf wie die über die Kennung; Abbruch
  schließt den laufenden Schritt; zweiter Abbruch schreibt nichts; abgebrochene Session wird
  nicht wiederaufgenommen.
- `runtime/session/replay.test.ts` (4), darunter der geforderte Test: ein Lauf mit sechs
  Dummy-Seiteneffekten über fünf Schritte — Erfolg, Fehlschlag mit zweitem Versuch,
  endgültiger Fehlschlag, Zeitfenster und ein Aufruf auf einen schon fertigen Schlüssel.
  Danach Zähler auf null, Replay, Ergebnis: Endzustand identisch (`toEqual` über den ganzen
  Zustand, zusätzlich gegen den reinen Tabellen-Snapshot), Zähler bleibt bei null. Absichtlich
  nicht nur der Sonnenschein-Pfad: gerade Fehlschlag, Wiederholung und Zeitfenster sind die
  Stellen, an denen Snapshot und Protokoll auseinanderlaufen könnten. Dazu: zweimaliges
  Replay ergibt dasselbe (Abschnitt 6, Regel 2), abgebrochener Lauf ebenso, und eine
  Gegenprobe, die die Schritt-Zeilen löscht — die Herleitung liefert danach unverändert
  dasselbe, der Snapshot ist also wirklich entbehrlich und das Protokoll nicht.
- Sechs Gegenproben, alle bestätigt und danach zurückgesetzt. Ohne `result` im
  `step.completed`-Ereignis scheitert der Replay-Vergleich (der Test hängt also am Inhalt des
  Protokolls, nicht an sich selbst). Ohne die Abbruchprüfung in `beginStep` startet ein
  Schritt nach dem Abbruch. Mit unendlichem Zeitfenster hängt der Test und fällt erst nach
  5000 ms in den vitest-Timeout — genau das Verhalten, das die Session beseitigen soll. Ohne
  die `repeatable`-Sperre wird der nicht wiederholbare Schritt wiederholt. Ohne den
  UNIQUE-Index scheitern vier Tests an `there is no unique or exclusion constraint matching
  the ON CONFLICT specification`. Löst die Wiederaufnahme die offenen Schritte nicht auf,
  scheitern die drei Absturz-Tests.
- Migration verifiziert: `down` (nimmt nur 0004 zurück, `steps` steht wieder mit den zehn
  Spalten und vier Indizes aus S02 da), danach `up` (vierzehn Spalten, fünf Indizes, davon
  `idx_steps_session_idempotency` UNIQUE, Tracking-Zeilen 0001 bis 0004).
- Nachweis außerhalb von vitest: `runtime/index.ts` zweimal gestartet, der erste Lauf hart
  abgeschossen. Protokoll danach `session.created, runtime.started, session.resumed,
  runtime.started` — dieselbe Session, zwei Läufe, und das fehlende `runtime.stopped` des
  abgeschossenen Laufs steht weiterhin sichtbar da statt beschönigt zu werden. Probedaten
  gelöscht, die Tabellen sind nach dem Testlauf leer.
- Bewusst nicht gebaut: die Schleife über Schritte samt Wiederholungsstrategie und Backoff
  (S12 — hier steht nur die Obergrenze), `artifact_refs` in den Schritt-Ereignissen (S06;
  die Faltung liest sie schon mit Vorgabe `[]`, und der Replay-Test schlägt fehl, sobald S06
  die Spalte füllt, ohne das Ereignis mitzuziehen), Schreiber für `session.completed` und
  `session.failed` (S12; die Faltung kennt sie bereits), der Redaction-Filter aus Abschnitt
  4.7 (weiterhin offen für S11 — die Fehlertexte enthalten jetzt Stacktraces mit absoluten
  Pfaden, der Punkt wird damit dringender).
- Zwei offene Befunde, bewusst so stehen gelassen. Erstens: `StepCanceledError` in der Hülle
  ist derzeit nicht erreichbar, weil nur `cancelSession` Schritte abbricht und dabei immer
  auch die Session abbricht — `beginStep` wirft dann schon vorher. Der Zweig bleibt trotzdem
  drin, weil der Typ den Zustand zulässt: fiele er weg, geriete ein abgebrochener Schritt in
  den Wiederholungszweig, sobald irgendwann ein einzelner Schritt ohne die Session
  abgebrochen wird (S10/S11). Zweitens: `pending` ist als Schritt-Status zurzeit unerreichbar,
  weil die Hülle Zeilen direkt auf `running` anlegt; der Wert stammt aus S02 und wird erst mit
  einem geplanten Schrittbestand (S12) gefüllt.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 35 Tests.
- `tasks.json`: S05 auf `done`, S06 von `queued` auf `ready`.

### Nachtrag nach Review (Commit b17bc94)

- Die feinere Unterscheidung "Fehler vor Seiteneffekt" gegen "Fehler nach Seiteneffekt"
  wäre kein verfeinertes `repeatable`, sondern ein zweiter Vertrag: der Schritt selbst
  müsste sie melden, von außen sehen beide Fälle identisch aus. Erst dann anfassen, wenn
  sich zeigt, dass die manuelle Eskalation aus S10/S11 häufig auf Fälle anspringt, die
  tatsächlich "sicher vor Effekt" waren.
- `StepCanceledError` bleibt, jetzt mit einem Kommentar im Code statt nur hier: das Risiko
  ist nicht der unerreichbare Zweig, sondern dass die Kaskade "Abbruch geht immer über die
  Session" nirgends erzwungen wird. Sie gilt allein durch die heutige Implementierung von
  `cancelSession`, nicht durch einen Typ und nicht durch die Datenbank — und genau daran
  bricht später eine neue Aufrufstelle, ohne dass jemand den Wiederholungspfad anfasst. Dazu
  der Test "startet einen einzeln abgebrochenen Schritt nicht neu": er setzt die Zeile
  direkt auf `canceled`, ohne die Session abzubrechen, und hält damit das Verhalten fest,
  bevor es die Aufrufstelle gibt. Ohne den Zweig fällt der Schritt in den
  Wiederholungszweig und läuft noch einmal los — als Gegenprobe bestätigt.
- Keine `sessions.status`-Spalte. Der Vergleich bei den Schritten trägt, weil es dort zwei
  unabhängig geschriebene Repräsentationen gibt (UPDATE gegen Faltung), die auseinander
  laufen können. Beim Sessionstatus gibt es die zweite nicht, und ein Vergleich Log gegen
  Log prüfte nur, ob die Faltung deterministisch ist. Eine Spalte einzuführen hieße, sich
  die Fehlerklasse erst einzuhandeln, gegen die man dann prüft. Die Spalte wird richtig an
  dem Tag, an dem sie aus Leistungsgründen gebraucht wird — dann als mitgeschriebener
  Snapshot, Protokoll bleibt die Wahrheit, und der Vergleich hat wieder Sinn.
- Die eigentliche Fehlerfläche war stattdessen, dass `deriveSessionState` nur über die
  Datenbank lief und nie direkt. `runtime/session/state.test.ts` (10 Tests, ohne Datenbank)
  schließt das: Sessionstatus aus den `session.*`-Ereignissen, Schrittlauf von Start bis
  Abschluss, zweiter Versuch, überholter Abbruch (letztes Ereignis gewinnt),
  `artifact_refs` aus dem Ereignis, Überspringen unbekannter Typen, Sortierung samt
  Gleichstand, und zwei Fälle, in denen die Herleitung zu Recht wirft.
- Beim Gegenproben dieser Tests ein echtes Loch gefunden: das Zurücksetzen von `result`,
  `error` und `endedAt` bei `step.started` war durch keinen Test gedeckt. Trägt die Faltung
  den Fehler des ersten Versuchs weiter, fällt das nicht auf, weil das Terminalereignis des
  zweiten Versuchs ihn ohnehin überschreibt. Beobachtbar ist es nur in einem Fenster: ein
  Protokoll, das auf einem zweiten `step.started` ohne Gegenstück endet — also ein Absturz
  mitten im zweiten Versuch. Genau das prüft "zeigt einen laufenden zweiten Versuch ohne die
  Spuren des ersten" jetzt, und zwei Gegenproben (Fehler bzw. `ended_at` nicht geleert)
  scheitern daran.
- Fünf weitere Gegenproben zu den neuen Tests, alle bestätigt und zurückgesetzt.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 46 Tests.

Status: abgeschlossen. Nächste Session: S06 Artefaktspeicher.

## S06 · Artefaktspeicher · 2026-09-05

- Tests der Vorsession vorab gelaufen: 46 grün (health, events, session, steps), unverändert.
- `.gitignore`/`.claudeignore`: Zeile `artifacts/` auf `/artifacts/` verankert. Das Muster
  ohne führenden Schrägstrich fasst jedes Verzeichnis dieses Namens in jeder Tiefe — also
  auch das neue Quellverzeichnis `runtime/artifacts/`, das damit weder von git noch von
  Biome (`useIgnoreFile: true`) gesehen worden wäre (`git check-ignore` bestätigt:
  `.gitignore:6:artifacts/`). `/artifacts/` trifft nur noch die Ablage im Projektwurzel
  (`ARTIFACT_ROOT=./artifacts`), die weiterhin ignoriert bleibt. Beide Dateien synchron
  gehalten wie seit S01.
- Migration `0005_artifact_store` erweitert `kuronami.artifacts` (aus S02) um drei Zusagen,
  alle drei direkt aus dem Session-Auftrag:
  1. `size_bytes bigint NOT NULL CHECK (>= 0)`. `head()` soll Metadaten liefern, "ohne die
     Datei zu laden" — die Größe gehört dazu und darf deshalb nicht aus einem `stat()`
     stammen. `bigint`, weil ein Artefakt eine ausgelagerte Tool-Ausgabe ist (Abschnitt
     4.5) und die 2-GB-Grenze von `integer` grundsätzlich reißen kann.
  2. `summary SET NOT NULL` plus `CHECK (length(btrim(summary)) > 0)`. summary ist
     Pflichtfeld (Auftrag). Kein Backfill wie bei `idempotency_key` in 0004: für eine
     fehlende Zusammenfassung gibt es keinen richtigen Ersatzwert. Tabelle ist leer, der
     Constraint greift sofort. Der `btrim`-CHECK zusätzlich, weil `NOT NULL` den Leerstring
     durchließe.
  3. `source DROP DEFAULT` plus `CHECK (source ? 'tool' AND source ? 'session_id' AND
     source ? 'step_id')`. Herkunft (Tool, Session, Schritt) immer mitspeichern (Auftrag) —
     bisher nur Konvention des schreibenden Codes, jetzt eine Zusage der Datenbank, nach dem
     Muster von `idx_events_session_seq` (S03). `?` prüft Schlüssel-Präsenz, nicht den Wert:
     `step_id` darf JSON-null sein (ein Artefakt vor jedem Schritt), der Schlüssel muss
     dastehen. Der `DEFAULT '{}'` fällt weg, weil ein leeres `source` den CHECK verletzt —
     ein Default, der jede Einfügung sofort bricht, wäre nur eine Falle.
- **Abweichung von Abschnitt 4.5**, die begründet werden muss: die URI ist
  `artifact://<session_id>/<artifact_id>`, nicht `artifact://<namensraum>/<name>`. Die
  Ablage folgt 1:1: `<ARTIFACT_ROOT>/<session_id>/<artifact_id>`, die URI bildet durch
  reine Zeichenersetzung auf den Pfad ab ("auflösbar zu Dateipfad" im wörtlichsten Sinn).
  Gründe: (a) der Session-Auftrag schreibt `artifacts/<session_id>/<artifact_id>`
  ausdrücklich vor. (b) Der `<namensraum>` in den Beispielen der Architektur (`mail/`,
  `summary.md`) ist in Wahrheit der Namensraum des *Tools*, das die Bytes erzeugt — der
  Runtime-Primitiv darunter kennt keine Tool-Semantik, er kennt die Session und den
  Schritt. Diese Herkunft trägt `source` ohnehin; sie zusätzlich in den Pfad zu legen,
  koppelte den Speicherpfad an die Tool-Identität. (c) Die Unveränderlichkeit (Abschnitt
  4.5, AGENTS.md) wird dadurch *strenger*, nicht schwächer: `artifact_id` ist eine frische
  UUID je Schreibvorgang, ein Name kann strukturell nicht kollidieren. Die `-2`/`-3`-Regel
  war der Mechanismus, um Unveränderlichkeit unter *menschlich gewählten* Namen
  herzustellen; mit Maschinenkennungen gilt die Eigenschaft ohne den Mechanismus. Ein
  späterer Alias-Layer (S09 "große Antwort als Artefakt", S14 Mail) kann lesbare
  `artifact://mail/...`-URIs obendraufsetzen, die auf denselben physischen Speicher zeigen —
  das ist eine Ergänzung, keine Änderung an diesem Primitiv.
- `runtime/artifacts/store.ts`: `writeArtifact(pool, root, input)`,
  `readArtifact(pool, root, uri)`, `headArtifact(pool, uri)` — die geforderten
  `artifact.write/read/head`. `pool` als erster Parameter, kein Modul-Singleton (Muster seit
  S03); `artifactRootFromEnv()` als Fabrik wie `createPool`, die Wurzel bleibt beim
  Aufrufer, Tests zeigen sie auf ein Wegwerf-Verzeichnis. `artifact` ist kein Tool-Namensraum
  (nicht in der Liste von Abschnitt 4.8) — das hier ist die interne API des Speichers, die
  einheitliche Rückgabehülle ist Sache des Tool-Routers ab S07.
- `headArtifact` bekommt `pool` und die URI und **kein `root`**. Dass es die Datei nie
  öffnet, ist damit eine Eigenschaft der Signatur, kein Versprechen der Sorgfalt — dasselbe
  Muster wie `deriveSessionState` in `session/state.ts`. Genau das macht `head()` auch bei
  einem 5-MB-Artefakt billig: eine Zeilenabfrage, kein Dateizugriff.
- Schreibreihenfolge und ihr Grund: erst die Datei (als `.tmp`, `fsync`, dann `rename` auf
  den endgültigen Pfad), danach Zeile und Ereignis `artifact.created` in einer Transaktion
  (Checkpoint, Abschnitt 6). Bricht der Prozess dazwischen ab, bleibt eine Datei ohne Zeile
  liegen — folgenlos, kein Handle zeigt darauf, ein GC-Lauf kann sie abräumen. Die
  Umkehrung, eine Zeile ohne Datei, wäre ein Handle, das ins Leere auflöst. Das `rename`
  nach `fsync` sorgt dafür, dass am gültigen Pfad nie eine halb geschriebene Datei liegt.
  Vor dem ersten Dateizugriff steht eine Session-Existenzprüfung, damit ein ungültiger
  Aufruf nicht einmal ein leeres Verzeichnis hinterlässt.
- Kein Idempotenzschlüssel wie bei den Schritten (S05): jeder `writeArtifact`-Aufruf bekommt
  eine frische `artifact_id`, `uri` ist UNIQUE. Determinismus über Prozessgrenzen kommt
  hier nicht aus einem Schlüssel, sondern daraus, dass `writeArtifact` im echten Loop
  (S12) *innerhalb* eines Schritt-Effekts läuft — der Schritt ist idempotent, beim Replay
  wird sein gespeichertes `result` (mit der URI) zurückgegeben, ohne dass der Effekt neu
  läuft. Der Speicher selbst muss nicht deterministisch schreiben.
- SHA-256 wird beim Schreiben über die rohen Bytes gebildet und in der Zeile abgelegt.
  `readArtifact` bildet sie erneut und wirft `ArtifactIntegrityError` bei Abweichung —
  bewusst der Normalfall und nicht abschaltbar: eine stumme Differenz zwischen Prüfsumme
  und Datei wäre genau das Verstecken eines Fehlers, das AGENTS.md untersagt. Sollte das
  bei großen Artefakten (S09) zu teuer werden, ist das eine spätere, ausdrücklich zu
  begründende Ausnahme.
- `artifact.created` steht seit Abschnitt 4.4 in `EVENT_TYPES` — kein neuer Typ, kein neuer
  Namensraum, die Zahl 13 aus dem S03/S04-Test bleibt unberührt.
- `runtime/artifacts/store.test.ts`, 12 Tests: schreibt 5 MB und gibt ein Handle unter 100
  Zeichen zurück (Datei auf der Platte hat exakt 5 MiB, kein `.tmp` bleibt liegen, SHA
  stimmt mit einer unabhängig berechneten Prüfsumme überein); `head()` liefert nach dem
  Löschen der Datei weiterhin die vollständigen Metadaten, während `read()` auf derselben
  URI mit `ArtifactFileMissingError` scheitert — die Gegenprobe, die "ohne die Datei zu
  laden" erst belegt; `read()` gibt einen Binärpuffer mit Nullbytes bytegleich zurück;
  Zeile und `artifact.created` entstehen zusammen (letztes Ereignis, Payload trägt
  `artifact_id`, `uri`, `sha256`, `size_bytes`, `mime_type`, `summary`, `source`); die
  Herkunft steht vollständig und der Ausdrucksindex aus 0001 (`source ->> 'session_id'`)
  ist befüllt; ein schrittloser Ursprung (`step_id` null) wird angenommen und der CHECK
  trägt trotzdem; ein leeres `summary` wird abgewiesen, ohne Datei, Verzeichnis oder
  Ereignis zu hinterlassen (Gegenprobe: mit echter Zusammenfassung geht derselbe Aufruf
  durch); zwei Schreibvorgänge mit identischem Inhalt bekommen verschiedene Kennungen und
  bleiben beide lesbar (Unveränderlichkeit ohne `-2`/`-3`); eine nachträglich um ein Byte
  veränderte Datei fällt beim Lesen auf; eine wohlgeformte, aber nie vergebene URI wirft
  `ArtifactNotFoundError`; kaputte URIs (falsches Schema, fehlende Teile, drei Teile,
  `..`, Leerzeichen) werfen `ArtifactUriError` an der Grenze; ein Artefakt zu einer
  unbekannten Session wird abgewiesen, ohne ein Verzeichnis zu hinterlassen.
- Vier Gegenproben, alle bestätigt und danach zurückgesetzt:
  * `artifact_id` als Konstante statt `randomUUID()` → "eigene Kennung je Schreibvorgang"
    scheitert an `duplicate key value violates unique constraint "artifacts_pkey"`. Die
    Unveränderlichkeit hängt an der Datenbank, nicht daran, dass zufällig verschiedene
    Namen entstehen.
  * SHA-Prüfung in `readArtifact` deaktiviert → "erkennt eine veränderte Datei" scheitert,
    `read()` liefert die manipulierten Bytes zurück. Der Test hängt am Inhalt der Prüfung,
    nicht an sich selbst.
  * `parseArtifactUri`-Aufruf in `headArtifact` entfernt → "weist kaputte URIs ab"
    scheitert: `http://example.test/x` fällt bis zur Zeilenabfrage durch und kommt als
    `ArtifactNotFoundError` zurück statt als `ArtifactUriError`. Die Grenzprüfung trägt.
  * Session-Existenzprüfung entfernt → "unbekannte Session ohne Datei" scheitert: die
    Transaktion bricht zwar bei `appendEventInTx` ab und der Rollback räumt die Datei weg,
    aber das leere Session-Verzeichnis bleibt stehen.
- Migration verifiziert: `down` (nimmt nur 0005 zurück; `artifacts` steht wieder in exakt
  der S02-Form — `summary` nullbar, `source` mit `DEFAULT '{}'`, keine `size_bytes`-Spalte,
  Tracking-Zeilen 0001 bis 0004), danach `up` (acht Spalten, Constraints
  `artifacts_size_bytes_check`, `artifacts_summary_not_blank`, `artifacts_source_has_provenance`,
  Tracking-Zeile 0005). Die Datenbank bleibt im migrierten Zustand, die Tabellen sind nach
  dem Testlauf leer.
- Bewusst nicht gebaut: der Alias-Layer mit `artifact://<namensraum>/<name>` (S09/S14); die
  *Automatik*, ab der ein Tool-Ergebnis ausgelagert wird (Auslagerungsschwelle 8k–16k
  Token-Äquivalent, Abschnitt 4.5 — sie gehört in den Tool-Router bzw. das Kontext-System,
  S07/S09; hier steht nur der Speicher, in den sie schreibt); ein GC-Lauf für verwaiste
  Dateien nach einem Absturz zwischen `rename` und `COMMIT`; das Füllen von
  `steps.artifact_refs` bzw. der `artifact_refs` in Schritt-Ereignissen (S12 — `state.ts`
  liest sie seit S05 mit Vorgabe `[]`, der Replay-Test bleibt grün, solange niemand die
  Spalte ohne das Ereignis füllt); der Redaction-Filter aus Abschnitt 4.7 (weiter offen für
  S11, jetzt zusätzlich relevant, weil `artifact.created` `summary` und `source` ins
  Protokoll schreibt).
- `pnpm typecheck && pnpm lint && pnpm test` grün, 58 Tests.
- `tasks.json`: S06 auf `done`, S07 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S07 Tool-Router.

## S07 · Redaction-Filter (Nachzug) und Tool-Router · 2026-09-05

Zwei getrennte Arbeiten in einer Session. Teil 1 ist der Redaction-Filter aus Abschnitt 4.7,
seit S03 offen notiert und ursprünglich für eine eigene Session S05b vorgesehen, die
verworfen wurde (die Notion-Seite dazu ist archiviert: von ihren fünf Punkten waren vier
längst erledigt, nur der Filter fehlte wirklich). Teil 2 ist S07 nach Sessionplan. Die
beiden hängen an einer Stelle zusammen — der Router schreibt Tool-Eingaben und -Ergebnisse
ins Protokoll, und das ist genau der Pfad, den der Filter absichern muss —, sind sonst aber
unabhängig und stehen unten auch getrennt.

- Tests der Vorsession vorab gelaufen: 58 grün (health, events, session, steps, artifacts),
  unverändert.
- Der Startprompt zu S07 stand nicht im Sessionauftrag (Platzhalter blieb stehen) und wurde
  aus der Notion-Seite "S07 · Tool-Router" geholt.

### Teil 1 · Redaction-Filter

- `runtime/redaction/patterns.ts` und `runtime/redaction/redact.ts`, dazu
  `runtime/redaction/README.md`. **Abweichung von der eigenen Notiz aus S03**, die
  ausdrücklich revidiert wird: der Filter sollte "in die Governance-Schicht, und er braucht
  sie". Er braucht sie nicht, und er gehört auch nicht dorthin. Erstens trifft er keine
  Entscheidung — eine Policy hat Optionen (Allow/Deny/Ask, Risikostufen, Freigaben), dieser
  Filter hat prinzipiell keine. Zweitens sind zwei seiner drei Schreibtore selbst Runtime,
  und die Policy-Engine wird ab S11 umgekehrt Ereignisse schreiben und damit auf
  `runtime/events` zeigen; läge der Filter in `policy/`, zeigten beide Schichten
  aufeinander. `context/` darf auf `runtime/` zeigen, der dritte Aufrufer ist also auch
  bedient.
- **Nicht abschaltbar, und das ist die eigentliche Entscheidung.** Es gibt keinen Parameter,
  keine Umgebungsvariable, kein Flag und keine Fassung von `redactText`, die eine
  Ausnahmeliste entgegennähme. Ein Schalter wäre irgendwann gesetzt — beim Debuggen, "nur
  kurz", in genau dem Lauf, dessen Protokoll später jemand liest. Wer die Reichweite ändern
  will, ändert die Musterliste; das ist eine sichtbare Änderung an einer versionierten
  Datei, kein Aufrufargument.
- Drei Schreibtore, jedes an der Stelle, an der es keinen zweiten Weg vorbei gibt:
  `appendEventInTx` (das einzige Schreibtor von `kuronami.events`; `appendEvent` läuft
  hindurch), `writeArtifact` (`summary`, `mime_type`, `source`) und `buildPrompt`. Ein
  Filter, den jede Aufrufstelle selbst anwenden müsste, wäre in der ersten vergessenen Zeile
  umgangen.
- Zwei Wege zur Ersetzung, und beide werden gebraucht: über die **Form des Wertes**
  (`sk-ant-…`, `postgres://u:p@host`, JWT, PEM-Block, Bearer-Header, dazu die üblichen
  Anbieterpräfixe) und über den **Namen des Feldes** (`api_key`, `password`, `DATABASE_URL`).
  `{ "api_key": "hunter2" }` trägt kein erkennbares Format — über den Wert allein ist dieses
  Geheimnis nicht zu finden, wohl aber über den Namen, unter dem es abgelegt wurde. Die
  Gegenprobe unten belegt, dass beide Wege tragen.
- Rekursiv über verschachtelte Objekte und Arrays, nicht nur über Zeichenketten auf oberster
  Ebene: ein Ereignis-Payload ist ein Baum, und `result.structured.config.api_key` ist genau
  die Stelle, an der niemand nachschaut. Auch die Schlüssel eines Objekts werden gefiltert.
  Ein Zyklus wird erkannt und wirft, statt in einen Stapelüberlauf zu laufen — als JSON wäre
  der Wert ohnehin nicht schreibbar.
- **Bewusst nicht dabei: eine Entropie-Heuristik** ("lange Zeichenkette ohne Leerzeichen").
  Sie fräse genau die Felder weg, von denen das Protokoll lebt — SHA-256-Prüfsummen, UUIDs,
  Artefakt-Handles. Erkannt wird, was eine erkennbare Form hat. Aus demselben Grund enthält
  die Endungsliste der Feldnamen kein `key`: damit fiele `idempotency_key` mit hinein, der
  Schlüssel, an dem seit S05 die gesamte Wiederaufnahme hängt, und Replay bräche lautlos.
  Der Test "lässt die Felder in Ruhe, von denen das Protokoll lebt" hält das fest.
- Der Ersatztext benennt die Regel (`[redacted:anthropic-api-key]`) und lässt den Rest der
  Zeile stehen — bei einem Connection-String Schema und Benutzer, bei einem Header das
  Schema. Ein spurloses Löschen wäre die stille Variante, und ein Filter, der
  Fehlermeldungen unlesbar macht, wird über kurz oder lang abgeschaltet.
- Beim Bauen ein echter Fehler gefunden, der ohne Test durchgerutscht wäre: das
  Schlüssel-Wert-Fangnetz kaute auf schon gefiltertem Text weiter. `Authorization: Bearer
  <schlüssel>` wurde korrekt zu `… Bearer [redacted:authorization-header]`, danach nahm das
  Fangnetz das Wort `Bearer` als Wert und ersetzte es gleich mit. Kein Leck, aber der
  Ersatztext log über die Regel, die tatsächlich gegriffen hatte. Behoben mit drei
  Absicherungen um die Wertgruppe (kein Ansetzen auf einem Ersatztext, Wert muss an einem
  Trenner enden, nicht greifen wo dahinter schon gefiltert wurde) — die mittlere ist nötig,
  weil das Backtracking sonst `Bearer` still zu `Beare` kürzte und *das* ersetzte.
- `runtime/artifacts/store.ts`: Prüfung und Filter liegen jetzt zusammen in
  `assertWriteInput`, in dieser Reihenfolge — erst gilt die Pflicht, dann läuft der Filter.
  Umgekehrt käme eine Zusammenfassung durch, die nur aus einem Geheimnis bestand und nach
  dem Filter zufällig nicht mehr leer ist. `source.sessionId` wird als einziger Wert **nicht**
  ersetzt, sondern geprüft: er adressiert zusätzlich den physischen Pfad, und veränderte ihn
  der Filter, zeigte die Zeile woandershin als die Datei. Trifft ihn doch ein Muster, ist das
  ein Fehler und keine Stelle zum Weitermachen.
- **Die Bytes eines Artefakts laufen nicht durch den Filter**, und das ist eine bewusste
  Grenze, keine Lücke aus Versehen. Ein Artefakt ist die byteweise archivierte Wahrheit eines
  Tool-Laufs; der S06-Test schreibt einen Binärpuffer mit Nullbytes und liest ihn bytegleich
  zurück, und ein Textmuster über beliebige Bytes beschädigte genau diese Zusage samt der
  SHA-256-Kette. Der Schutz greift an der anderen Stelle: aus dem Speicher heraus führt in
  den Kontext kein Weg an `summary` und dem Handle vorbei, und wer die Bytes doch in ein
  Tool-Ergebnis hebt, schreibt sie über `appendEventInTx` und den Prompt-Aufbau — beide
  filtern. Dass ein Tool keine Secrets in ein Artefakt schreibt, bleibt damit eine Pflicht
  des Tools und ist ab S08 beim Bau der Kern-Tools mitzuprüfen. In Abschnitt 4.7 vermerkt.
- `context/prompt.ts` neu, weil es den dritten Pfad — "zusammengesetzter Prompt" — noch nicht
  gab. Bewusst klein: die fünf Abschnitte aus Abschnitt 7 in bindender Reihenfolge, ein
  einziges Filtertor (`render`), und die Kante zwischen stabilem Präfix (System-Prompt plus
  Tool-Stubs, Personengedächtnis) und veränderlichem Rest. Alle fünf Abschnitte stehen immer
  da, auch die leeren: ein Abschnitt, der mal fehlt und mal auftaucht, verschöbe den Text
  darunter und entwertete bei jedem Auftauchen den Cache. Tool-Stubs werden nach Namen
  sortiert, damit die Serialisierung nicht an der Aufrufreihenfolge hängt. Prompt-Caching,
  Kompaktierung (Stufen 2 bis 4) und das Umschreiben alter Tool-Ergebnisse in Referenzen sind
  **nicht** gebaut, das ist S09/S12.
- Strukturierte Inhalte werden **vor** dem Serialisieren gefiltert, nicht danach. Im fertigen
  JSON steht `"api_key": "hunter2"` — Feldname und Wert sind dort durch ein
  Anführungszeichen getrennt, ein Textmuster sähe kein Schlüssel-Wert-Paar mehr. Über den
  Baum gefiltert greift die Namensregel, über den Text nicht.
- 21 neue Tests. `runtime/redaction/redact.test.ts` (17, ohne Datenbank): jedes bekannte
  Format wird ersetzt und der Rest der Zeile bleibt lesbar; Connection-String verliert nur
  das Passwort; alle Vorkommen statt nur des ersten; der Filter ist wiederholbar (mehrere
  Tore hintereinander fressen den Text nicht weiter auf); PEM-Block im Ganzen; geheime
  Feldnamen in jeder Schreibweise; die Felder des Protokolls bleiben unberührt; Wert eines
  geheimen Feldes verschwindet unabhängig von seiner Form; `null` bleibt `null`; Rekursion
  durch Objekte, Arrays und Objektschlüssel; Zahlen, Datumsangaben und Bytes bleiben; ein
  geteilter Teilbaum ist erlaubt, ein Zyklus wirft; und ein echter Ereignis-Payload aus
  S05/S06 (Stacktrace mit absoluten Pfaden, SHA-256, Handle, Idempotenzschlüssel) kommt
  wörtlich unverändert heraus.
- `runtime/redaction/write-paths.test.ts` (4, mit Datenbank) ist der geforderte Nachweis. Er
  prüft nicht die Rückgabewerte der Schreibfunktionen, sondern was tatsächlich dasteht:
  `payload::text` aus `kuronami.events`, die Artefaktzeile als Text, der zusammengesetzte
  Prompt samt seiner einzelnen Abschnitte. Der vierte Test führt einen vollen Durchlauf
  (Artefakt schreiben, Ergebnis protokollieren, ins nächste Prompt heben) und stellt fest,
  dass derselbe Schlüssel in keinem der drei Pfade im Klartext auffindbar ist. Jeder Test
  prüft zusätzlich, dass das Unverdächtige noch dasteht — ein Filter, der alles ersetzt,
  bestünde die Hauptaussage sonst auch.
- Fünf Gegenproben, alle bestätigt und danach zurückgesetzt:
  * Filter in `log.ts` entfernt → 2 Tests rot (Ereignispfad und Volldurchlauf).
  * Filter in `store.ts` entfernt → 2 Tests rot. Nebenbefund: das Ereignis
    `artifact.created` blieb dabei sauber, weil das Protokoll sein eigenes Tor hat — die
    Zeile in `kuronami.artifacts` leckte. Die Tore sind also wirklich unabhängig.
  * Filter in `prompt.ts` entfernt → zunächst nur 1 Test rot. Der Volldurchlauf blieb grün,
    weil sein Prompt-Inhalt aus `readEvents` kam und damit stromaufwärts schon gefiltert war
    — der Prompt-Pfad war dort nur scheinbar mitgeprüft. Der Test speist jetzt zusätzlich
    rohe Eingabe ein; mit derselben Gegenprobe sind es danach 2 rote Tests.
  * Feldnamen-Regel entfernt → 3 Tests rot. `hunter2` unter `api_key` ist ausschließlich über
    den Namen erreichbar.
  * `g`-Flag eines Musters entfernt → das Modul lädt nicht mehr, `assertPatternsUsable`
    wirft beim Import. Die Zusage "jedes Muster ist global" hängt nicht an Sorgfalt.

### Teil 2 · S07 Tool-Router

- `tools/types.ts`, `tools/registry.ts`, `tools/router.ts`, `tools/offload.ts`,
  `tools/dummies.ts`. Keine Migration: S07 braucht keine Schemaänderung. `kuronami.steps`
  hat seit S02 `kind = 'tool_call'` und `tool_name`, `kuronami.risk_level` trägt seit S02
  genau die vier Risikostufen aus Abschnitt 10, und `sessions.tool_catalog_version` steht
  seit S02 bereit. Der Router füllt, was das Datenmodell längst vorsieht.
- **Jeder Tool-Aufruf läuft durch die Ausführungshülle aus S05.** Das ist die zentrale
  Entscheidung dieser Session: ein Tool-Aufruf *ist* ein externer Seiteneffekt, und für den
  verlangt Abschnitt 6 Checkpoint davor und danach. Damit bekommt jeder Aufruf ohne
  Zusatzarbeit Idempotenzschlüssel, Zeitfenster, Wiederaufnahme und Replay. Der Schlüssel ist
  `tool:<call_id>`: die Kennung, die später das Modell vergibt, und die ein
  wiederaufnehmender Prozess aus seinem Plan wieder herleitet. Das Ergebnis des Schritts ist
  die vollständige Rückgabehülle — deshalb liefert ein zweiter Aufruf mit derselben Kennung
  dieselbe Hülle zurück, ohne den Effekt noch einmal auszulösen.
- `repeatable` ist ein Pflichtfeld der Tool-Definition, ohne Vorgabewert, aus demselben Grund
  wie in `StepSpec` (S05). Es aus der Risikostufe abzuleiten wäre naheliegend und falsch: ein
  `soft_write` legt beim zweiten Lauf ein zweites Artefakt an. Das ist ein sechstes Feld über
  die vom Auftrag genannten fünf hinaus, und es fehlte sonst genau die Angabe, die die Hülle
  braucht.
- **Abweichung vom Auftrag bei den Ereignissen**, die begründet werden muss: die Checkliste
  nennt `tool.called` und `tool.returned`, geschrieben werden `tool.requested`,
  `tool.completed` und `tool.failed`. Diese drei stehen seit Abschnitt 4.4 in der Taxonomie
  und meinen dasselbe. `tool.called` daneben zu setzen hieße, das Protokoll in zwei
  Schreibweisen desselben Ereignisses zerfallen zu lassen — genau das, wogegen S03 die
  Namensprüfung eingebaut hat —, und `tool.returned` verlöre die Unterscheidung zwischen
  geglückt und fehlgeschlagen, die schon dasteht. In Abschnitt 4.4 vermerkt, damit die
  Notion-Checkliste sie nicht später doch noch einführt.
- Vier Ereignisse je Aufruf, geschachtelt: `tool.requested`, `step.started`, `step.completed`,
  `tool.completed`. Keine Doppelung, sondern zwei Schichten: `step.*` sagt, ob der
  Seiteneffekt lief und ob er wiederaufnehmbar ist; `tool.*` sagt, welche Fähigkeit mit
  welcher Risikostufe unter welcher Katalogversion angefragt wurde — das sind die Kennzahlen
  aus Abschnitt 12. Auch ein Aufruf auf ein Tool, das es nicht gibt, wird protokolliert;
  genau daraus besteht die Kennzahl "Tool-Auswahlgenauigkeit".
- Die `tool.*`-Ereignisse liegen **nicht** in der Transaktion des Schritts. Ein Absturz
  dazwischen hinterlässt ein `tool.requested` ohne Gegenstück, so wie seit S04 ein
  abgeschossener Prozess ein `runtime.started` ohne `runtime.stopped` hinterlässt. Das ist
  hinnehmbar, weil die maßgebliche Aussage — lief der Seiteneffekt oder nicht — im
  Schritt-Paar steht, und das ist transaktional. Die Alternative wäre, `finishStep` die
  Tool-Semantik beizubringen; dann wüsste die Ausführungshülle von Tools, und die
  Schichtung stünde auf dem Kopf.
- **Fehler kommen als Ergebnis zurück, nicht als Ausnahme**, mit einer einzigen Ausnahme.
  Unbekannter Toolname, Schema-Verstoß, geworfener Handler, Zeitüberschreitung und auch die
  Weigerung der Ausführungshülle, einen zweiten Versuch zuzulassen, werden zu
  `status: "error"` mit vollem Fehlertext samt Stacktrace in `structured.error` und einem
  maschinenlesbaren `structured.reason`. Das ist kein Verschlucken, sondern das Gegenteil:
  der Fehler landet im Verlauf, wo ihn das Modell im selben Lauf noch lesen kann
  (Abschnitt 7).
- Die eine Ausnahme, die **wirft**: die Session trägt eine andere Katalogversion als der
  aufrufende Prozess. Das kann das Modell mit keinem anderen Aufruf beheben; es ist die
  Aussage, dass dieser Prozess diese Session nicht bedienen darf. Dieselbe Trennlinie wie in
  der Hülle aus S05 — das Ergebnis eines Laufs kommt zurück, die Weigerung zu laufen fliegt.
  Die Weigerung der Hülle selbst fällt bewusst auf die andere Seite dieser Linie: für den
  Aufrufer des Routers ist auch sie eine Antwort auf seinen Aufruf, und `structured.refused`
  benennt die Lage maschinenlesbar, damit die Schleife (S12) einen Abbruch von einem
  erschöpften Wiederholungsbudget unterscheiden kann, ohne im Fehlertext zu suchen.
- **Die Katalogversion ist ein Fingerabdruck über den Inhalt**, nicht eine gepflegte
  Zeichenkette. Eine Version von Hand hochzuzählen wäre die Hoffnung darauf, dass es jemand
  tut; dann wäre "eingefroren" eine Zusage der Anwendungslogik statt eine überprüfbare
  Tatsache — dasselbe Argument wie beim UNIQUE-Index aus S03. Gerechnet wird über Name,
  Beschreibung, Eingabeschema, Risikostufe und Wiederholbarkeit, also über alles, wonach das
  Modell seinen Aufruf baut. Der Handler-Rumpf zählt **nicht** mit: eine Fehlerbehebung darin
  soll keine laufende Session ungültig machen. Registrierreihenfolge und Feldreihenfolge im
  Schema zählen ebenfalls nicht, beide Fälle sind getestet.
- Registry und Katalog sind getrennte Typen, und das Einfrieren steht damit im Typ statt im
  Kommentar: `ToolCatalog` hat keine schreibende Methode, `freeze()` kopiert. Wer danach noch
  registriert, ändert die Registry und nicht den ausgegebenen Katalog — getestet.
- Auslagerung (`tools/offload.ts`): gemessen wird die **vollständige serialisierte Hülle**,
  nicht der Rohinhalt und nicht das, wofür ein Tool sich selbst hält. Ein Tool, das seine
  Ausgabe für klein hält, sie aber nicht ist, wird trotzdem ausgelagert; Anti-Muster 3 lässt
  sich nicht dadurch vermeiden, dass man jedem Tool zutraut, sich selbst zu bremsen. Der Test
  "entscheidet an der gemessenen Größe, nicht am Tool" schickt dasselbe `dev.echo` einmal mit
  vier und einmal mit 40 KB durch.
- Ausgelagert wird `structured`, der einzige unbegrenzte Teil der Hülle. Zurück bleiben
  `summary`, `preview` und das Handle samt den Feldern, mit denen sich das Artefakt beurteilen
  lässt, ohne es aufzulösen — dieselben, die `headArtifact` seit S06 ohne Dateizugriff
  liefert. Passt die Hülle danach immer noch nicht unter die Schwelle, sind `summary` oder
  `preview` selbst zu groß: das ist ein Fehler des Tools und wird gemeldet, nicht durch
  stilles Kürzen geheilt. Eine gekürzte Zusammenfassung sähe aus wie eine echte, und das
  Modell hätte keine Möglichkeit zu merken, dass ihm etwas fehlt. Das Handle steht im
  Fehlertext, die Bytes sind also nicht verloren.
- Die Auslagerung läuft **innerhalb** des Schritts: sie braucht dessen `step_id` als Herkunft
  (S06), und ihr Artefakt gehört zum Ergebnis dieses Versuchs — bricht der Schritt danach ab,
  gehört auch das Artefakt zu dem, was nicht gilt. Im Protokoll steht `artifact.created`
  entsprechend zwischen `step.started` und `step.completed`, getestet.
- Schwelle 8000 Token-Äquivalent (unteres Ende von Abschnitt 13), vier Bytes je Token. Die
  Architektur sagt bewusst "Token-Äquivalent": der genaue Wert hängt am Tokenizer des
  jeweiligen Modells, und ihn hier exakt bestimmen zu wollen bände den Aktionsraum an ein
  Modell. Die Näherung schätzt für deutschen Text und trennzeichenreiches JSON eher zu
  niedrig, die Schwelle greift also eher zu spät — deshalb der Startwert am unteren Ende.
- Eingabeschema bewusst winzig und ohne Bibliothek (verschachtelte Schemata, Aufzählungen und
  Wertebereiche fehlen sichtbar). Geprüft werden Pflichtfelder, Typen und **unbekannte
  Felder**; letztere werden abgewiesen statt stillschweigend fallen gelassen. Sonst führte der
  Router einen Aufruf aus, den so niemand gemeint hat: das Modell glaubt, es habe `recursive`
  mitgegeben, das Tool hat es nie gesehen, und beide halten das Ergebnis für richtig. Es
  kommen immer *alle* Beanstandungen zurück, damit das Modell seinen Aufruf in einem Zug
  reparieren kann und nicht in fünf.
- Namensraum `dev` neu, mit Begründung in Abschnitt 4.8 (AGENTS.md verlangt sie in `docs/`)
  und in AGENTS.md nachgezogen. Die Registry prüft jeden Namen gegen die Liste, und eine
  Hintertür für Tests wäre dieselbe Hintertür für alles andere. `dev.*` gehört in keinen
  produktiven Katalog — festgehalten in beiden Dateien.
- `runtime/index.ts` baut jetzt einen Katalog (vorerst leer, echte Tools ab S08) und gibt
  dessen Version als Startwert an die Session. Trägt eine wiederaufgenommene Session eine
  andere Version, warnt der Start laut, statt es beim ersten Tool-Aufruf als Ausnahme zu
  offenbaren. Startwerte gelten weiterhin nur bei der Neuanlage (S04).
- 28 neue Tests, zusammen 107. `tools/registry.test.ts` (12, ohne Datenbank): Namensform und
  Namensraum, doppelter Name, fehlende Beschreibung; Version unabhängig von Registrier- und
  Feldreihenfolge, Version ändert sich bei Beschreibung, Risiko, Wiederholbarkeit, Schema und
  bei einem zusätzlichen Tool, bleibt aber bei einem geänderten Handler; ein ausgegebener
  Katalog bleibt von späteren Registrierungen unberührt; Stubs tragen keinen Handler; die
  Token-Näherung rechnet nach Bytes und ordnet 50 KB über und 200 Byte unter die Schwelle.
- `tools/router.test.ts` (16, mit Datenbank), darunter das **Fertig-Kriterium**: `dev.blob`
  mit 50 KB liefert `offloaded`, ein Handle und eine Hülle unter 1000 Byte, und das Handle
  löst auf die vollständigen Bytes samt korrekter Herkunft auf; `dev.echo` mit 200 Byte
  liefert direkt zurück, und es entsteht kein Artefakt. Dazu: die Hülle hat immer genau die
  fünf Felder aus Abschnitt 9, auch im Fehlerfall; die Ereignisfolge liest sich als
  `session.created, tool.requested, step.started, step.completed, tool.completed` und im
  ausgelagerten Fall mit `artifact.created` dazwischen; das Schritt-Ergebnis ist die Hülle,
  und der Replay aus dem Protokoll ergibt denselben Zustand wie der Snapshot; unbekanntes
  Tool nennt die vorhandenen; alle Schema-Verstöße auf einmal; falscher Feldtyp; geworfener
  Handler behält Wortlaut und Stacktrace; Zeitüberschreitung wird zur Fehlerhülle; ein nicht
  wiederholbares Tool läuft nach einem Fehlschlag kein zweites Mal, und die Weigerung kommt
  als Hülle mit `refused: "StepNotRepeatableError"`; derselbe Aufruf zweimal führt den Effekt
  einmal aus und meldet beim zweiten Mal `executed: false`; ein fremder Katalog und eine
  Session mit der Vorgabeversion `v1` werden abgewiesen, ohne ein Ereignis zu hinterlassen.
- Fünf Gegenproben, alle bestätigt und danach zurückgesetzt: Auslagerung nie (3 Tests rot,
  darunter das Fertig-Kriterium), Auslagerung immer (4 rot, darunter der 200-Byte-Fall — der
  Test hängt also an der Schwelle und nicht daran, dass irgendetwas ausgelagert wird),
  Katalogprüfung entfernt (2 rot), Schema-Prüfung entfernt (2 rot), Idempotenzschlüssel um
  einen Zufallswert erweitert (2 rot, der Seiteneffekt lief zweimal).
- Nachweis außerhalb von vitest: eine Probe hat gegen die echte Datenbank eine Session mit
  dem Katalog `v1-b71575f004d10d5e` eröffnet und beide Dummies aufgerufen. `dev.blob` mit
  50 KB ergab 525 Zeilen, ein Artefakt von 65478 Byte auf der Platte und eine Hülle, die nur
  Zusammenfassung, drei Vorschauzeilen und das Handle trug; `dev.echo` mit 180 Zeichen ergab
  eine Hülle von 370 Byte ohne Artefakt; `fs.read` (nicht im Katalog) kam als Fehlerhülle
  zurück, nicht als Ausnahme. Das Protokoll las sich über alle drei Aufrufe hinweg
  lückenlos. Danach `runtime/index.ts` zweimal gestartet: dieselbe Session, dieselbe
  Katalogversion; anschließend die Version der Session von Hand auf `v1` zurückgedreht, und
  der Start meldete die Abweichung wie vorgesehen. Probedaten gelöscht, alle sechs Tabellen
  sind nach dem Testlauf leer.

### Bewusst nicht gebaut

- Die Policy-Engine. Ihr Platz im Router steht fest und ist im Code vermerkt: zwischen
  Schema-Prüfung und `executeStep` — nach der Prüfung steht fest, *was* aufgerufen würde, und
  vor dem Schritt ist noch nichts geschehen. Der Router ruft sie dann, nicht umgekehrt
  (Abschnitt 4.7). S11.
- Echte Tools. `fs.*` ist S08, `web.*` S09; der Katalog in `runtime/index.ts` ist deshalb
  vorerst leer.
- Das Füllen von `steps.artifact_refs`. Es bleibt bei der Einschätzung aus S06 (S12): die
  Spalte ist jetzt zwar erreichbar — ein ausgelagerter Aufruf erzeugt Handles —, aber sie zu
  füllen verlangt, dass die Ausführungshülle die Referenzen eines Ergebnisses erkennt, und
  damit wüsste sie von Tool-Hüllen. Verloren geht nichts: die Handles stehen in der Hülle,
  die Hülle ist das `result` des Schritts, und das steht im `step.completed`. Wer die Spalte
  füllt, muss sie im selben Zug ins Ereignis schreiben, sonst laufen Snapshot und Herleitung
  auseinander — der Replay-Test in `session/replay.test.ts` fängt das ab.
- Prompt-Caching, Kompaktierung und das Umschreiben alter Tool-Ergebnisse in Referenzen
  (Kontextstufen 2 bis 4). `context/prompt.ts` markiert nur die Kante zwischen stabilem
  Präfix und veränderlichem Rest. S09/S12.
- Der Alias-Layer `artifact://<namensraum>/<name>` (S09/S14) und ein GC-Lauf für verwaiste
  Artefaktdateien, beides seit S06 offen.
- Die Schleife über Schritte samt Wiederholungsstrategie und Backoff (S12). Der Router führt
  einen Aufruf aus, er plant keine Folge von Aufrufen.

### Offene Befunde

- `structured.reason` und `structured.refused` sind heute eine Verabredung zwischen Router und
  künftiger Schleife, kein Typ. Sobald S12 darauf verzweigt, gehören sie in eine Aufzählung.
- Die Katalogversion einer Session lässt sich nach der Neuanlage nicht mehr ändern, und das
  ist so gewollt. Es heißt aber auch: nach jeder Änderung am Toolsatz sind alle laufenden
  Sessions unbedienbar. Für einen Einzelnutzer ist das richtig; ab S16 (zwei Kanäle) ist zu
  entscheiden, ob es dafür einen ausdrücklichen Migrationspfad braucht statt "neue Session".
- `pnpm typecheck && pnpm lint && pnpm test` grün, 107 Tests.
- `tasks.json`: S07 auf `done`, S08 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S08 Kern-Tools `fs.*`.

## S08 · Kern-Tools `fs.*` · 2026-09-07

- Tests der Vorsession vorab gelaufen: 107 grün (health, events, session, steps, artifacts,
  redaction, tools/registry, tools/router), unverändert.
- Keine Migration. `kuronami.artifacts` nimmt seit S06 `source.tool` als beliebige
  Zeichenkette, `fs.read` schreibt seine ausgelagerten Dateien darüber als `"fs.read"` weg.
  `fs.*` braucht keine Tabelle und keine Spalte, die nicht schon dasteht — wie bei S07.
- Neues Verzeichnis `tools/fs/` mit `paths.ts` (Pfadabsicherung), `tools.ts` (die fünf
  Definitionen und Handler), je einer Testdatei und `README.md`. Die Absicherung liegt
  **getrennt** von den Tools und hat eine eigene Testdatei ohne Datenbank: ein Leck dort ist
  ein Leck im ganzen Assistenten, und es soll sich in Millisekunden gegenprüfen lassen, ohne
  dass erst eine Postgres-Verbindung stehen muss.

### Die harte Pfadabsicherung (`paths.ts`)

- **Zwei Zonen, beide mit absoluter, per `realpath` aufgelöster Wurzel.** `artifact` ist der
  `ARTIFACT_ROOT` und frei beschreibbar — das ist der Arbeitsspeicher aus Abschnitt 8,
  Risikostufe weiches Schreiben "automatisch im Arbeitsverzeichnis" (Abschnitt 10). `source`
  ist die Workspace-Wurzel und nur lesbar. Der Auftrag sagt "Quellzone nur mit Freigabe";
  die Freigabe erteilt die Policy-Engine (S11), und weil es die noch nicht gibt, heißt das
  heute schlicht: `fs.write`/`fs.edit` in die Quellzone werfen `SourceZoneWriteError`. Der
  Router hat den Platz für die Policy-Prüfung seit S07 markiert; kommt sie, läuft sie *vor*
  diesem Wurf und kann eine erteilte Freigabe durchreichen. Eine halbe Freigabe-Mechanik
  jetzt zu bauen, kollidierte mit S11 (dessen Fertig-Kriterium wörtlich "Schreibendes Tool
  wird ohne Freigabe blockiert" ist).
- **`realpath` auf die Wurzeln, nicht nur `path.resolve`.** `os.tmpdir()` ist unter Windows
  und macOS selbst ein Symlink (`/var` → `/private/var`). Ohne die Kanonisierung vergliche
  die Containment-Prüfung einen aufgelösten Ist-Pfad gegen eine nicht aufgelöste Wurzel und
  wiese in den Tests jeden gültigen Pfad ab. Die Artefaktzone wird bei Bedarf angelegt (sie
  gehört uns), die Quellzone nicht — fehlt sie, ist die Konfiguration falsch.
- **Zwei Prüfungen in `resolvePath`, in dieser Reihenfolge.** Erst lexikalisch: `path.resolve`
  gegen die Quellzonen-Wurzel, dann `contains()` über `path.relative` (fängt `..`, fängt ein
  anderes Laufwerk unter Windows). Diese erste Prüfung fängt `../../etc/passwd` auch dann,
  wenn nichts davon existiert, und hält `realpath` von Pfaden fern, die ohnehin außerhalb
  liegen. Dann symlink-bewusst: `realpath` auf den **tiefsten existierenden Vorfahren**, der
  noch nicht existierende Rest wird unverändert wieder angehängt, und `contains()` läuft
  erneut über das Ergebnis. Ein Pfad, der eben noch drin lag, kann über einen Symlink nach
  draußen zeigen — genau der zweite S08-Test.
- Der tiefste-Vorfahr-Trick ist nötig, weil `fs.write` auf eine **neue** Datei zielt: `realpath`
  auf den vollen Pfad wirft dann `ENOENT`, und die Symlink-Auflösung fände nicht statt. Die
  Rekursion steigt komponentenweise auf, bis `realpath` greift, und setzt den Pfad wieder
  zusammen. Ein Symlink *mitten* im Pfad (`<zone>/link/darunter/neu.txt`) wird damit genauso
  enttarnt wie einer an der Spitze.
- **Die Einstufung folgt dem aufgelösten Ziel, nicht dem Eingabepfad.** Ein Symlink aus der
  Quellzone in die Artefaktzone wird zu `artifact` (frei) — harmlos, das ist die freie Zone.
  Ein Symlink aus der Artefaktzone zurück in die Quellzone wird zu `source` (nur lesbar) und
  **schützt** damit die Quellzone: der Versuch, über ein Link in der freien Zone Quellcode zu
  überschreiben, landet im Verweigerungszweig. Beide Fälle sind in `paths.test.ts` festgehalten.
- Bei verschachtelten Zonen (im Betrieb liegt `ARTIFACT_ROOT` unter der Workspace-Wurzel)
  gewinnt die speziellere: die `ordered`-Liste ist absteigend nach Wurzeltiefe sortiert, und
  `classify` nimmt den ersten Treffer. Ein Pfad unter `artifacts/` ist damit `artifact` und
  nicht `source`.
- `buildFsZones` wirft, wenn Quell- und Artefaktzone dieselbe Wurzel hätten — sonst wäre die
  Quellzone über den Umweg der Artefaktzone frei beschreibbar.

### Die fünf Tools (`tools.ts`)

- `createFsTools({ pool, artifactRoot, zones })` gibt die fünf `ToolDefinition` mit ihren
  Abhängigkeiten in den Handlern geschlossen zurück. Der `ToolInvocation` aus S07 trägt nur
  `input`, `sessionId`, `stepId`, `attempt`, `signal` — Pool und Wurzel kommen über die
  Closure, nicht über einen neuen Parameter der Handler-Signatur.
- **`fs.read`**: kleine Dateien (Slice ≤ 64 KB und ≤ 2000 Zeilen und deckt die ganze Datei)
  kommen als `structured.content` unverändert zurück. Alles darüber wird zu Ausschnitt (40
  Zeilen, je auf 400 Zeichen gekürzt) plus einem Artefakt mit den **Rohbytes** der Datei —
  `readArtifact` gibt sie bytegleich zurück, nicht JSON-verpackte Zeilen. Der Auftrag sagt
  "Ausschnitt + Artefakt", und das heißt beides: der Ausschnitt bleibt sichtbar *und* die
  vollständige Datei ist über das Handle da. Die Selbst-Auslagerung läuft **im Schritt** (wie
  die Router-Auslagerung aus S07), weil sie die `step_id` als Herkunft braucht (S06) — im
  Protokoll steht `artifact.created` zwischen `step.started` und `step.completed`.
- Sich allein auf die Router-Auslagerung zu verlassen, hätte den Ausschnitt gekostet: der
  Router verschiebt *ganz* `structured` ins Artefakt und lässt nur `summary`, `preview` und
  das Handle stehen. Der Ausschnitt käme dann höchstens über `preview` durch, ungetypt. Die
  `fs.read`-Hülle ist stattdessen von vornherein knapp (Kontextstufe 0) und bleibt mit ~3 KB
  deutlich unter der Router-Schwelle von 8k Token — der Test prüft ausdrücklich, dass **kein
  zweites** Offload passiert (`structured.offloaded` bleibt `undefined`).
- `fs.read` gibt den `sha256` der Datei zurück. Den braucht `fs.edit`, und weil die
  `fs.read`-Hülle bei großen Dateien nicht ausgelagert wird, steht er auch dann inline da.
- Binärdateien (Nullbyte in den ersten 8 KB) werden nicht in Zeilen zerlegt, sondern ganz
  ins Artefakt geschrieben, `structured.binary: true`, `preview` leer.
- **`fs.write`**: atomar über `.tmp` + `fsync` + `rename` (Muster aus S06), nur in der
  Artefaktzone. `repeatable: true` — ein unterbrochener Schreibvorgang mit denselben Bytes
  ist der klassische gefahrlos wiederholbare Fall, der Rename hinterlässt keinen
  Zwischenzustand. Optional `expect_absent`, um ein versehentliches Überschreiben abzufangen.
- **`fs.edit`**: `expected_sha256` ist **Pflichtfeld** ohne Vorgabe. Ein optionaler
  Stale-Check wäre einer, den man weglässt — und dann ist er weg. Der SHA-256 kommt aus dem
  letzten `fs.read`; weicht der aktuelle ab, wirft `StaleFileError` mit beiden Prüfsummen im
  Text, und die Datei bleibt unangetastet. Danach exakte Teilstring-Ersetzung mit
  Eindeutigkeitsprüfung (mehr als ein Vorkommen ohne `replace_all` → `EditTargetAmbiguousError`).
  `repeatable: false`: nach einem Abbruch ist unklar, ob der Edit schon angewandt wurde, und
  ein zweiter Lauf träfe auf einen geänderten SHA-256 oder ein fehlendes `old_string` — diese
  Lage entscheidet die Wiederaufnahme (S05), nicht die Hülle. Dieselbe Trennlinie wie bei den
  nicht wiederholbaren Schritten aus S05.
- **`fs.search`**: regulärer Ausdruck (JavaScript-Syntax), Treffer als `{ path, line, text }`
  mit 1-basierter Zeilennummer, Zeile auf 240 Zeichen gekürzt — **nie ganze Dateien**.
  Obergrenzen: 200 Treffer gesamt, 50 je Datei, 5000 Dateien; `.git` und `node_modules` und
  Symlinks werden ausgelassen. Ein kaputter Ausdruck kommt als Fehlerhülle zurück, nicht als
  Ausnahme. ReDoS ist für ein Ein-Nutzer-System mit dem 60-s-Zeitfenster als Fangnetz
  hinnehmbar; die Musterlänge ist auf 1000 Zeichen begrenzt.
- **`fs.list`**: Einträge mit Typ (`file`/`dir`/`symlink`/`other`) und Größe. Symlinks werden
  **gemeldet, aber nie betreten** — ein Symlink-Verzeichnis, in das hineingelaufen würde, wäre
  ein Weg an der Zonenprüfung vorbei. `recursive` optional, mit denselben Prune-Regeln wie
  `fs.search`, Obergrenze 2000 Einträge.
- **Fehler kommen als Fehlerhülle zurück, nicht als Ausnahme** (S07, Abschnitt 7). Die
  Handler *werfen* — `PathEscapeError`, `SourceZoneWriteError`, `StaleFileError`,
  `FsNotFoundError` und die übrigen —, und der Router macht daraus `status: "error"` mit dem
  vollen Wortlaut samt Stacktrace in `structured.error` (`reason: "handler_failed"`).
  Geglättet wird nichts. Die Tests keyen deshalb auf den Meldungstext, und die Meldungen sind
  entsprechend eindeutig und stabil gehalten ("außerhalb der erlaubten Zonen", "verlässt die
  erlaubten Zonen über einen Symlink", "wurde seit dem Lesen geändert").
- Die Rohbytes einer per `fs.read` gelesenen Datei laufen **nicht** durch den
  Redaction-Filter — bewusst, wie bei den Artefaktbytes seit S07. Ein Textmuster über
  beliebige Bytes beschädigte die Datei und die SHA-256-Kette, und das Artefakt liegt auf
  derselben lokalen Platte wie die Quelldatei, bringt also keine neue Exposition. Der Schutz
  greift an der anderen Stelle: der **Ausschnitt** in `structured`/`preview` geht durch
  `appendEventInTx` (Protokoll) und `buildPrompt` (Kontext), und beide filtern. Ein
  `sk-ant-…` im Ausschnitt einer gelesenen Datei ist im Protokoll und im Prompt ersetzt,
  bevor das Modell es sieht — ohne Zutun der `fs.*`-Handler. In Abschnitt 4.7 als Pflicht der
  Tools notiert; hier ist sie eingelöst.

### Verdrahtung

- `runtime/index.ts` baut den Katalog jetzt aus `createFsTools` statt aus einer leeren
  Registry (seit S07 offen: "echte Tools ab S08"). Die Katalogkonstruktion ist dafür von
  Modulebene in `main()` gewandert — sie braucht jetzt `pool` und das asynchrone
  `buildFsZones`. Die Zonen: Quellzone `process.cwd()`, Artefaktzone `artifactRootFromEnv()`.
  Der Rest von `index.ts` (Signalbehandlung, `runtime.stopped`, Katalog-Warnung bei
  abweichender Session-Version) bleibt unverändert.

### Tests

- 35 neue Tests, zusammen 142. `tools/fs/paths.test.ts` (17, **ohne Datenbank**): beide
  Wurzeln über `realpath` aufgelöst; die verschachtelte Zone zuerst; `../../etc/passwd`,
  `..`, `../nachbar`, `src/../../../etc` und ein absoluter Pfad außerhalb jeder Zone werden
  abgewiesen; ein Symlink (Junction) nach außen wird abgewiesen, einer innerhalb der Zone
  erlaubt und auf den aufgelösten Pfad zurückgeführt; Symlink Quell→Artefakt wird `artifact`,
  Symlink Artefakt→Quell wird `source`; eine noch nicht existierende Datei unter einem
  existierenden Verzeichnis geht durch (`existed: false`); leere Eingabe, Nicht-String und
  ein Nullbyte werfen `PathInputError`.
- `tools/fs/tools.test.ts` (18, mit Datenbank, über den echten Router): `../../etc/passwd`
  und ein Symlink nach außen kommen als Fehlerhülle zurück, das Protokoll liest sich als
  `session.created, tool.requested, step.started, step.failed, tool.failed`; kleine Datei
  ganz ohne Artefakt; **große Datei (5000 Zeilen) als Ausschnitt plus genau ein Artefakt,
  kein zweites Offload, und das Handle löst bytegleich auf**, mit `artifact.created` zwischen
  den Checkpoints; ausdrücklicher Zeilenausschnitt; Binärdatei ganz ins Artefakt; fehlende
  Datei als Fehlerhülle; `fs.search` gibt genau die zwei `foo`-Zeilen mit Nummer 2 und 3
  zurück und nichts aus der dritten Zeile, `glob` plus `ignore_case` filtern korrekt, ein
  kaputter Ausdruck ist eine Fehlerhülle; `fs.list` markiert einen Symlink als `symlink` und
  zieht nichts aus dem Ziel herein; `fs.write` in die Artefaktzone gelingt (Checkpoints im
  Protokoll), in die Quellzone wird verweigert (keine Datei entsteht), derselbe Aufruf zweimal
  führt den Effekt einmal aus; **`fs.edit` auf einer zwischenzeitlich geänderten Datei wird
  abgewiesen** und mit frischem SHA-256 geht derselbe Edit durch — das Fertig-Kriterium der
  Session; mehrdeutiger Edit ohne `replace_all` abgewiesen; `fs.edit` in der Quellzone
  verweigert; Replay aus dem Protokoll ergibt denselben Zustand wie der Snapshot.
- Nachweis außerhalb von vitest (`_s08_probe.ts`, danach gelöscht): gegen die echte Datenbank
  eine Session mit dem Katalog `v1-d40b46bd368e578b` (5 Tools) eröffnet und der Reihe nach
  geprüft — `../../etc/passwd` abgewiesen; eine Junction auf `C:/Windows` in der Artefaktzone,
  Lesen "durch" sie abgewiesen ("verlässt die erlaubten Zonen über einen Symlink"); eine
  Datei mit 8000 Zeilen als Ausschnitt (`Protokollzeile 1` …) plus ein Artefakt von 158893
  Byte auf der Platte, kein doppeltes Offload, `readArtifact` bytegleich; `fs.write` nach
  `runtime/HACK.ts` verweigert; `fs.write` nach `artifacts/…` gelungen; `fs.read` → SHA-256,
  Datei von außen geändert, `fs.edit` mit dem alten SHA-256 abgewiesen und die Datei
  unverändert, dann mit frischem SHA-256 durch; `fs.search` nach `ARTIFACT_URI_SCHEME` unter
  `runtime/artifacts` → 7 Treffer mit Zeilennummer, kein Datei-Inhalt am Stück. Das Protokoll
  las sich über alle Aufrufe hinweg lückenlos (38 Ereignisse). Probedaten gelöscht, alle fünf
  `kuronami`-Tabellen sind nach dem Lauf leer, `artifacts/` auf der Platte ebenfalls (die
  eine verwaiste Artefaktdatei aus der `fs.read`-Probe von Hand entfernt — genau der
  folgenlose Fall, den S06 beschreibt).

### Bewusst nicht gebaut

- Die Freigabe-Mechanik für Schreibzugriffe in die Quellzone. Das ist S11; heute wird sie
  hart verweigert, und der Wurf steht an einer Stelle (`assertWritableZone`), vor die S11
  seine Prüfung setzen kann.
- `web.*` (S09) — der Katalog trägt nur die fünf `fs.*`.
- Ein GC-Lauf für verwaiste Artefaktdateien nach einem Absturz zwischen `rename` und
  `COMMIT` (seit S06 offen; die `fs.read`-Auslagerung erzeugt jetzt zusätzlich solche
  Dateien).
- `.gitignore`/`.claudeignore`-Auswertung in `fs.search`/`fs.list`. Vorerst nur eine feste
  Prune-Liste (`.git`, `node_modules`). Nachrüstbar, wenn ein echter Lauf zeigt, dass es
  fehlt.
- Ein Alias-Layer `artifact://<namensraum>/<name>` (seit S06 offen).
- Byte-genaues Lesen (`fs.read` ist zeilenorientiert und UTF-8); Ersetzung per regulärem
  Ausdruck in `fs.edit` (nur exakte Teilstrings). Beides nachrüstbar, wenn ein Tool es braucht.

### Offene Befunde

- `PathEscapeError`, `StaleFileError` und die übrigen `fs.*`-Fehler kommen alle mit
  `reason: "handler_failed"` zurück; der eigentliche Grund steht nur im Meldungstext. Sobald
  die Schleife (S12) oder die Policy-Engine (S11) darauf verzweigen will, gehört das in eine
  maschinenlesbare Aufzählung im Router — dieselbe Verabredung wie `structured.reason` /
  `structured.refused` aus S07.
- Die Zonen werden beim Prozessstart einmal aufgelöst. Ändert sich `ARTIFACT_ROOT` oder das
  Arbeitsverzeichnis zur Laufzeit, greift das nicht — für einen langlebigen Runtime-Prozess
  ist das richtig, aber es ist eine stille Annahme.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 142 Tests.
- `tasks.json`: S08 auf `done`, S09 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S09 `web.search` / `web.fetch`.
