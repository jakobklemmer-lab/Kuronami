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

## S09 · `web.search` / `web.fetch` · 2026-09-07

- Tests der Vorsession vorab gelaufen: 142 grün (health, events, session, steps, artifacts,
  redaction, tools/registry, tools/router, tools/fs), unverändert.
- Keine Migration. `kuronami.artifacts` nimmt seit S06 `source.tool` als beliebige
  Zeichenkette; `web.fetch` schreibt seinen Rohinhalt als `"web.fetch"` weg, `web.search`
  seine Trefferliste als `"web.search"`. `web.*` braucht keine Tabelle und keine Spalte,
  die nicht schon dasteht — wie bei S07 und S08.
- Neues Verzeichnis `tools/web/` mit `egress.ts` (Egress-Riegel), `normalize.ts`
  (HTML→Text und Injection-Scan), `tools.ts` (die zwei Definitionen und Handler), je einer
  Testdatei und `README.md`. Die ersten beiden liegen **getrennt** von `tools.ts` und haben
  Testdateien ohne Datenbank: ein Loch im Egress-Riegel ist ein Loch im ganzen Assistenten,
  und der Injection-Scan ist reine Textarbeit, die sich in Millisekunden gegenprüfen lässt.

### Der Egress-Riegel (`egress.ts`)

- **Deny-by-default, drei Prüfungen.** `assertEgressAllowed(policy, url)` parst die URL und
  wirft, wenn: (a) das Schema nicht `http`/`https` ist — kein `file:`, `ftp:`, `data:`,
  `ws:`; (b) Zugangsdaten in der URL stehen (`user:pass@host`) — die liefen sonst
  ungefiltert ins Protokoll; (c) der Host nicht auf der Allowlist steht. Eine **leere**
  Allowlist erlaubt nichts. Ein Allowlist-Eintrag `example.com` deckt `example.com` und
  jede Subdomain mit ab, aber nur auf Punktgrenze — `notexample.com` ist nicht gedeckt.
- **SSRF-Riegel, unabhängig von der Allowlist.** Literale Adressen aus dem Loopback-,
  RFC-1918-, CGNAT-, Link-Local- oder Multicast-Bereich (IPv4 und, konservativ, IPv6)
  werden immer abgewiesen — auch wenn jemand `127.0.0.1` auf die Allowlist setzt. `web.fetch`
  ruft Webseiten ab; es hat im lokalen Netz nichts zu suchen, und das Modell wählt die URL,
  womöglich beeinflusst von einem zuvor abgerufenen, nicht vertrauenswürdigen Inhalt. Dazu:
  `localhost` und `*.localhost` fliegen ebenfalls raus.
- **Bewusst nicht gebaut, dokumentierte Grenze:** die erneute Prüfung der IP *nach* der
  DNS-Auflösung. Ein öffentlicher Name, der zur Verbindungszeit auf `127.0.0.1` zeigt
  (DNS-Rebinding), käme durch. Das abzufangen bräuchte einen eigenen `undici`-Agent mit
  `lookup`-Hook; für ein Ein-Nutzer-System ist die Namens-Allowlist plus IP-Literal-Riegel
  die verhältnismäßige Stufe. In Abschnitt 4.7 vermerkt.
- Die Allowlist kommt aus `WEB_EGRESS_ALLOWLIST` (kommagetrennt), von `runtime/index.ts`
  eingelesen; Tests bauen ihre eigene. `.env.example` um den Schlüssel ergänzt, mit der
  Notiz "leer = web.* ruft nichts ab".

### Normalisierung und Injection-Scan (`normalize.ts`)

- **`normalizeContent(raw, contentType)`** macht aus rohem HTML eine tag-freie Fassung:
  `script`/`style`/`noscript`/`template`/`head`/`svg` samt Inhalt raus, Kommentare raus,
  Blockgrenzen (`</p>`, `<br>`, `</div>` …) zu Zeilenumbrüchen, dann alle Tags weg, ein
  kleiner Satz HTML-Entities dekodiert, Whitespace eingedampft. Der `<title>` wird gezogen.
  Nicht-HTML (`text/plain`, `application/json`, …) läuft ungestrippt durch. Bewusst
  regex-basiert und unvollständig (keine DOM-Analyse, keine Lesbarkeits-Heuristik): die
  tag-freie Fassung ist nur eine *Zusammenfassung*, die Wahrheit ist der Rohinhalt im
  Artefakt.
- **`scanForInjection(text)`** sucht bekannte Prompt-Injection-Muster und gibt sie als Liste
  `{ pattern, snippet, index }` zurück — **es entfernt nichts und verändert den Text nicht**
  (Auftrag "kennzeichnen, nicht still entfernen"; Abschnitt 4.7 "Eine Anweisung aus externem
  Inhalt hebt nie eine Freigabe auf"). Ein still gelöschtes Muster wäre ein verstecktes
  Signal; ein markiertes ist eins, das das Modell und der Betreiber sehen. Muster für
  Instruktions-Übersteuerung, Rollen-Neuzuweisung, System-Prompt-Sonden,
  Geheimhaltungs-Aufforderungen, Exfiltration, Tool-Injection, Chat-Rollen-Marker
  (`system:` am Zeilenanfang), Fence-Marker (`<|...|>`, `[INST]`) und **versteckte
  Steuerzeichen** (Zero-Width, Bidi) — jeweils Deutsch und Englisch. Die Quantoren sind
  bewusst schmal (`[^.\n]{0,N}`), damit kein katastrophales Backtracking entsteht; eine
  Ladezeit-Prüfung (`assertInjectionPatternsUsable`) stellt sicher, dass jedes Muster
  global ist — sonst bräche `matchAll`, und ein ohne `g` durchgerutschtes Muster fände nur
  den ersten Treffer je Seite (dieselbe Zusage-in-einer-Prüfung wie in
  `runtime/redaction/patterns.ts`).
- Die Fundstellen sind nach Offset sortiert und auf `INJECTION_FLAGS_MAX` (12) begrenzt,
  jeder `snippet` auf 120 Zeichen: eine Seite, die aus nichts als Injection-Phrasen
  besteht, soll die Rückgabehülle nicht sprengen. Der Scan läuft über den **vollständigen**
  normalisierten Text, nicht nur über den Kontext-Ausriss — ein Muster tief in einer großen
  Seite wird also markiert, auch wenn der Ausriss es nicht mehr zeigt; der `snippet` trägt
  den Wortlaut, damit nichts verloren geht (im Probelauf unten belegt).

### Die zwei Tools (`tools.ts`)

- `createWebTools({ pool, artifactRoot, egress, fetchImpl?, search? })` gibt die zwei
  `ToolDefinition` mit ihren Abhängigkeiten in den Handlern geschlossen zurück — Muster von
  `createFsTools` (S08). `fetchImpl` ist per Vorgabe das globale `fetch`, `search` ist per
  Vorgabe nicht gesetzt. Tests injizieren beides.
- **`web.fetch`** — der Ablauf und seine Reihenfolge:
  1. **Egress-Prüfung zuerst.** Kein Socket wird geöffnet, bevor der Host freigegeben ist.
  2. Abruf gegen eine **Uhr** und eine **Größengrenze**. Ein einziger `AbortController`,
     an den Zeitfenster (Vorgabe 20 s) und das äußere Abbruchsignal der Session hängen. Der
     Abruf läuft als `Promise.race` gegen einen Verlierer, der bei Timeout/Abbruch
     abgelehnt wird — so gewinnt das Zeitfenster auch dann, wenn ein (Test-)`fetch` das
     Signal ignoriert. Der Body wird **gestreamt** und beim Überschreiten von
     `WEB_FETCH_MAX_BYTES` (5 MiB) abgebrochen, ohne den Rest herunterzuladen — **bevor**
     ein Artefakt entsteht.
  3. **Rohinhalt → Artefakt, immer und byteweise.** `readArtifact` gibt ihn bytegleich
     zurück. Das ist die nicht vertrauenswürdige Rohfassung.
  4. **Normalisierte Fassung → nur in den Kontext.** `structured.excerpt` ist die tag-freie
     Fassung, auf `FETCH_EXCERPT_MAX_CHARS` (600) gekürzt. Dazu Metadaten (finale URL,
     Status, Content-Type, Titel, Bytezahl, SHA-256) und `injection_flags`.
  - **Rohinhalt und normalisierte Fassung teilen sich kein Feld.** Es gibt in der Hülle
    keinen Weg an den vollständigen Rohinhalt — nur das Handle. Genau das ist die strikte
    Trennung aus dem Auftrag.
  - `structured.trust: "untrusted"`, `content_kind: "normalized-summary"`, und die `summary`
    beginnt mit `[nicht vertrauenswürdig · externer Inhalt]`.
  - Die Selbst-Auslagerung läuft **im Schritt** (wie `fs.read` in S08, wie der Router in
    S07): das Artefakt braucht die `step_id` als Herkunft (S06) und gehört zum Ergebnis
    dieses Versuchs. Im Protokoll steht `artifact.created` zwischen `step.started` und
    `step.completed`.
  - Die `web.fetch`-Hülle ist von vornherein knapp (Kontextstufe 0) und bleibt mit ~1,9 KB
    weit unter der Router-Schwelle von 8k Token — der Test prüft ausdrücklich, dass **kein
    zweites** Offload passiert (`structured.offloaded` bleibt `undefined`). Sich auf die
    Router-Auslagerung zu verlassen, hätte den typisierten Ausriss gekostet: der Router
    verschiebt *ganz* `structured` ins Artefakt.
- **`web.search`** — knappe Trefferliste (`SEARCH_CONTEXT_MAX_RESULTS` = 5, Titel/Ausriss
  gekürzt) in den Kontext, **alle** Treffer plus Anbieter-Rohantwort als Artefakt
  ("Volltreffer als Artefakt"). `structured.trust: "untrusted"`, und der Injection-Scan
  läuft über die Titel und Ausrisse — Suchtreffer sind ebenso angreiferkontrolliert wie ein
  abgerufener Text.
- **`web.search` braucht ein injiziertes Backend** (`WebSearchBackend`). Fehlt es, ist das
  Tool registriert (Kern-Primitiv, Teil des eingefrorenen Katalogs), aber nicht bedienbar
  und meldet eine Fehlerhülle — dieselbe Haltung wie bei der Policy-Engine in S07: der
  Platz ist da, die Umsetzung kommt später (Anbieter über die n8n-Bridge, S13). Ein echtes
  `web.search` jetzt an einen Anbieter zu binden, hieße die Vendor-Entscheidung in S09
  vorwegzunehmen.
- Beide Tools sind Risikostufe `read` (Abschnitt 10: `web.search` steht dort ausdrücklich
  unter "Lesen"), `repeatable: true` — ein GET hat keinen beobachtbaren Seiteneffekt nach
  draußen. Der Egress-Riegel ist die Kontrolle, nicht eine Freigabe je Aufruf; die
  Policy-Engine (S11) kann später eine Domain-abhängige Freigabe davor setzen, der Router
  hat den Platz seit S07 markiert.
- **Fehler kommen als Fehlerhülle zurück, nicht als Ausnahme** (S07, Abschnitt 7). Die
  Handler *werfen* — `EgressBlockedError`, `EgressUrlError`, `WebFetchTimeoutError`,
  `WebFetchTooLargeError`, `WebSearchUnavailableError` —, und der Router macht daraus
  `status: "error"` mit dem vollen Wortlaut in `structured.error` (`reason:
  "handler_failed"`). Die Meldungen sind eindeutig und stabil gehalten ("steht nicht auf
  der Egress-Allowlist", "Schema … ist nicht erlaubt", "überschreitet die
  Größenbegrenzung", "Zeitfenster … überschritten").
- Die **Bytes** eines abgerufenen Inhalts laufen **nicht** durch den Redaction-Filter —
  bewusst, wie bei den Artefaktbytes seit S07 und den `fs.read`-Rohbytes seit S08. Ein
  Textmuster über beliebige Bytes beschädigte die SHA-256-Kette, und das Artefakt liegt auf
  derselben lokalen Platte. Der Schutz greift am `excerpt`: der geht durch
  `appendEventInTx` (Protokoll) und `buildPrompt` (Kontext), und beide filtern. Ein
  `sk-ant-…` im Text einer Seite ist im Protokoll und im Prompt ersetzt, bevor das Modell
  es sieht — ohne Zutun der `web.*`-Handler. In Abschnitt 4.7 vermerkt.

### Verdrahtung

- `runtime/index.ts` baut den Katalog jetzt aus `createFsTools` **und** `createWebTools`
  (seit S08 offen: "`web.*` folgt in S09"). Die Egress-Policy entsteht aus
  `WEB_EGRESS_ALLOWLIST`; ohne gesetzte Hosts ruft `web.*` nichts ab (deny-by-default). Ein
  Suchanbieter wird nicht verdrahtet — `web.search` meldet bis zur n8n-Bridge (S13) eine
  Fehlerhülle. Der Rest von `index.ts` bleibt unverändert.
- Der Katalog trägt jetzt sieben Tools (`fs.*` × 5, `web.fetch`, `web.search`); im Probelauf
  war die Version `v1-b8a2cb6ccc7a663e`.

### Tests

- 42 neue Tests, zusammen 184. `tools/web/egress.test.ts` (14, **ohne Datenbank**):
  http/https auf freigegebenem Host durch, andere Schemata und Zugangsdaten und Müll
  abgewiesen; Subdomain-Deckung, aber nur auf Punktgrenze (`notexample.com` nicht);
  exakter Unterhost frei, Elternhost dadurch nicht; leere Allowlist erlaubt nichts;
  Normalisierung der Einträge; Loopback/RFC-1918/CGNAT/Link-Local/`localhost` und
  IPv6-Loopback/ULA abgewiesen — auch wenn sie auf der Allowlist stünden; eine freigegebene
  öffentliche IP bleibt in Ruhe.
- `tools/web/normalize.test.ts` (14, **ohne Datenbank**): Titel gezogen und eingedampft;
  Tags, script-/style-Inhalt und Kommentare raus; Blockgrenzen zu Zeilenumbrüchen; HTML
  auch ohne Content-Type erkannt; Nur-Text und JSON ungestrippt durch; englische und
  deutsche Instruktions-Übersteuerung mit Offset; System-Prompt-Sonde,
  Geheimhaltung, Exfiltration, Rollen-Marker; versteckte Steuerzeichen (zwei Stück
  gezählt, Snippet nennt `U+200B`); harmloser Text und Leerstring ergeben nichts; die Zahl
  der Fundstellen ist begrenzt; **die markierte Phrase bleibt in der normalisierten Fassung
  stehen** (nicht entfernt).
- `tools/web/tools.test.ts` (14, mit Datenbank, über den echten Router), darunter das
  **Fertig-Kriterium**: eine **200-KB-Seite** abrufen → die Rückgabehülle liegt unter 500
  Token (`estimateResultTokens` und `JSON.stringify(...).length < 2000`), `offloaded` bleibt
  `undefined`, genau ein Artefakt, und das Handle löst **bytegleich auf die vollständige
  Seite** auf; `artifact.created` zwischen den Checkpoints. Dazu: script-Inhalt (ein
  Marker `RAWONLY_…`) steht im Artefakt, aber **nirgends in der Rückgabehülle** — strikte
  Trennung; `trust: "untrusted"` und die `summary`-Markierung; Nicht-HTML (JSON) wird als
  Text behandelt, Tags nicht gestrippt; **Injection-Phrase wird markiert und bleibt in
  Ausriss und Artefakt stehen**, die `summary` nennt die Markierung; nicht freigegebener
  Host → Fehlerhülle mit `/Allowlist/`, `step.failed`, **kein Artefakt**; verbotenes Schema
  abgewiesen; **Größengrenze bricht ab, kein Artefakt**; **Zeitfenster** wird zur
  Fehlerhülle; derselbe Aufruf zweimal führt den Effekt einmal aus (ein Artefakt, ein
  `step.started`); Replay aus dem Protokoll ergibt denselben Zustand wie der Snapshot.
  `web.search`: 12 Treffer vom Backend → 5 im Kontext (Ausriss gekürzt), alle 12 im
  Artefakt, `trust: "untrusted"`; Injection-Scan über die Ausrisse; ohne Backend eine
  Fehlerhülle.
- Vier Gegenproben, alle bestätigt und danach zurückgesetzt:
  * `excerpt` aus dem Rohtext statt aus `normalizeContent` → "strikt getrennt" rot: der
    `<script>`-Marker landet in der Hülle.
  * Egress-Prüfung entfernt (`new URL(...)` direkt) → "nicht freigegebener Host" rot: die
    Meldung `/Allowlist/` fehlt.
  * Größengrenze ausgehebelt (`if (false)`) → "Größenbegrenzung" rot: `status` ist `ok`
    statt `error`.
  * (Frühere Iteration) `FETCH_EXCERPT_MAX_CHARS` auf 1000 → Fertig-Kriterium rot bei 584
    statt < 500 Token; daraufhin auf 600 gesenkt und Vorschauzeilen von 6 auf 3 gekürzt.
- Nachweis außerhalb von vitest (`_s09_probe.ts`, danach gelöscht): den Katalog wie
  `runtime/index.ts` gebaut (7 Tools, `v1-b8a2cb6ccc7a663e`), eine echte Session eröffnet.
  `web.fetch` auf eine 269-KB-Seite → Hülle **1903 Byte ≈ 479 Token**, `offloaded`
  undefined, `trust` untrusted, Titel gezogen; zwei `injection_flags`
  (`instruction-override`, `system-prompt-probe`) — die Phrase steckt am Seitenende jenseits
  des 600-Zeichen-Ausrisses, wird aber trotzdem markiert und der `snippet` trägt den
  Wortlaut; der `RAWONLY_…`-Marker aus dem `<script>` ist **nicht** in der Hülle, **wohl**
  im Artefakt; das Artefakt ist 269040 Byte groß und bytegleich. `web.search` → 5 im
  Kontext, 9 im Artefakt. `evil.test` → Fehlerhülle "steht nicht auf der Egress-Allowlist".
  Protokoll über alle drei Aufrufe hinweg lückenlos (15 Ereignisse). Probedaten gelöscht,
  alle fünf `kuronami`-Tabellen nach dem Lauf leer.

### Bewusst nicht gebaut

- Ein echter Suchanbieter. `web.search` nimmt ein injiziertes Backend; `runtime/index.ts`
  verdrahtet keins, das Tool meldet bis S13 eine Fehlerhülle.
- Die Prüfung der tatsächlich verbundenen IP *nach* der DNS-Auflösung (ein öffentlicher
  Name, der zur Verbindungszeit auf eine interne IP zeigt — DNS-Rebinding). Bräuchte einen
  eigenen `undici`-Agent mit `lookup`-Hook. Dokumentierte Grenze (Abschnitt 4.7). Die
  **Weiterleitungs-Variante** derselben Lücke ist seit dem Nachtrag unten geschlossen.
- Die Policy-Engine (S11). Ihr Platz im Router steht seit S07: zwischen Schema-Prüfung und
  `executeStep`. Sie kann eine Domain-abhängige Freigabe vor den Egress-Riegel setzen.
- JS-Rendering (Headless-Browser), robots.txt, Rate-Limiting, ein Cache abgerufener Seiten.
  `web.fetch` macht rohes HTTP.
- Lesbarkeits-Extraktion (Readability), HTML→Markdown, Zeichensatz-Erkennung über den
  Content-Type hinaus (UTF-8-Vorgabe, Latin-1/Windows-1252 nur, wenn ausdrücklich benannt).
- Der Alias-Layer `artifact://<namensraum>/<name>` (seit S06 offen).
- Ein GC-Lauf für verwaiste Artefaktdateien (seit S06 offen; `web.fetch` erzeugt jetzt
  zusätzlich solche Dateien, wenn der Prozess zwischen `rename` und `COMMIT` abstürzt).

### Offene Befunde

- `EgressBlockedError`, `WebFetchTimeoutError` und die übrigen `web.*`-Fehler kommen alle
  mit `reason: "handler_failed"` zurück; der eigentliche Grund steht nur im Meldungstext.
  Sobald die Schleife (S12) oder die Policy-Engine (S11) darauf verzweigen will, gehört das
  in eine maschinenlesbare Aufzählung im Router — dieselbe Verabredung wie
  `structured.reason` / `structured.refused` aus S07 und die `fs.*`-Fehler aus S08.
- Der Injection-Scan über den vollständigen Text kann bei einer sehr großen, sehr
  injection-dichten Seite bis zu `INJECTION_FLAGS_MAX` (12) Fundstellen mit je 120 Zeichen
  Snippet liefern — die Hülle wächst dann auf ~3 KB (~750 Token), bleibt aber unter der
  Router-Schwelle und wird nicht ausgelagert. Das ist gewollt: die Markierungen sind das
  Signal, um das es geht.
- `web.fetch` bei einer Nicht-2xx-Antwort (404, 500) gibt weiterhin `status: "ok"` zurück,
  mit dem HTTP-Status prominent in `summary` und `structured` und dem Body im Artefakt —
  der Abruf ist im HTTP-Sinn geglückt, und eine 403/429-Seite trägt oft die einzige
  brauchbare Auskunft. Erst ein Netzwerkfehler (DNS, Verbindung) wird zur Fehlerhülle.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 184 Tests.
- `tasks.json`: S09 auf `done`, S10 von `queued` auf `ready`.

### Nachtrag nach Review · Weiterleitungen (SSRF über 302)

- **Befund (aus dem Review):** `web.fetch` folgte Weiterleitungen mit `redirect: "follow"`,
  aber die Egress-Prüfung lief nur einmal, auf die ursprünglich angefragte Adresse. Eine
  freigegebene, harmlose Seite konnte mit einem `302` auf eine interne Adresse antworten
  (Heimnetz, Cloud-Metadaten unter `169.254.169.254`, Server-Verwaltung), und der eingebaute
  Follower ging brav hin — der Egress-Riegel war mit einem einzigen `Location`-Header
  umgangen. Dieselbe Kategorie wie das dokumentierte DNS-Rebinding, aber ohne manipuliertes
  DNS auszunutzen und im Protokoll bis dahin nicht erwähnt. Für ein Ein-Nutzer-System kein
  Weltuntergang, aber eine bewusste Entscheidung wert.
- **Entscheidung:** geschlossen, nicht vertagt. Der Auftrag von S09 nennt "Egress-Allowlist"
  ausdrücklich, und eine Allowlist, die ein `302` umgeht, ist keine. Der Fix ist klein und
  gut testbar; die Alternative (Weiterleitungen ganz abschalten) hätte `web.fetch` im Alltag
  unbrauchbar gemacht — `http`→`https`, nackte Domain→`www`, Schrägstrich-Normalisierung
  sind Standard.
- **Umsetzung:** `web.fetch` folgt Weiterleitungen jetzt **von Hand**
  (`followWithGuardedRedirects`, `redirect: "manual"`): jede Zwischenadresse — Start *und*
  jeder `Location` — geht erneut durch `assertEgressAllowed` (Schema, Zugangsdaten,
  Allowlist, SSRF-Riegel), bevor ihr gefolgt wird. Relative `Location` werden gegen die
  aktuelle Adresse aufgelöst. Obergrenze `WEB_FETCH_MAX_REDIRECTS` = 5 (http→https→www→
  Schrägstrich sind schon drei), danach `WebFetchTooManyRedirectsError`. Zwischenantworten
  werden verworfen (`res.body?.cancel()`), das Zeitfenster und die Größengrenze gelten für
  die Kette als Ganzes bzw. die finale Antwort. `structured.final_url` trägt jetzt die
  Adresse, die den Inhalt tatsächlich geliefert hat (aus der Schleife, nicht aus `res.url` —
  bei `redirect: "manual"` wäre das für konstruierte Antworten leer).
- **Was das nicht schließt:** DNS-Rebinding (öffentlicher Name → interne IP zur
  Verbindungszeit). Bleibt die dokumentierte Grenze, bräuchte den eigenen undici-Agent.
- 5 neue Tests (`tools/web/tools.test.ts`, jetzt 19): Weiterleitung innerhalb der Allowlist
  wird gefolgt; relative Weiterleitung korrekt aufgelöst; **Weiterleitung auf einen nicht
  freigegebenen Host → Fehlerhülle, kein Artefakt, `step.failed`**; **Weiterleitung auf
  `169.254.169.254` → abgewiesen (SSRF über 302), kein Artefakt**; Selbst-Schleife bricht
  nach `maxRedirects` ab. Gegenprobe: das Weiterleitungsziel *nicht* erneut prüfen (wie der
  eingebaute Follower) → beide SSRF-Tests rot (`expected 'ok' to be 'error'`), danach
  zurückgesetzt.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 189 Tests.

Status: abgeschlossen. Nächste Session: S10 `task.*` und `user.ask`.

## S10 · `task.*` und `user.ask` · 2026-09-08

**Vorbemerkung zur Entstehung dieses Eintrags:** Die Session, in der S10 gebaut wurde, ist
durch ein Nutzungslimit unterbrochen worden, danach fiel der Strom aus — der Gesprächskontext
war weg, `progress.md` und `tasks.json` sahen noch nach "S10 nicht begonnen" aus. Eine
Bestandsaufnahme zu Beginn dieser Session ergab: der Code stand bereits vollständig im
Arbeitsverzeichnis (`runtime/tasks/`, `tools/task/`, `tools/user/`, `runtime/session/
user-input.ts`, `await-user.process.ts`, Migration `0006`), war aber weder committet noch
gegen `pnpm lint` gelaufen, und ein Testbug im Neustart-Nachweis stand offen. Dieser Eintrag
dokumentiert den Code, wie er vorgefunden und in dieser Session zu Ende gebracht wurde —
ohne die Gegenproben-Erzählung der Sessions davor nachzustellen, wo sie nicht tatsächlich
in dieser Session gelaufen sind.

- Tests der Vorsession: 189 (S01–S09) liefen nach Wiederherstellung der Datenbank
  (Docker Desktop war nicht gestartet) unverändert grün, bevor an S10 etwas geändert wurde.
- Migration `0006_task_plan`: erweitert `kuronami.tasks` (seit S02 ohne Session-Bezug) um
  `session_id` (Fremdschlüssel auf `kuronami.sessions`) und `position`. Primärschlüssel wird
  zusammengesetzt (`session_id, task_id`) statt `task_id` allein — Abweichung von Abschnitt 5,
  weil `task.set` Aufgaben über eine vom Aufrufer stabil gewählte `id` adressiert
  ("summarize-mails" statt eine generierte Kennung), damit ein `task.update` nach einem
  Neustart dieselbe Aufgabe trifft; solche Schlüssel sind nur innerhalb einer Session
  eindeutig. `position` trägt die Planreihenfolge, weil `created_at` sie nicht trägt: ein
  einziges `task.set` schreibt alle Zeilen in derselben Transaktion und damit mit praktisch
  gleichem Zeitstempel. Zwei Indizes (`session_id`, `session_id, position`). War schon vor
  dem Stromausfall angewendet (2026-09-07), Schema und Code stimmen überein.
- `runtime/tasks/{types,store}.ts`: `task.set` und `task.update` (Abschnitt 9). Derselbe
  Snapshot-gleich-Replay-Zwang wie bei Schritten (S05) und Artefakten (S06): jede Änderung
  schreibt Zeile (`kuronami.tasks`) und Ereignis (`task.created`/`task.updated`) in **einer**
  Transaktion mit `now()` als gemeinsamem Zeitstempel, `derivePlan`/`replayPlan` falten das
  Protokoll unabhängig davon zum selben Plan. `task.set` schreibt den **kompletten** Plan neu
  (kein Anhängen): Aufgaben, die in der neuen Liste fehlen, werden gelöscht und ihr
  `task.updated` trägt `dropped: true`, damit die Faltung sie fallen lässt. Ein unveränderter
  Re-`set` schreibt kein Ereignis (Vergleich über `sameFields`), wie `beginStep` bei einem
  schon fertigen Schritt. Beide Operationen laufen **nicht** durch die Ausführungshülle aus
  S05: kein externer Seiteneffekt, ihr Determinismus folgt aus der Form der Operation
  (deklaratives Neuschreiben bzw. gezielter Patch), nicht aus einem Idempotenzschlüssel gegen
  Wiederverschicken — dasselbe Argument wie bei `writeArtifact` (S06). Der Redaction-Filter
  (S07) läuft am selben Schreibtor wie bei `writeArtifact`, auf jedes Textfeld außer `task_id`/
  `session_id` (die sind Identität, wie `idempotency_key` in S07). Eine `id`, die der Filter
  verändern würde, wird abgewiesen (`TaskInputError`) statt einen kaputten Schlüssel
  entstehen zu lassen.
- `tools/task/tools.ts`: `task.set`/`task.update` als dünner Tool-Mantel um `store.ts`.
  Eingabeprüfung ohne Bibliothek nach dem Muster von S07/S08: Pflichtfelder, Typen und
  **unbekannte Schlüssel** werden abgewiesen statt stillschweigend fallen gelassen (`TASK_KEYS`/
  `OPTION_KEYS`), sonst führte der Router einen Aufruf aus, den so niemand gemeint hat.
- `runtime/session/user-input.ts` + `tools/user/tools.ts`: `user.ask` (Abschnitt 9/10), der
  synchrone Haltepunkt mit **strukturierten** Optionen (mindestens zwei, `{ id, label }`,
  kein Fließtext, auf dessen Parsbarkeit man hofft). Der Mechanismus steckt vollständig im
  Ereignisprotokoll, ohne eigene Tabelle und ohne eigene Spalte: der Aufruf schreibt
  `approval.requested` unter dem stabilen Schlüssel `ask:<call_id>`; ist die Rückfrage noch
  offen, wirft der Handler `UserInputRequiredError`, die der Router **durchlässt** — wie
  `ToolCatalogMismatchError` (S07): der Lauf ist nicht fehlgeschlagen, er wartet, und
  `runtime.stopped` wird trotzdem sauber geschrieben. `answerUserInput` schreibt
  `approval.granted` mit dem vollständigen Freigabepfad (gewählte Option, `decided_by`,
  Zeitstempel, Abschnitt 10); `dismissUserInput` schreibt `approval.denied`, ohne eine Option
  zu wählen. Ein zweiter `approval.requested` zur selben `ask_id` wird nicht geschrieben —
  Idempotenz kommt aus dem Protokoll, nicht aus der Ausführungshülle, durch die `user.ask`
  bewusst nicht läuft (kein externer Seiteneffekt; einen Schritt stundenlang auf `running`
  zu parken, während ein Mensch überlegt, wäre falsch).
- `runtime/session/state.ts`: neuer `SessionStatus`-Wert `awaiting_user`, kein eigener
  Ereignistyp und keine Spalte — dieselbe Lesart wie `canceled`: der Zustand *ist* ein
  `approval.requested` ohne folgendes `approval.granted`/`approval.denied`. `PendingUserInput`/
  `AskOption` neu, `deriveSessionState` faltet offene Rückfragen aus `approval.*` und markiert
  die Session als `awaiting_user`, aber nur wenn kein Terminalzustand (`completed`/`failed`/
  `canceled`) schon gewonnen hat — eine abgebrochene Session wartet nicht, auch wenn zufällig
  noch ein offenes `approval.requested` im Protokoll steht.
- `tools/router.ts`/`tools/types.ts`: neues Feld `ToolDefinition.execution` (Vorgabe `"step"`,
  neu `"runtime"`). `task.*` und `user.ask` haben keinen externen Seiteneffekt und laufen
  deshalb ohne die Ausführungshülle aus S05 — `callRuntimeTool` prüft Katalog und Schema wie
  jeder Aufruf und schreibt `tool.requested`/`tool.completed`, ruft den Handler aber direkt.
  `execution` zählt bewusst **nicht** in `fingerprintTools` (`tools/registry.ts` musste dafür
  nicht angefasst werden: der Fingerabdruck zählt explizit aufgezählte Felder auf, keine
  Ausschlussliste) — dieselbe Begründung wie beim Handler-Rumpf seit S07: eine interne
  Weiche, kein Teil des Vertrags, den das Modell sieht. `ToolInvocation.stepId` ist jetzt
  `string | null` (ein Runtime-Tool schreibt kein Artefakt, ihm fehlt die Herkunft dafür),
  dazu ein neues Feld `callId`, aus dem `user.ask` seinen stabilen `ask:<call_id>`-Schlüssel
  ableitet.
- `runtime/index.ts`: baut den Katalog jetzt zusätzlich aus `createTaskTools`/
  `createUserTools` (nach `fs.*` und `web.*`).
- **Gefundener und behobener Fehler:** Der Neustart-Nachweis
  (`runtime/session/user-input.test.ts`) legte die Session vor dem Spawnen eines echten
  Kindprozesses mit `createOrResumeSession(pool, { threadId, channel: "web" })` an — **ohne**
  `defaults.toolCatalogVersion`. Die Session bekam damit die Vorgabe `"v1"`, während der
  gespawnte Prozess seinen eigenen echten Katalog-Fingerabdruck (`createUserTools({ pool })`
  allein) berechnete und ihn nur beim *Neuanlegen* setzen kann — beim *Wiederfinden* greifen
  Vorgabewerte laut S04 bewusst nicht. Jeder Tool-Aufruf im Kindprozess brach deshalb sofort
  mit `ToolCatalogMismatchError` ab, bevor er `user.ask` erreichte: das Fertig-Kriterium der
  Session war rot. Der Schwestertest `tools/user/tools.test.ts` macht es korrekt
  (`defaults: { toolCatalogVersion: catalog.version }`) und war deshalb grün — der
  zugrundeliegende Mechanismus war also nachweislich in Ordnung, nur der Testaufbau nicht.
  Im echten Betrieb (`runtime/index.ts`) träte das nicht auf, weil dort immer der volle
  Katalog beim allerersten Anlegen einer Session gesetzt wird. Fix: der Test baut jetzt
  denselben Katalog wie `await-user.process.ts` (`createUserTools({ pool })`) und legt die
  Session mit dessen Fingerabdruck als Vorgabe an.
- `pnpm exec biome check --fix .` über sechs Dateien angewendet (reine Formatierung und eine
  Import-Sortierung in `await-user.process.ts`, `state.test.ts`, `store.test.ts`,
  `tools/task/tools.test.ts`, `tools/user/tools.test.ts`) — `--unsafe` war entgegen der
  ersten Einschätzung nicht nötig, der einfache Fix reichte für die Import-Reihenfolge.
- 33 neue Tests, zusammen 222. `runtime/tasks/store.test.ts` (12, mit Datenbank): Plan
  anlegen mit Positionen und `task.created` je Aufgabe, Snapshot == Faltung; unveränderter
  Re-`set` schreibt kein Ereignis; Aktualisieren, Entfernen (`dropped: true`, Aufgabe fällt
  aus Snapshot und Faltung); `task.update` auf unbekannte `task_id` wirft
  `TaskNotFoundError`; leerer Patch wirft `TaskInputError`; ungültiger Status wirft
  `TaskStatusError`, ohne ein Ereignis zu hinterlassen; Redaction greift auf Titel/Blocker
  (Secret in einem Blocker-Kurztext verschwindet aus Zeile **und** Ereignis); doppelte `id`
  in einem `task.set` wirft. `tools/task/tools.test.ts` (5, über den echten Router):
  `task.set` und `task.update` über `callTool`, unbekanntes Feld in einer Aufgabe abgewiesen,
  `execution: "runtime"` erzeugt kein `step.*`-Ereignis, nur `tool.requested`/`tool.completed`.
  `tools/user/tools.test.ts` (8, über den echten Router): `user.ask` hält beim ersten Aufruf
  an (`UserInputRequiredError`, Session `awaiting_user`); derselbe `call_id` nach der Antwort
  liefert die Wahl zurück und der Sessionstatus kehrt auf `running`; ein zweiter Aufruf vor
  der Antwort schreibt kein zweites `approval.requested`; `dismissUserInput` liefert
  `dismissed: true`; unbekannte Options-`id` bei `answerUserInput` wirft
  `UnknownAskOptionError`; bereits entschiedene Rückfrage erneut beantworten wirft
  `UserInputNotPendingError`; weniger als zwei Optionen wird abgewiesen; Replay ergibt
  denselben Zustand wie der Snapshot. `runtime/session/state.test.ts` um 7 auf 17 gewachsen:
  `awaiting_user` aus offenem `approval.requested`, `approval.granted`/`approval.denied`
  schließt die Rückfrage, ein Terminalzustand gewinnt gegen eine offene Rückfrage, mehrere
  offene Rückfragen gleichzeitig, `approval.requested` ohne verwertbare Felder wirft.
  `runtime/session/user-input.test.ts` (1, **echter Betriebssystem-Prozess**, das
  Fertig-Kriterium): Lauf 1 hält sauber bei `user.ask` an (kein `step.*`, kein `tool.failed`,
  `runtime.stopped` geschrieben, Prozess beendet sich mit Code 0), ein frisch gestarteter
  Prozess liest den Wartezustand ausschließlich aus der Datenbank, nach `answerUserInput`
  setzt Lauf 2 mit derselben `call_id` fort und schreibt `tool.completed`; Replay aus dem
  Protokoll ergibt denselben Zustand wie der Snapshot.
- Bewusst nicht gebaut: die Policy-Engine (S11, unverändert der nächste Schritt — ihr Platz
  im Router steht seit S07 fest); eine Verzahnung von `task.*` mit einer echten Planungs-
  schleife (S12, hier gibt es nur den Speicher und die Werkzeuge, keine Schleife, die ihn
  liest und danach handelt); ein Gateway, das `answerUserInput` an einen echten Kanal
  bindet (bis S16 ruft das der Betreiber bzw. der Test direkt, wie in `user-input.ts`
  vermerkt).
- Offene Befunde: `tools/registry.test.ts` hat kein Gegenstück zum Handler-Test ("Version
  bleibt bei geändertem Handler unverändert") für das neue Feld `execution` — dass es nicht
  in den Fingerabdruck eingeht, ist durch die Bauart von `fingerprintTools` sichergestellt
  (explizite Feldliste statt Ausschlussliste) und durch die grüne Testsuite nicht widerlegt,
  aber auch nicht durch einen eigenen Test wie bei `risk`/`repeatable`/`description`
  ausdrücklich festgehalten. Für S11 relevant: `callRuntimeTool` prüft aktuell keine Policy
  vor dem Ausführen von `task.*`/`user.ask` (beide sind `risk: "soft_write"`/`"read"`, also
  nach Abschnitt 10 ohnehin automatisch erlaubt) — die Policy-Engine muss auch den
  `execution: "runtime"`-Pfad erreichen, nicht nur `executeStep`.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 222 Tests.
- `tasks.json`: S10 auf `done`, S11 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S11 Policy-Engine.

## S11 · Policy-Engine · 2026-09-08

- Tests der Vorsession vorab gelaufen: 222 grün (health, events, session, steps, artifacts,
  redaction, tasks, tools/registry, tools/router, tools/fs, tools/web, tools/task, tools/user),
  unverändert.
- Neues Verzeichnis `policy/` mit neun Modulen (`risk`, `types`, `secrets`, `resource`,
  `rules`, `hooks`, `engine`, `approvals`, `audit`), dazu Migration `0007_policy_approvals`.
  `policy/` importiert **nichts** aus `tools/`: die Pfadauflösung kommt als injizierte
  Funktion herein (`policyResolver` in `tools/fs/paths.ts`), und `RiskLevel` ist aus
  `tools/types.ts` nach `policy/risk.ts` gewandert, wo `policy/README.md` die Risikostufen
  ohnehin verortet. Die Richtung ist damit durchgängig `tools → policy → runtime`, wie
  Abschnitt 4.7 sie vorgibt.

### Der Kern: es gilt die schärfste Aussage

- Die vier Ebenen aus Abschnitt 10 stimmen nicht ab, sie sprechen, und **`deny` schlägt `ask`
  schlägt `allow`**. Daraus folgen drei Entscheidungen, die den ganzen Aufbau tragen und die
  gegen die übliche Bauweise gehen:
  1. **Die Reihenfolge der Regeln ist bedeutungslos** — es werden alle ausgewertet. Bei "erste
     passende Regel gewinnt" hinge die Sicherheit an der Position in einer Liste: ein breites
     `allow` weiter oben schaltete jede spätere Verschärfung ab, und man sieht es der Liste
     nicht an, man muss sie von oben lesen und mitdenken, was vorher schon zugeschlagen hat.
     Der Preis ist, dass eine Ausnahme sich nicht als `allow` schreiben lässt; sie gehört in
     die Bedingung der schärferen Regel.
  2. **Ein `allow` senkt nichts.** Es ist eine Abstention mit Namen: es steht im Freigabepfad,
     damit sichtbar bleibt, dass die Ebene lief und nichts einzuwenden hatte. Könnte es den
     Boden senken, wäre "hartes Schreiben nur mit Freigabe" genau einen zu breit geratenen
     Glob weit vom Verschwinden entfernt — und zwar lautlos, weil sich ein zu breites `allow`
     wie ein funktionierendes System anfühlt.
  3. **Regeln heben die Risikostufe an, sie senken sie nie.** Eine Regel, die senken darf, ist
     eine, mit der sich jede Stufe wegkonfigurieren lässt.
- Unter den vier Ebenen liegt die Risikostufe als **Boden**: `read`/`soft_write` → erlaubt,
  `hard_write`/`destructive` → Freigabe. Ohne diesen Boden wäre die Tabelle aus Abschnitt 10
  nur die Vorgabe für einen leeren Regelsatz, und die Zusage hinge daran, dass niemand die
  passende Regel löscht.
- Die einzige Ebene, die senken darf, ist der **Sessionmodus**, und nur den Boden:
  `accept_edits` erlaubt hartes Schreiben, **wenn der Aufruf einen Pfad betrifft** — genau das
  ist die Trennlinie zwischen "Edits akzeptieren" und "Mail, Shell, Datenbank"; und
  `bypass_in_sandbox` nur mit nachgewiesener Sandbox. Beide heben nie das Wort einer anderen
  Ebene auf: mit `accept_edits` geht ein `fs.write` in die Quellzone durch, ein `fs.write` auf
  `.env` weiterhin nicht.
- **`bypass_in_sandbox` ist bewusst nicht über die Umgebung scharf zu schalten.** Der
  Sandbox-Nachweis ist ein Feld der Engine-Konfiguration und in `runtime/index.ts` fest
  `false`, weil `exec.run` und der Container aus Abschnitt 4.6 noch nicht stehen. Eine
  Umgebungsvariable dafür wäre der Schalter, der irgendwann gesetzt ist — dasselbe Argument
  wie beim nicht abschaltbaren Redaction-Filter (S07). Der Modus fällt sichtbar auf `ask`
  zurück und schreibt den Grund in den Freigabepfad, statt still zu wirken.
- **Abweichung von Abschnitt 10, die begründet werden muss:** bei `destructive` gibt es
  ausschließlich die Einmalfreigabe. Die Tabelle sagt dort nicht "Freigabe nötig", sondern
  **immer** Freigabe, und eine sessionweite oder dauerhafte Vorab-Erlaubnis hebt genau dieses
  "immer" auf. `session` und `always` werden bei zerstörenden Aktionen deshalb gar nicht erst
  als Option angeboten — was nicht angeboten wird, kann auch nicht versehentlich gewählt
  werden. Kein Sessionmodus greift dort, auch `bypass_in_sandbox` nicht.

### Kein Weg an der Engine vorbei, und zwar im Typsystem

- Abschnitt 4.7 sagt: "Es gibt keinen Pfad, auf dem ein Tool ohne Policy-Prüfung ausgeführt
  wird." Das steht jetzt im Typ und nicht in einem Kommentar über einem `if`:
  `ToolInvocation.policy` ist ein Pflichtfeld vom Typ `PolicyGrant`, und die Klasse dahinter
  wird **nur als Typ** exportiert und trägt ein privates Feld. Außerhalb von `policy/engine.ts`
  lässt sich keine herstellen, auch nicht als Objektliteral. Ein Handler kann damit gar nicht
  aufgerufen werden, ohne dass die Engine entschieden und den Audit-Eintrag geschrieben hat.
- `ToolRouterDeps.policy` ist Pflichtfeld ohne Vorgabe. Eine optionale Engine mit einer
  nachsichtigen Vorgabe wäre genau der Pfad, den 4.7 ausschließt — und sie entstünde nicht aus
  Nachlässigkeit, sondern beim ersten Test, dem die Verdrahtung zu umständlich ist. Der Preis
  ist, dass fünf bestehende Testdateien und `await-user.process.ts` eine Engine bauen müssen;
  das ist die richtige Seite des Handels.
- Die Prüfung steht **vor** der Weiche zwischen `executeStep` und `callRuntimeTool`, nicht in
  einem der beiden Zweige. Damit ist der in S10 offen notierte Punkt geschlossen (die Policy
  muss auch den `execution: "runtime"`-Pfad erreichen), und ein künftiger dritter
  Ausführungsmodus bekommt sie ohne Zutun.
- Drei Ausgänge, und nur einer führt zur Ausführung. **Freigabe** → `PolicyGrant`.
  **Ablehnung** → Fehlerhülle mit `reason: "policy_denied"`: sie ist eine Antwort auf den
  Aufruf, das Modell soll sie im selben Lauf lesen und einen anderen Weg wählen (Abschnitt 7).
  **Haltepunkt** → `ApprovalRequiredError`, den der Router durchlässt wie
  `UserInputRequiredError` (S10) und `ToolCatalogMismatchError` (S07): der Lauf ist nicht
  fehlgeschlagen, er wartet, die Session steht auf `awaiting_user`. Dass der dritte Fall wirft
  statt zurückzukommen, ist Absicht — ein Rückgabewert "bräuchte noch eine Freigabe" wäre
  einer, den ein Aufrufer versehentlich ignorieren kann.

### Kein Tool ohne Zuordnung

- Zwei Tore. `ToolRegistry.register` prüft die Risikostufe (`assertRiskLevel`), und die Engine
  prüft sie noch einmal, bevor sie entscheidet. TypeScript sichert nur das erste ab; ein Tool,
  das aus JSON entsteht (n8n-Bridge, S13), kommt am Compiler vorbei. Eine fehlende Stufe wird
  **nicht** mit einer Vorgabe gefüllt: geraten sähe aus wie entschieden.
- Dazu eine Prüfung, die im Auftrag nicht steht und ohne die die Pfad- und Domainregeln eine
  stille Umgehung hätten: die Engine sucht Pfad und Adresse unter festen Feldnamen (`path`,
  `url`). Ein Tool mit `target_path` bekäme **keine einzige** Pfad-, Zonen- oder
  Geheimnisregel zu sehen, und niemand merkte es, weil der Aufruf ja durchliefe — der Fehler
  wäre eine Lücke, die wie eine Erlaubnis aussieht. `assertPolicyFieldNames` weist an der
  Registriergrenze jedes pfad- oder adressartige Feld ab, das anders heißt.

### Freigaben mit Geltungsbereich

- Migration `0007`: der Enum `kuronami.approval_scope` bekommt `always` (Umbenennen und
  Neuanlegen statt `ADD VALUE`, damit die Rücknahme den Zustand von `0001` wirklich
  wiederherstellt und nicht nur ungefähr). Dazu `subject`, `call_id`, `decided_by`, zwei
  CHECKs, zwei Indizes für die beiden Lesepfade und ein **partieller UNIQUE-Index**: eine
  dauerhafte Freigabe je Subjekt, strukturell statt per Anwendungslogik, nach dem Muster von
  S03/S04.
- **Abweichung von Abschnitt 10**, ausdrücklich: dort steht nur "für diese Session erlauben",
  der Sessionauftrag verlangt drei Bereiche. `once` und `session` bleiben in Bedeutung und
  Schreibweise unverändert, es kommt einer dazu.
- Zeile und Ereignis entstehen in **einer** Transaktion — Muster aus S05 (Schritte), S06
  (Artefakte), S10 (Aufgaben). Das Ereignis ist die Wahrheit; deshalb ist eine
  sessiongebundene Freigabe nach einem Neustart einfach wieder da, sie lag nie im Speicher.
  Die Zeile ist der Schnappschuss und der einzige Weg an eine **dauerhafte** Freigabe, denn
  das Protokoll ist je Session geführt und eine dauerhafte gilt darüber hinaus.
- **`once` heißt genau dieser Aufruf**, nicht "die nächste Gelegenheit": eine Freigabe, die
  ein anderer Aufruf abgreifen kann, ist an einer Stelle wirksam, an der niemand sie erteilt
  hat. Weil `call_id` stabil aus dem Plan folgt (S07), findet ein wiederaufgenommener Lauf
  seine eigene Einmalfreigabe wieder. Eine **Ablehnung** wird aus demselben Grund ebenfalls an
  die `call_id` gebunden — sonst fragte ein wiederaufgenommener Lauf denselben Menschen
  dieselbe Frage noch einmal, und ein abgelehnter Aufruf käme so lange wieder, bis jemand aus
  Versehen zustimmt. Sie ist aber bewusst **keine** Dauersperre: wer dauerhaft sperren will,
  schreibt eine Regel, und die steht in einer versionierten Datei statt in einer Zeile.
- Wofür eine Freigabe gilt, steht als **Subjektschlüssel** in Zeile und Ereignis. Die Körnung
  ist absichtlich verschieden: Geheimnisse **je Datei**, Pfade **je Zone**, Adressen **je
  Host**. Eine Freigabe je Datei sähe strenger aus, führte aber zu einer Rückfrage pro Datei —
  und ein Mensch, der zwanzigmal hintereinander gefragt wird, klickt beim einundzwanzigsten
  Mal durch. Das ist die schlechtere Sicherheit, nicht die bessere. Umgekehrt deckt eine
  Zonenfreigabe ausdrücklich **nicht** das Lesen einer `.env`: anderes Subjekt, eigene
  Freigabe.
- Zwei gleichzeitig offene Rückfragen zum selben Subjekt, beide mit "dauerhaft" beantwortet,
  liefen in den UNIQUE-Index. Statt eines Constraint-Fehlers, den der Betreiber als Absturz
  sähe, benutzt die zweite Entscheidung die bestehende Freigabe und nennt deren Kennung im
  Ereignis. Kein zweiter Eintrag, keine Frage, welcher von beiden gilt.

### Geheimnisse: Zugriff und Durchsickern sind zwei verschiedene Dinge

- `policy/secrets.ts` erkennt am **Pfad**, welche Dateien per Bauart Zugangsdaten tragen. Das
  ist die Ergänzung zum Redaction-Filter, nicht sein Ersatz: der Filter sieht Werte, die schon
  gelesen wurden, und verhindert das Durchsickern; er kann den Zugriff nicht verhindern und
  kennt nicht jedes Format. Ohne die zweite Hälfte wäre "Secrets erreichen nie den Prompt"
  eine Aussage über die Vollständigkeit der Musterliste.
- Bewusst **keine** Inhaltsheuristik: eine Datei, die erst gelesen werden muss, um als geheim
  zu gelten, ist zum Zeitpunkt der Entscheidung schon gelesen.
- Lesen eines Trägers → `ask` (eigenes Subjekt je Datei). Schreiben → `deny`, ohne Rückfrage:
  ein Assistent, der `.env` oder einen privaten Schlüssel überschreibt, macht aus einem
  Fehlgriff einen Verlust, den kein Replay zurückholt. Wer das ändern will, ändert die Regel —
  sichtbar und versioniert.
- **Vorlagen sind ausgenommen** (`.env.example` und Geschwister). Der Test hat das erzwungen:
  `.env.example` liegt seit S01 in diesem Repo und trägt keinen einzigen Wert. Eine Rückfrage
  dafür wäre offensichtlich unnötig, und offensichtlich unnötige Rückfragen bringen dem
  Menschen bei, die nächste auch wegzuklicken.
- Jeder freigegebene Zugriff auf einen Träger schreibt `policy.secret_accessed` — neuer
  Ereignistyp, aber kein neuer Namensraum, die Zahl 13 aus dem S03/S04-Test bleibt. Als Feld
  in `policy.allowed` wäre "wer hat wann welche Zugangsdatei geöffnet" nur über einen Filter
  auf einem Payload zu beantworten, also genau die Frage, die nach einem Vorfall als erste
  gestellt wird. Geschrieben wird beim Freigeben, nicht nach dem Lauf: ein protokollierter
  Zugriff, der nicht stattfand, ist harmlos; einer, der stattfand und nicht protokolliert ist,
  ist der Fall, den es zu verhindern gilt. Ob er durchlief, sagt das `tool.completed` unter
  derselben `call_id`.
- `kuronami.approvals` ist das **vierte Schreibtor des Redaction-Filters** (nach Protokoll,
  Artefaktmetadaten und Prompt-Aufbau): `requested_input` trägt die Eingabe des freigegebenen
  Aufrufs. Die Eingabe wird dabei **nicht** ins `approval.requested` dupliziert, sondern beim
  Entscheiden aus dem `tool.requested` derselben `call_id` gelesen — bei einem `fs.write` wäre
  die Verdopplung der komplette Dateiinhalt ein zweites Mal.

### Audit-Eintrag für jede ausgeführte Aktion

- Die fünf Angaben aus Abschnitt 10 stehen **nicht** in einer eigenen Tabelle und nicht in
  einem einzigen Ereignis, sondern werden über die `call_id` gefaltet: `tool.requested`
  (Auslöser, Eingaben, Zeitstempel), `policy.allowed`/`policy.denied` (Freigabepfad, wirksame
  Stufe, Freigabe), `policy.secret_accessed`, `tool.completed`/`tool.failed` (Ausgaben,
  Zeitstempel). Ein sechstes Ereignis, das alles noch einmal zusammen trägt, wäre eine zweite
  Wahrheit neben dem Protokoll — es könnte abweichen, und dann wäre offen, welche der beiden
  Fassungen der Audit ist. Die Faltung kann das nicht, sie hat keine eigenen Daten.
- Der **Freigabepfad** ist nicht eine Begründung, sondern die Kette: was jede Ebene gesagt hat.
  Ohne sie ließe sich hinterher nicht unterscheiden, ob ein Aufruf durchging, weil eine Regel
  ihn erlaubte, oder weil keine ihn verbot.
- `ToolCall.origin` neu (Vorgabe `"model"`) — der "Auslöser" aus Abschnitt 10. Die Herkunft
  ändert die Entscheidung **nicht**: ein direkt abgesetzter Aufruf bekommt dieselben vier
  Ebenen wie einer aus dem Modell, sonst wäre "ohne Modell aufrufen" der Weg an der Governance
  vorbei — und genau das ist das Fertig-Kriterium dieser Session.
- `auditGaps` findet Einträge mit Ausgang, aber ohne Entscheidung. Die Ausnahme sind die beiden
  Fehler **vor** der Policy (unbekanntes Tool, Schemaverstoß): dort wurde nichts ausgeführt und
  nichts freigegeben, ein fehlender Freigabepfad ist die richtige Auskunft und kein Loch. Die
  Prüfung ist die Kontrolle, nicht die Absicherung — getragen wird die Zusage vom `PolicyGrant`.

### Umbau an bestehendem Code

- `runtime/session/approval-log.ts` neu: Sessionsperre, Ablaufverfolgung einer `ask_id` und
  das Lesen der Optionen sind aus `user-input.ts` (S10) herausgezogen, weil die Policy
  dieselbe Mechanik für ihre Freigabe-Rückfragen benutzt. Zwei Kopien wären über kurz oder
  lang zwei Formen desselben Ereignisses, und `deriveSessionState` müsste beide falten.
  Geschrieben wird weiterhin getrennt: die Ereignisse tragen verschiedene Felder, und die
  Freigabe schreibt zusätzlich eine Zeile.
- `tools/fs/tools.ts`: `assertWritableZone` bekommt die `PolicyGrant` und ist damit kein
  hartes Verbot mehr (S08), sondern ein **Abgleich zweier unabhängiger Einschätzungen** —
  Handler und Engine lösen denselben Pfad getrennt auf, und geschrieben wird nur, wenn beide
  ihn als Schreibzugriff außerhalb der Artefaktzone sehen. Ein Handler, der sich blind auf
  "der Router hat mich ja aufgerufen" verlässt, könnte eine Fehlkonfiguration nicht bemerken.
  Die in S08 angekündigte Stelle ist damit eingelöst und die Kaskade bleibt dort festgemacht.
- `runtime/index.ts` baut die Engine mit dem ausgelieferten Regelsatz und gibt beim Start die
  Governance-Lage aus (Regeln, Hooks, Freigabemodus, Sandbox). Ein Betreiber, der nicht weiß,
  in welchem Modus seine Session läuft, kann eine Rückfrage später nicht einordnen — und ihr
  Ausbleiben schon gar nicht.

### Geänderte Erwartungen in bestehenden Tests

Alle drei Änderungen sind Folge der Sache, nicht Anpassung an sie, und stehen hier, damit sie
nicht als stille Korrektur durchgehen:

- **Ereignisfolgen** tragen jetzt `policy.allowed` zwischen `tool.requested` und
  `step.started`. Elf Zusicherungen in fünf Dateien angepasst; `router.test.ts` liest
  `tool.completed` entsprechend an Position 5 statt 4.
- **`fs.write`/`fs.edit` in die Quellzone** endet nicht mehr in einer Fehlerhülle des
  Handlers, sondern im Haltepunkt der Policy. Die maßgebliche Zusicherung ist unverändert und
  steht weiterhin da: **es wird nichts geschrieben.**
- **Pfad-Traversal** (`../../etc/passwd`, Symlink nach außen) fällt eine Ebene früher: die
  Engine löst denselben Pfad auf, bekommt denselben `PathEscapeError` und lehnt ab, bevor der
  Handler läuft (`unresolvable-resource`, fail closed). Der Wortlaut der Pfadprüfung steht
  unverändert im Freigabepfad — geglättet wird nichts, er steht nur an anderer Stelle.
- `dev.once` in `router.test.ts` ist von `hard_write` auf `soft_write` gewechselt. Die Stufe
  war dort schon immer Nebensache (geprüft wird die Ausführungshülle), seit S11 wäre sie es
  nicht mehr: der Aufruf käme gar nicht bis zur Hülle.

### Zwei Fehler, die die Tests gefunden haben

- **Der Subjektschlüssel wurde vom Redaction-Filter gefressen.** Er hieß zuerst
  `fs.read|secret:dotenv:.env`, und das Fangnetz für Schlüssel-Wert-Paare aus S07 liest
  `secret:dotenv` als Zuweisung: im Protokoll stand `fs.read|secret:[redacted:…]`, während die
  Engine beim Nachschlagen den ungefilterten Schlüssel benutzte. Eine erteilte Freigabe wurde
  nie wiedergefunden, der Lauf fragte bei jedem Aufruf erneut — und niemand hätte das für eine
  Redaction gehalten. Behoben mit `/` als Trenner, dazu eine Prüfung in der Engine: ein
  Subjekt, das der Filter verändern würde, wird abgewiesen statt als kaputter Schlüssel
  benutzt. Dieselbe Haltung wie bei `task_id` in S10 und aus demselben Grund — ein Wert, der
  wieder nachgeschlagen wird, ist eine Identität.
- **Der Redaction-Filter griff nicht auf `ANTHROPIC_API_KEY=…`.** Das Fangnetz begann mit
  `\b`, und `\b` setzt keine Grenze zwischen `_` und einem Buchstaben — der Unterstrich ist
  selbst ein Wortzeichen. `api_key=…` wurde ersetzt, `ANTHROPIC_API_KEY=…` nicht, also
  ausgerechnet nicht die Schreibweise, in der Geheimnisse in `.env`-Dateien und Umgebungen
  tatsächlich stehen. Gefunden hat es der S11-Test, der eine echte `.env` liest. Ersetzt durch
  `(?<![A-Za-z0-9])`, dazu zwei Tests in `redact.test.ts`: die Präfix-Schreibweise wird
  ersetzt, `monkey:` bleibt in Ruhe.

### Tests

- 58 neue Tests, zusammen 280. `policy/rules.test.ts` (26, **ohne Datenbank**): die vier
  Stufen und ihre Ordnung, eine fehlende Stufe wird abgewiesen statt geraten, `destructive`
  lässt nur `once` zu; Geheimnisklassen erkennen die üblichen Träger, lassen gewöhnliche
  Dateien in Ruhe, nehmen Vorlagen aus und erkennen denselben Pfad auch beim zweiten Mal
  (Gegenprobe zum `lastIndex`-Fehler); Tool-, Pfad-, Host- und Zonenbedingungen samt
  `**`-Glob; ein breites `allow` schaltet ein `deny` in **beiden** Reihenfolgen nicht ab; eine
  Regel kann nicht senken; der ausgelieferte Regelsatz hebt Schreiben außerhalb der
  Artefaktzone an und lässt Lesen dort unangetastet; Hooks: Enthaltung, Verschärfung, ein
  geworfener Hook gilt als Ablehnung und behält den Wortlaut, nach dem ersten `deny` wird
  abgebrochen; Ressourcenerkennung, Subjektkörnung, Überleben des Redaction-Filters, und die
  erzwungene Feldnamenkonvention.
- `policy/engine.test.ts` (17, mit Datenbank, über den echten Router), darunter das
  **Fertig-Kriterium**: ein `hard_write`-Tool direkt aufgerufen (`origin: "direct"`), ohne
  Modell, ohne Freigabe → `ApprovalRequiredError`, **nichts verschickt, keine Datei auf der
  Platte**, kein Schritt, Session auf `awaiting_user`, und die Rückfrage nennt Tool, Stufe,
  Subjekt und die angebotenen Geltungsbereiche. Dazu dasselbe für `fs.write` in die Quellzone
  (echtes hartes Schreiben über die Regel) und der Gegenbeweis, dass derselbe Aufruf nach der
  Freigabe durchläuft und den Freigabepfad mitschreibt. Weiter: Hook-Ablehnung, abstürzender
  Hook, Hook verschärft ein Lesen; `.env` lesen fragt und protokolliert den Zugriff, während
  das Protokoll den Wert nicht im Klartext trägt; `.env.example` fragt nicht; `.env`
  überschreiben wird endgültig abgelehnt, ohne Rückfrage; eine Zonenfreigabe deckt das Lesen
  eines Trägers nicht; `accept_edits` lässt Dateiänderungen durch, deckt hartes Schreiben ohne
  Pfad nicht und hebt keine Regel auf; `bypass_in_sandbox` greift nur mit Nachweis; **kein
  Modus** hebt die Freigabepflicht für zerstörende Aktionen auf, und dort werden nur `once`
  und `deny` angeboten; ein Tool ohne Stufe wird von der Registry **und** von der Engine
  abgewiesen.
- `policy/approvals.test.ts` (10, mit Datenbank): `once` deckt genau seinen Aufruf und findet
  sich bei einer Wiederholung wieder; `session` deckt weitere Aufrufe derselben Session, aber
  keine andere; `always` gilt über Sessiongrenzen und legt je Subjekt nur eine Zeile an; eine
  Ablehnung haftet an ihrem Aufruf; eine zweite Entscheidung und eine nicht angebotene Option
  werden abgewiesen; Protokoll-Faltung und Tabellen-Schnappschuss stimmen überein. Und der
  **Neustart-Nachweis** mit einem echten zweiten Betriebssystem-Prozess
  (`policy-resume.process.ts`, Muster aus S05/S10): Lauf 1 hält sauber an und schreibt nichts,
  der Mensch erteilt zwischen den Prozessen eine Session-Freigabe, ein **frisch gestarteter**
  Prozess mit **anderer** `call_id` und **anderer** Datei läuft durch. Die Freigabe kann damit
  nicht aus einem Speicher im Prozess gekommen sein; zusätzlich wird sie allein aus dem
  Protokoll gefaltet.
- `policy/audit.test.ts` (3, mit Datenbank): ein Lauf aus sechs Aufrufen — erlaubtes Lesen,
  weiches Schreiben, freigegebener Geheimniszugriff, Ablehnung durch eine Regel, unbekanntes
  Tool, Schemaverstoß — ergibt sechs Einträge, **keine Lücke**, und jeder Eintrag, der die
  Policy erreicht hat, trägt alle fünf Angaben; `audit_id` verbindet Entscheidung und Ausgang;
  eine Gegenprobe, die eine echte Lücke konstruiert, wird gefunden.
- `runtime/redaction/redact.test.ts` um 2 auf 19 gewachsen (siehe oben).
- Sechs Gegenproben, alle bestätigt und danach zurückgesetzt:
  * Boden für `hard_write` auf `allow` gesenkt → 19 Tests rot, darunter beide Hälften des
    Fertig-Kriteriums und der Neustart-Nachweis.
  * Ablehnungszweig im Router entfernt → 8 rot.
  * Hooks fail-open statt fail-closed → 2 rot.
  * `destructive` darf sessionweit freigegeben werden → 2 rot.
  * Subjekt-Trenner zurück auf `:` → 5 rot; die neue Engine-Prüfung fängt es jetzt als
    Ablehnung ab, statt still weiterzufragen.
  * Risikoprüfung aus der Registry entfernt → 1 rot.
- Migration verifiziert: `down` (nimmt nur 0007 zurück; `approvals` steht wieder in exakt der
  0001-Form — 11 Spalten, 4 Indizes, Enum `once, session`, keine der drei neuen Constraints),
  danach `up` (14 Spalten, 7 Indizes darunter `idx_approvals_persistent_subject`,
  Enum `once, session, always`, Tracking-Zeilen 0001 bis 0007).
- Nachweis außerhalb von vitest (`_s11_probe.ts`, danach gelöscht): gegen die echte Datenbank
  den Katalog wie `runtime/index.ts` gebaut (10 Tools, `v1-53a18ba0cb4e49c8`, 4 Regeln, Sandbox
  aus) und eine echte Session eröffnet. `fs.write` in die Quellzone direkt aufgerufen →
  blockiert, keine Datei, Sessionstatus `awaiting_user`; nach `once` durchgelaufen und die
  Datei da; ein zweiter Schreibzugriff in derselben Zone fragt erneut; `.env` lesen fragt,
  läuft nach der Freigabe durch und schreibt `policy.secret_accessed`; `.env` überschreiben →
  `policy_denied` ohne Rückfrage. 23 Ereignisse, lückenlos; Audit mit 4 Einträgen und 0 Lücken;
  keiner der Werte aus der echten `.env` steht im Klartext im Protokoll. Danach
  `runtime/index.ts` gestartet: Session angelegt, Katalog und Governance-Lage ausgegeben.
  Probedaten und Probedateien gelöscht, alle sechs Tabellen nach dem Lauf leer.
- **Ein Beinahe-Fehlalarm, festgehalten weil er wiederkommt:** die erste Fassung der
  Leck-Prüfung im Probelauf meldete ein Geheimnis im Protokoll. Es war keins. Der
  Entwicklungs-`DATABASE_URL` hat Benutzer, Passwort und Datenbanknamen identisch, und der
  Filter lässt Schema und Benutzer bewusst stehen (S07) — eine Teilstring-Suche findet das
  Passwort dann in der Benutzerstelle. Die Prüfung sucht das Passwort jetzt **an seiner
  Stelle** in der URL; das Passwortfeld selbst trägt `[redacted:url-credentials]`.

### Bewusst nicht gebaut

- Ein Editor oder eine Oberfläche für Regeln. `DEFAULT_RULES` ist eine versionierte Datei, und
  das ist der Punkt: eine Regeländerung soll in einem Diff auftauchen.
- Zeitlich begrenzte Freigaben ("für die nächste Stunde"). Der Geltungsbereich ist heute
  `once`/`session`/`always`; eine Ablauffrist wäre eine vierte Achse und braucht einen Grund
  aus dem Betrieb, nicht aus der Vorstellung.
- Der Sandbox-Nachweis. Er kommt mit `exec.run` und dem Container (Abschnitt 4.6); bis dahin
  ist `bypass_in_sandbox` sichtbar wirkungslos statt still wirksam.
- Ein Widerruf von Freigaben (`approval.revoked`). Heute löscht man die Zeile; sobald es dafür
  eine Oberfläche gibt, gehört der Widerruf ins Protokoll wie alles andere.
- Domain-Regeln im ausgelieferten Satz. Die Achse ist gebaut und getestet, aber der
  Egress-Riegel aus S09 ist die schärfere Kontrolle; ein zweiter Vorgabesatz an derselben
  Stelle wäre Rauschen.
- Die Schleife über Schritte (S12), der Alias-Layer für Artefakt-URIs (seit S06 offen) und ein
  GC-Lauf für verwaiste Artefaktdateien (seit S06 offen).

### Offene Befunde

- Die Rückfrage erreicht bis S16 keinen Kanal. `decidePolicyApproval` ruft der Betreiber bzw.
  der Test direkt, wie schon `answerUserInput` in S10. Der Wartezustand ist im Protokoll
  vollständig da; es fehlt nur der Weg nach draußen.
- `policy.allowed` wird für **jeden** Aufruf geschrieben, auch für jedes Lesen. Das ist die
  Zusage "Audit-Eintrag für jede ausgeführte Aktion" wörtlich genommen und verdoppelt die
  Ereigniszahl eines lesenden Laufs ungefähr. Sollte das Protokoll dadurch unhandlich werden,
  ist die Antwort eine Aufbewahrungsfrist, nicht ein selektives Protokollieren.
- Der Subjektschlüssel schneidet Pfade je Zone. Für einen Einzelnutzer ist das richtig; sobald
  ein Agent im Auftrag mehrerer Menschen schreibt (S19/S20), ist zu entscheiden, ob die
  Zonenfreigabe je Agent getrennt gehört.
- `structured.reason` ist weiterhin eine Verabredung und kein Typ (offen seit S07); mit
  `policy_denied` ist ein weiterer Wert dazugekommen. Sobald S12 darauf verzweigt, gehört die
  Liste in eine Aufzählung.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 280 Tests.
- `tasks.json`: S11 auf `done`, S12 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S12 Erster echter Loop.

## S12 · Erster echter Loop · 2026-09-08

Der Meilenstein von Phase 1: Modellanbindung und Plan-Handeln-Prüfen-Schleife.

- Tests der Vorsession vorab gelaufen: 280 grün (health, events, session, steps, artifacts,
  redaction, tasks, tools/registry, tools/router, tools/fs, tools/web, tools/task, tools/user,
  policy), unverändert. `pnpm typecheck` und `pnpm lint` ebenfalls.
- Keine Migration. Die Schleife braucht keine Tabelle und keine Spalte, die nicht schon
  dasteht — sie schreibt ausschließlich Ereignisse, und `type` ist seit S03 offen. Vier Typen
  aus der Taxonomie (Abschnitt 4.4) werden damit zum ersten Mal wirklich benutzt:
  `turn.started`, `turn.completed`, `model.requested`, `model.responded`. Dazu die beiden
  Schreiber für `session.completed` und `session.failed`, die seit S05 offen notiert waren.
- Neue Verzeichnisse `runtime/model/` (Vertrag und Anbieter) und `runtime/loop/` (Schleife und
  API-Oberfläche), dazu vier Module in `context/`. **Kein neuer Ordner auf oberster Ebene**:
  Abschnitt 3 nennt fünf Schichten, und beide neuen Verzeichnisse sind Unterordner von
  `runtime/` nach dem Muster von `steps/`, `session/`, `artifacts/`.
- Eine neue Abhängigkeit, die erste seit `pg`: `@anthropic-ai/sdk`. Begründung unten.

### Die eine Entscheidung, an der alles hängt: der Kontext ist eine Faltung

- `context/transcript.ts`: `deriveLoopState(events)` baut die **gesamte Gesprächshistorie** aus
  dem Ereignisprotokoll — dieselbe Bauart wie `deriveSessionState` (S05) und `derivePlan`
  (S10), eine reine Funktion über Ereignisse.
- Der naheliegende Weg wäre gewesen, die Nachrichten im Prozess mitzuführen und bei jedem Zug
  anzuhängen: zwanzig Zeilen, kostet nichts. Er hat nur eine Eigenschaft, die ihn ausschließt —
  der Kontext läge im Arbeitsspeicher, und ein abgeschossener Prozess nähme ihn mit. Das
  Fertig-Kriterium sagt aber wörtlich "einen erzwungenen Neustart in der Mitte überleben", und
  überleben kann nur, was nie im Prozess lag.
- Drei Zusagen folgen daraus aus der **Bauart** statt aus Sorgfalt:
  * Die Wiederaufnahme braucht keinen Sonderweg. Ein frisch gestarteter Prozess faltet und
    steht da, wo der abgeschossene stand.
  * **Fehlgeschlagene Schritte bleiben im Kontext sichtbar** (Auftrag, Abschnitt 7). Sie stehen
    im Protokoll, also stehen sie in der Historie — es gibt keinen Zweig, der sie überspringen
    könnte, und damit auch keinen, den jemand versehentlich einbaut.
  * **Kein ungefilterter Text erreicht den Prompt.** Die Signatur nimmt Ereignisse entgegen und
    sonst nichts, und die sind am Schreibtor des Protokolls gefiltert (S03). Dasselbe Argument
    wie bei `headArtifact`, das kein `root` bekommt (S06).
- Der Preis: bei jedem Zyklus wird das Protokoll neu gelesen und gefaltet, also O(Züge × Log).
  Bewusst so. Eine mitlaufende Fassung im Speicher wäre eine zweite Herleitung neben der
  Faltung, und genau solche Paare laufen auseinander — es ist die Fehlerklasse, gegen die seit
  S05 jeder Replay-Test steht. Wird es zu langsam, ist die Antwort ein Zwischenstand mit einem
  Ereignis dahinter, nicht ein Zähler ohne.

### Wo die Ergebnis-Hülle steht, und warum genau einmal

- Für die Historie braucht der Loop die vollständige Rückgabehülle jedes Aufrufs. S07 hatte sie
  bewusst nur ins `step.completed` geschrieben und nicht ins `tool.completed` ("verdoppelte das
  Protokoll, ohne etwas herzuleiten") — jetzt wird etwas daraus hergeleitet, die Begründung
  trägt also nicht mehr unverändert.
- **Die Regel lautet ab S12: die Hülle steht in dem Ereignis, das den Ausgang trägt, und nur
  dort.** Bei einem Schritt-Tool ist das `step.completed`; bei einem `execution: "runtime"`-Tool
  (`task.*`, `user.ask`) gibt es keinen Schritt, also steht sie im `tool.completed`. Die
  Faltung verbindet beide über die `step_id`. Sie in beide zu schreiben wäre eine zweite
  Wahrheit, die abweichen kann; sie in keines zu schreiben, hieße nach einem Neustart die
  Antwort eines `user.ask` zu verlieren.
- Dazu ein zweites Feld im `tool.completed`: `offloaded`. Ein Auszug wie `summary` und
  `artifact_refs`, keine zweite Wahrheit — die Auskunft *dass* ausgelagert wurde, ohne dafür die
  Hülle des Schritts aufzumachen. Es trägt die Kennzahl "Anteil ausgelagerter Tool-Ergebnisse"
  aus Abschnitt 12.

### Prompt-Aufbau: sechs Abschnitte, drei Sendeplätze, drei Haltepunkte

- Der Auftrag nennt sechs Teile in bindender Reihenfolge, die API kennt drei Plätze. Die
  Zuordnung steht in `context/request.ts`: Tool-Stubs in `tools`, statischer System-Prompt und
  AGENTS.md-Konventionen in `system`, Sessionzustand + Historie + aktuelle Eingabe in
  `messages`.
- Dass die Stubs damit **vor** dem System-Prompt liegen, ist keine Umsortierung des Auftrags,
  sondern seine Umsetzung: Abschnitt 7 sagt wörtlich "Die Cache-Hierarchie läuft von Tools über
  System-Prompt zu Nachrichten". Die Liste ordnet die Inhalte, die Hierarchie ordnet die Bytes;
  wo beide sich berühren, gewinnt die Hierarchie, denn sie ist die Aussage über den Cache.
  Innerhalb jedes Platzes bleibt die Reihenfolge des Auftrags.
- **Drei ausdrücklich gesetzte Haltepunkte**, nicht als Nebenwirkung im Client, sondern als Feld
  im Anfragetyp: hinter dem letzten Tool (der Katalog ändert sich in einer Session nie), hinter
  dem letzten System-Block (einmal beim Start gelesen), hinter der letzten Nachricht (die
  Historie ist append-only). Der vierte mögliche bleibt **frei**: ihn zu setzen hieße, eine
  zweite Stelle in einer wachsenden Historie zu markieren, und die läge nach jedem Zug woanders
  — also genau die Cache-Entwertung, die zu vermeiden der Zweck der Übung ist.
- Der Sessionzustand steht in der **Nachricht** und nicht im System-Prompt. Abschnitt 7 sagt es
  ausdrücklich; ein Zustand im System-Prompt entwertete bei jedem Zug alles darunter. Er wird
  einmal je Zug gerendert (Plan aus `kuronami.tasks`) und wandert dann unveränderlich in die
  Historie.
- `loadConventions()` liest AGENTS.md **einmal beim Start** und nicht bei jedem Zug. Das ist
  kein Zierrat: das Modell darf die Datei mit `fs.edit` verändern, und ein Prompt-Aufbau, der
  sie jedes Mal neu läse, bräche nach einer solchen Bearbeitung lautlos den ganzen Cache.
  Dieselbe Zusage wie beim eingefrorenen Tool-Katalog (S07).
- **Gefundene Hürde, die keine Vermutung war:** die API erlaubt in Toolnamen `[a-zA-Z0-9_-]` und
  **keinen Punkt**. Unsere Konvention ist `namensraum.aktion` (Abschnitt 4.8) und steht in
  AGENTS.md, im Protokoll, in den Policy-Regeln und in jedem bisherigen Test. Also wird
  übersetzt, an genau einer Stelle: `fs.read` wird zu `fs__read`. Eindeutig, weil ein Namensraum
  nur Buchstaben enthält — das erste `__` ist immer der Trenner. `toolNameDecoder` baut die
  Rückübersetzung aus dem Katalog und wirft bei einer Kollision, die es heute nicht geben kann;
  sie kostet nichts und fällt an dem Tag, an dem ein Namensraum einen Unterstrich bekommt.
- `strict: true` auf jedem Tool. Unser Schema wird zu JSON Schema mit
  `additionalProperties: false` und `required` — was genau das wiedergibt, was
  `validateToolInput` seit S07 ohnehin durchsetzt. Der Router prüft weiter selbst (er ist das
  Tor, nicht der Anbieter), aber ein Zug, der nur an einem fehlenden Feld scheitert, kostet
  damit keinen Schritt aus dem Budget.

### Die Modellanbindung

- `runtime/model/types.ts` ist der Vertrag, `anthropic.ts` die einzige Datei im Projekt, die das
  SDK kennt. Injiziert und nicht importiert — dieselbe Überlegung wie bei `fetchImpl` in
  `web.fetch` (S09): ein Loop, der fest an einem HTTP-Aufruf hängt, ist nicht prüfbar, weil er
  Geld kostet, Netz braucht und bei jedem Lauf anders antwortet.
- **Neue Abhängigkeit `@anthropic-ai/sdk`, und warum das kein Bruch mit Abschnitt 4.2 ist.**
  "Kein ORM" ist eine Aussage über Abstraktionen, die sich zwischen den Code und sein
  Datenmodell stellen, keine über Anbieter-Clients — `pg` steht seit S01 aus demselben Grund da.
  Das Drahtformat der Messages-API ist nichts, was man nebenbei nachbaut: Blocktypen,
  `cache_control`, Werkzeugaufrufe, Fehlerklassen. Der Vertrag darüber macht die Abhängigkeit
  außerdem austauschbar: ein zweites Modell (Abschnitt 11) kostet eine Datei neben dieser.
- **`ModelResponse.content` trägt die Antwort roh**, und das `model.responded` schreibt sie so
  ins Protokoll. Grund: Denken bleibt an (auf dieser Modellklasse ist es die Vorgabe), und ein
  `thinking`-Block trägt eine **Signatur**, die der Anbieter beim Fortsetzen eines Werkzeuglaufs
  prüft. Ein neu gebauter Block bräche den nächsten Zug. Also gehen die Blöcke unverändert
  hinein und unverändert wieder hinaus.
  Das Denken abzuschalten wäre die Alternative gewesen und ist verworfen: auf dieser Klasse hat
  es zwei bekannte Fehlbilder, darunter ein Werkzeugaufruf, der als Fließtext statt als
  `tool_use` erscheint — der Aufruf läuft dann nie, ohne dass irgendwo ein Fehler entsteht. In
  einer Schleife über dreißig Schritte ist das besonders teuer.
- Damit kommt der Redaction-Filter an eine Stelle, an der er etwas kaputt machen **könnte**: er
  sieht die Blöcke auf dem Weg ins Protokoll. `assertReplayable` prüft deshalb nach jedem
  Schreiben, dass drei Dinge unverändert geblieben sind — `tool_use.id` (er wird zum
  Idempotenzschlüssel), `tool_use.name` (er wählt das Tool) und die `signature`. Text darf der
  Filter ersetzen, dafür ist er da. Dieselbe Haltung wie bei `task_id` (S10) und beim
  Subjektschlüssel der Policy (S11): lieber abweisen als mit einem kaputten Schlüssel
  weiterlaufen, denn der Bruch fiele sonst erst beim nächsten Zug auf und sähe dort nach einem
  Anbieterfehler aus.

### Die Schleife und ihre vier Abbruchbedingungen

- `runtime/loop/loop.ts` ist absichtlich klein, und die Größe ist die Aussage: Idempotenz steht
  in der Ausführungshülle (S05), Auslagerung im Router (S07), Freigaben in der Engine (S11),
  Kontext in der Faltung. Was bleibt, ist die Frage, wann gefragt, gehandelt und aufgehört wird.
- **Offene Aufrufe zuerst, dann erst das Modell.** Das ist der Wiederaufnahmepunkt und keine
  Optimierung: nach einem Absturz zwischen `model.responded` und dem Werkzeugaufruf stünde sonst
  eine zweite Modellantwort in der Historie, während die erste `tool_use`-Blöcke ohne Ergebnis
  hinterließe — und eine solche Historie weist der Anbieter ab. `assertSendable` macht daraus
  einen benannten Fehler an der Stelle, an der er entsteht, statt einer 400, die man
  zurückverfolgen muss.
- **fertig** — das Modell antwortet ohne Werkzeugaufruf. **Freigabe nötig** — die Policy oder
  `user.ask` hält an; der Zug wird **nicht** abgeschlossen, er bleibt offen, damit die Antwort
  ihn an derselben Stelle fortsetzt. **Schrittobergrenze** — Vorgabe 50, unteres Ende von
  Abschnitt 13. **Fehlerhäufung** — Vorgabe 5 Fehlschläge **in Folge**.
- Dass die Fehlerhäufung in Folge zählt und nicht insgesamt, ist der ganze Gehalt der Kennzahl.
  Ein Lauf mit fünf Fehlschlägen auf dreißig Schritte arbeitet — er stößt an Grenzen und findet
  Wege daran vorbei, und genau dafür bleiben Fehler im Kontext sichtbar. Ein Lauf mit fünf
  Fehlschlägen nacheinander lernt nichts aus ihnen. Eine Gesamtzahl beendete den erfolgreichen
  langen Lauf und ließe den kurzen im Kreis laufen, also genau verkehrt herum.
- Nur der erste Ausgang ist ein Erfolg. `turn.completed` trägt immer den Grund; die
  API-Oberfläche schreibt darüber hinaus `session.completed` bei `done` und `session.failed` bei
  Schrittobergrenze und Fehlerhäufung — ein Lauf, der an einer Grenze endet und nichts
  hinterließe, sähe später aus wie einer, an dem gerade niemand weiterarbeitet.

### Die kleine API-Oberfläche

- `runtime/loop/api.ts`: fünf Verben, keines davon neu — `run`, `answer`, `cancel`, `status`,
  `stop`. Alle fünf sind Verdrahtung über Bausteine aus S04 bis S11. `answer` nimmt beide Arten
  von Rückfrage entgegen und unterscheidet am Präfix der `ask_id` (`policy:` aus S11, `ask:` aus
  S10): der Aufrufer hat die Kennung aus dem Wartezustand bekommen und muss die Unterscheidung
  nicht selbst treffen.
- Was hier **nicht** steht, ist ebenso Absicht: kein HTTP, kein Port, keine Authentifizierung.
  Die Oberfläche nach draußen ist die Surface-Schicht, und die ist austauschbar (Abschnitt 3,
  harte Regel) — eine Runtime, die schon einen Server mitbrächte, wäre von ihr abhängig.
- Die Verdrahtung des ausgelieferten Katalogs ist aus `runtime/index.ts` hierher gewandert
  (`buildCatalog`). Damit bekommen Prozess, Test und Probelauf denselben Katalog, und der
  eingefrorene Katalog ist nur so viel wert, wie er an allen Stellen derselbe ist. Der
  Fingerabdruck ist unverändert `v1-53a18ba0cb4e49c8` mit zehn Tools — S12 fügt kein Tool hinzu,
  und das soll man sehen können.
- `runtime/index.ts` kann jetzt zweierlei: ohne Argument das Skelett aus S04, mit einer Eingabe
  als Argument einen vollständigen Lauf (`pnpm run:task "<Aufgabe>"`).

### Kompaktierung Stufe 0 und 1

- Beide waren bereits gebaut (Stufe 0 in jedem Tool seit S08/S09, Stufe 1 im Router seit S07)
  und mussten in der Schleife nur nicht kaputtgehen. Nachgewiesen wird das jetzt am fertigen
  Prompt: eine 418-KB-Datei gelesen ergibt eine Historie unter 8 KB, mit Ausschnitt und Handle
  und ohne den Rumpf.
- **Dabei ein Zählfehler gefunden.** Die Kennzahl "Anteil ausgelagerter Tool-Ergebnisse" hing
  zuerst allein an der Marke, die der Router setzt (`structured.offloaded`). Damit ergab ein
  Lauf, der eine 418-KB-Datei liest, einen Anteil von **null** — denn `fs.read` (S08) und
  `web.fetch` (S09) lagern **selbst** aus und halten ihre Hülle absichtlich unter der
  Router-Schwelle, damit der typisierte Ausschnitt erhalten bleibt. Die Auslagerung fand statt,
  nur eine Ebene tiefer. Gezählt wird jetzt beides, an derselben Definition in Router und
  Faltung: ein Ergebnis gilt als ausgelagert, wenn es hinter einem Handle liegt.
- Stufe 2 bis 4 sind **nicht** gebaut (siehe unten). `context.compacted` bleibt deshalb
  ungeschrieben: die Auslagerung nach Stufe 1 steht bereits als `artifact.created` im Protokoll,
  und ein zweiter Name für dasselbe Ereignis wäre genau die Doppelschreibweise, die Abschnitt
  4.4 verbietet.

### Ein Fehler, den die Tests gefunden haben

- **Ein Abbruch der Session verbrannte fünf Modellaufrufe.** `SessionCanceledError` kam aus der
  Ausführungshülle und wurde vom Router zur Fehlerhülle gemacht (`step_refused`). Das Modell las
  "Schritt nicht ausgeführt", wählte einen anderen Weg, bekam dieselbe Auskunft — und der Lauf
  lief nach dem Abbruch durch den Nutzer weiter, bis die Fehlerhäufung griff. Sichtbar wurde das
  nie, weil jeder einzelne Schritt sich korrekt verhielt.
- Der Abbruch läuft jetzt **durch** den Router, wie `ToolCatalogMismatchError` (S07),
  `UserInputRequiredError` (S10) und `ApprovalRequiredError` (S11). Er ist keine Antwort auf den
  Aufruf, sondern die Aussage, dass der Lauf vorbei ist. Die übrigen Weigerungen der Hülle
  (offener Schritt, nicht wiederholbar, Versuche verbraucht) bleiben Fehlerhüllen — sie sind
  eine Antwort, und das Modell kann etwas anderes versuchen.
- Damit ist auch der seit S08 offene Befund zur Hälfte eingelöst: die Schleife verzweigt jetzt
  tatsächlich auf eine Lage, und zwar nicht über den Meldungstext, sondern über den Typ.

### Tests

- 45 neue Tests, zusammen 325.
- `context/transcript.test.ts` (19, **ohne Datenbank**): Eröffnungsnachricht mit Zustand und
  Eingabe in dieser Reihenfolge; Blöcke einer Antwort unverändert durchgereicht samt Denkblock;
  Hülle eines Schritt-Tools aus dem `step.completed`, die eines Runtime-Tools aus dem
  `tool.completed`; ein Fehlschlag bleibt mit Grund und Stacktrace sichtbar; mehrere Ergebnisse
  werden zu **einer** Nachricht zusammengefasst (auf zwei verteilt brächte es dem Modell bei,
  keine nebenläufigen Aufrufe mehr zu machen); offene Aufrufe nach einem Absturz mitten in einer
  Runde; Zähler und offene Aufrufe beim neuen Zug zurückgesetzt, Historie bleibt vollständig;
  Fehler in Folge gegen Fehler insgesamt; ausgelagerte Ergebnisse gezählt; unbekannte Typen
  übersprungen; zwei Fälle, in denen die Faltung zu Recht wirft. Dazu `assertSendable` (2) und
  `assertReplayable` (4).
- `context/request.test.ts` (9, **ohne Datenbank**): Namensübersetzung hin und zurück über den
  ganzen Katalog, Kollision abgewiesen; genau drei Haltepunkte an den drei genannten Stellen und
  der vierte frei; Reihenfolge System-Prompt vor Konventionen; **byteweise gleicher Präfix bei
  gleichem Inhalt** und Sortierung von Tools und Schemafeldern — die Bedingung, unter der
  Prompt-Caching überhaupt greift; `required` und `additionalProperties: false`; Redaction über
  System-Prompt, Konventionen und Tool-Beschreibungen samt Gegenprobe, dass das Unverdächtige
  stehen bleibt.
- `runtime/model/anthropic.test.ts` (8, **ohne Datenbank und ohne Netz**): der SDK-Aufruf wird
  abgefangen und die **Abbildung** geprüft — Werkzeugnamen ohne Punkt, geschlossenes Schema mit
  `strict`, `cache_control` an genau drei Stellen, `thinking: adaptive`, `max_tokens`
  durchgereicht, kein `output_config` ohne ausdrückliche Angabe; ein Denkblock geht samt Signatur
  unverändert wieder hinein; eine Antwort wird in Text, Aufrufe und rohe Blöcke zerlegt;
  fehlende Cache-Angaben werden null und nicht erfunden; der Wortlaut des Anbieters bleibt im
  Fehler erhalten.
- `runtime/loop/loop.test.ts` (8, mit Datenbank, echtem Router, echter Policy und echten
  `fs.*`-Tools; nur das Modell ist ein Drehbuch), darunter das **Fertig-Kriterium**: eine Aufgabe
  mit **30 Schritten** (Plan setzen, 28 Dateien schreiben, eine wieder lesen) läuft vollständig
  durch — 30 `tool.completed`, kein `tool.failed`, 31 Modellaufrufe, 29 Schritt-Zeilen
  (`task.set` läuft als Runtime-Tool ohne Schritt), die Dateien liegen mit dem richtigen Inhalt
  auf der Platte, das Protokoll ist lückenlos und endet auf `session.completed`, und Replay
  ergibt denselben Zustand wie der Schnappschuss.
  Dazu: **Freigabestelle** — ein Schreibzugriff in die Quellzone hält den Lauf an, es wird
  **nichts** geschrieben, die Session steht auf `awaiting_user`, die Rückfrage bietet
  `once/session/always/deny`, und der Zug bleibt **offen** (kein `turn.completed`); nach `once`
  läuft derselbe Zug weiter und endet auf `done`.
  Weiter: der Tool-Katalog ist über alle neun Aufrufe **byteweise** unverändert und die Historie
  wächst nur hinten an (Append-only als Zusicherung, nicht als Absicht); drei Haltepunkte je
  Aufruf und eine messbare Trefferquote; Schrittobergrenze und Fehlerhäufung enden ohne
  `session.completed`, und der letzte Prompt trägt dabei jeden Fehlschlag mitsamt Grund; Abbruch
  mitten im Lauf; Kontextstufe 1 mit einer 418-KB-Datei.
- `runtime/loop/loop-restart.test.ts` (1, **echter Betriebssystem-Prozess**): der zweite Teil des
  Fertig-Kriteriums. Ein Prozess läuft die 30-Schritt-Aufgabe, bleibt beim 13. Aufruf im Werkzeug
  hängen und wird mit `SIGKILL` abgeschossen. Geprüft im Zwischenzustand: zwölf Aufrufe erledigt,
  der dreizehnte **offen**, sein Schritt auf `running`, kein `runtime.stopped`, kein
  `turn.completed`. Danach ein **frisch gestarteter** Prozess, der nur die Datenbank kennt: er
  läuft bis 30 durch, **ein** Zug (kein zweiter), 30 verschiedene Aufrufkennungen, 29
  Schritt-Zeilen, der unterbrochene Schritt ist derselbe mit Versuch 2 — also kein zweiter
  Schritt für dieselbe Arbeit —, und jedes doppelte `tool.completed` trägt `executed: false`, das
  Ergebnis kam aus der Zeile. Replay gleich Schnappschuss über den Absturz hinweg.

### Gegenproben

Sechs, alle bestätigt und danach zurückgesetzt:

- **Offene Aufrufe ignorieren** (erst fragen, dann handeln) → Neustart-Nachweis und
  Freigabe-Test rot, mit genau der Meldung, für die `assertSendable` da ist.
- **Cache-Haltepunkt hinter den Tools entfernt** → "genau drei Haltepunkte" rot (2 statt 3).
- **Fehler insgesamt statt in Folge gezählt** → "zählt Fehler in Folge" rot (2 statt 1).
- **`SessionCanceledError` wieder als Fehlerhülle** (der Zustand vor S12) → der Abbruch-Test rot
  mit `error_rate` statt `canceled`. Der oben beschriebene Fehler hängt also wirklich an dieser
  Zeile.
- **Fehlgeschlagene Aufrufe nicht in die Historie aufnehmen** → drei Faltungstests rot **und** der
  Fehlerhäufungs-Test läuft in den 60-Sekunden-Timeout. Das ist der aussagekräftigste Befund der
  Reihe: ohne sichtbare Fehlschläge sieht das Modell die Ergebnisse nie, die offenen Aufrufe
  werden nie leer, und die Schleife dreht sich endlos. "Fehler nicht verstecken" ist hier keine
  Haltung, sondern eine Abbruchbedingung.
- **Aufrufkennungen zufällig statt fest** im Drehbuch → der Neustart-Nachweis wird rot, aber nur
  an der Namenszusicherung. Festgehalten, weil es das Gegenteil dessen zeigt, was man vermuten
  würde: die feste Kennung ist eine Eigenschaft des Prüf-Drehbuchs und **nicht** tragend. Die
  Wiederaufnahme hängt daran, dass die offenen Aufrufe aus dem **Protokoll** kommen; deren
  Kennungen sind dort schon vergeben, gleich wie sie entstanden sind.

### Ein Befund beim Gegenproben, der den Nachweis erst tragfähig gemacht hat

- Die erste Fassung des Neustart-Tests schoss den Prozess ab, nachdem er zwölf Aufrufe gemeldet
  hatte. Die Gegenprobe "offene Aufrufe ignorieren" blieb dabei **grün** — der Abschuss war
  zwischen zwei Zyklen gelandet, also in dem Fenster, in dem gar nichts offen ist. Der Nachweis
  prüfte die Wiederaufnahme damit gar nicht, und niemand hätte es gemerkt.
- Behoben mit einem Prüf-Werkzeug `dev.hang` im Absturzprozess, das im ersten Lauf hängen bleibt
  und im Wiederaufnahmelauf zurückkommt. Der Abschuss trifft jetzt **deterministisch** das
  Fenster nach `model.responded` und `step.started` und vor `step.completed` — also genau die
  Lücke, die ein abgestürzter Prozess hinterlässt. Danach ist die Gegenprobe rot.

### Ein Fehler in `runtime/index.ts`, den der Probelauf gefunden hat

- Beim Umbau war `clearInterval` für den Lebendhalte-Anker in den `exit`-Behandler gewandert
  statt ins Herunterfahren. Ein sauberer Stop hätte den Prozess damit ewig weiterlaufen lassen:
  `runtime.stopped` geschrieben, Pool geschlossen, und der Timer hielte ihn am Leben.
  Zurückgelegt ins Herunterfahren, wo er seit S04 hingehört.

### Probelauf und was daran nicht nachgewiesen ist

- Der Probelauf gegen die **echte Claude API** konnte **nicht** stattfinden: `ANTHROPIC_API_KEY`
  ist leer und die `ant`-CLI ist auf diesem Rechner nicht installiert. Das ist der einzige Teil
  des Auftrags, der unbewiesen bleibt, und er wird hier benannt statt weggelassen. Nachweisbar
  wäre damit: dass die API diese Anfrage annimmt (Namensform, `strict`, die Blockfolge mit
  Denkblöcken) und dass der Cache wirklich greift.
  Der Befehl dafür ist die gebaute Oberfläche selbst — Schlüssel in `.env` eintragen, dann
  `pnpm run:task "Lege einen Plan an, schreibe zwei Dateien nach artifacts/ und lies eine wieder
  ein."`; die Trefferquote steht danach in der Schlusszeile und je Aufruf im `model.responded`.
  Bis dahin deckt `runtime/model/anthropic.test.ts` alles ab, was diesseits des Netzes liegt.
- Nachweis außerhalb von vitest, der ohne Schlüssel geht: `runtime/index.ts` gegen die echte
  Datenbank gestartet. Session angelegt, Katalog `v1-53a18ba0cb4e49c8` mit zehn Tools,
  Governance-Lage ausgegeben (4 Regeln, 0 Hooks, Freigabemodus `ask`, Sandbox nicht
  nachgewiesen), Modell sichtbar als "kein Modell (ANTHROPIC_API_KEY fehlt)" statt als Absturz
  beim ersten Zug. Probedaten gelöscht.
- Der volle Testlauf hinterlässt nichts: alle sechs `kuronami`-Tabellen sind danach leer, eigens
  nachgesehen. (Ein Zwischenstand mit acht Waisen-Sessions kam aus den absichtlich
  fehlschlagenden Gegenproben, darunter eine mit Timeout — dort läuft `afterAll` nicht mehr
  vollständig. Aufgeräumt.)

### Bewusst nicht gebaut

- **Kontextstufen 2 bis 4** (alte Tool-Ein/Ausgaben in Referenzen umschreiben, Historie
  zusammenfassen, frisches Fenster). Der Auftrag nennt ausdrücklich Stufe 0 und 1. Die Stufen
  darüber greifen ab 80 bis 90 % Fensterauslastung, und dieses Fenster ist eine Million Token —
  bevor man dafür baut, will man einen echten Lauf gesehen haben, der dorthin kommt. Der Platz
  dafür ist die Faltung: sie ist die einzige Stelle, die die Historie herstellt.
- **Streaming.** Die Antworten dieser Schleife sind kurz (etwas Text und ein bis drei Aufrufe);
  16k `max_tokens` bleiben sicher unter dem HTTP-Zeitfenster. Nötig wird es mit der Sprachschicht
  (S23/S24), wo die erste Silbe zählt.
- **Modell-Routing nach Schritt-Typ** (Abschnitt 11: klein für Klassifikation, stark für Planen).
  Der Vertrag lässt es zu — eine zweite `ModelClient`-Instanz —, aber die Auswahl gehört zu S21
  (Kosten-Tracking) und braucht Messwerte, nicht eine Vermutung.
- **Kosten je Lauf.** Die Token stehen im `model.responded`, der Preis nicht. Das ist S21.
- Ein Kanal, der `answer` von außen erreichbar macht (S16, seit S10 offen), ein Suchanbieter für
  `web.search` (S13), der Alias-Layer für Artefakt-URIs und ein GC-Lauf für verwaiste
  Artefaktdateien (beide seit S06 offen).

### Offene Befunde

- **Der Probelauf gegen die echte API fehlt** (siehe oben). Der wichtigste offene Punkt.
- Die Faltung liest bei jedem Zyklus das ganze Protokoll. Für dreißig Schritte ist das belanglos,
  für einen Lauf über Stunden nicht. Die Antwort wäre ein mitgeschriebener Zwischenstand mit
  einem Ereignis dahinter — nicht ein Zähler im Prozess.
- `deriveRunMetrics` deckt vier der Kennzahlen aus Abschnitt 12 ab. Die übrigen (Freigaben pro
  Aufgabe, Wartezeit auf Freigabe, Tool-Latenz) brauchen Zeitmessungen über Ereignispaare hinweg
  und gehören in eine Beobachtbarkeits-Session.
- `structured.reason` ist weiterhin eine Verabredung und kein Typ (offen seit S07). S12 verzweigt
  jetzt zwar — aber über den **Fehlertyp** und nicht über das Feld; der Befund bleibt damit für
  den Fall bestehen, dass eine Aufrufstelle doch einmal auf `reason` sehen will.
- Der Sessionzustand im Prompt ist heute nur der Plan. Freigabestatus und Artefakt-Refs gehören
  nach Abschnitt 8 ebenfalls ins Kurzzeitgedächtnis; sie stehen im Protokoll und wären eine
  Ergänzung an derselben Stelle, sobald ein echter Lauf zeigt, dass sie fehlen.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 325 Tests.
- `tasks.json`: S12 auf `done`, S13 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S13 n8n-Brücke.

## S13 · n8n-Brücke · 2026-09-08

Der Anfang von Phase 2: n8n kommt dazu, aber als **Tool-Schicht, nicht als Loop**. Jeder
Workflow wird zu genau einem Tool; Loop, Sessions, Checkpoints, Kontext und Policy bleiben
in der Runtime.

- Tests der Vorsession vorab gelaufen: 325 grün, unverändert. `pnpm typecheck` und
  `pnpm lint` ebenfalls.
- **Keine Migration.** Die Brücke braucht keine Tabelle und keine Spalte. n8n bringt sein
  eigenes Schema mit (siehe unten). Ein n8n-Tool schreibt seine Ereignisse
  (`tool.requested`/`tool.completed`/`tool.failed`) und seinen Schritt über denselben Weg
  wie `fs.*` und `web.*` — der Router und die Ausführungshülle stehen seit S07/S05.
- **Keine neue Abhängigkeit.** Die Brücke ist ein `fetch`-Aufruf mit Timeout und Retry;
  kein SDK, kein n8n-Client-Paket. Ein Workflow ist von außen ein HTTP-Endpunkt, und den
  spricht man mit dem an, was Node schon hat.

### `docker-compose.yml` — n8n intern, mit eigenem Port und eigenem Login

- **Bild gepinnt** auf `n8nio/n8n:2.38.4` statt `latest`. Alles hier ist gepinnt
  (`postgres:16-alpine`, exakte npm-Versionen); `latest` wäre die Hoffnung, dass ein
  Update nichts bricht.
- **Nur intern erreichbar.** Der veröffentlichte Port ist `127.0.0.1:5678:5678` statt
  `5678:5678` — der Editor hängt auf Loopback, auf diesem Rechner im Browser erreichbar,
  aber nicht aus dem Netz. Die Runtime spricht n8n über das Compose-Netz als
  `http://n8n:5678` an und braucht dafür keinen veröffentlichten Port; der `runtime`-Dienst
  bekommt `N8N_BASE_URL: http://n8n:5678` und `depends_on: n8n`.
- **Eigenes Login.** n8n 2.x kennt keine Basic Auth mehr (`N8N_BASIC_AUTH_*` sind ersatzlos
  weg — die drei Zeilen im Platzhalter von S01 waren auf einem aktuellen Bild ohnehin tot).
  Das Login ist jetzt der Owner-Account, der beim ersten Aufruf einmalig im Browser
  angelegt wird. Dazu `N8N_ENCRYPTION_KEY` aus der Umgebung, damit gespeicherte Credentials
  über Neustarts lesbar bleiben, und `N8N_WEBHOOK_URL: http://n8n:5678/`, damit n8n im
  internen Netz gültige Webhook-URLs erzeugt (`WEBHOOK_URL` ist in 2.x zugunsten von
  `N8N_WEBHOOK_URL` veraltet — der Container sagt es im Log).
- **Eigenes Schema.** `DB_POSTGRESDB_SCHEMA: n8n` — n8n legt seine Tabellen unter `n8n` an,
  nicht neben `public.kuronami_schema_migrations`. Das ist dieselbe Trennung, die die
  Runtime mit ihrem Schema `kuronami` hält (S02). Nachgeprüft im laufenden Container: nach
  dem Start liegen 136 Tabellen im Schema `n8n`, `public` hat weiterhin genau eine
  (`kuronami_schema_migrations`), das Schema `kuronami` unverändert sechs. n8n 2.x erzeugt
  das Schema selbst; für ein bestehendes Volume, in dem das nicht greift, ist der Einzeiler
  `docker compose exec postgres psql -U kuronami -c 'CREATE SCHEMA IF NOT EXISTS n8n'`.
- Dazu ein Healthcheck auf `/healthz` (der `runtime`-Dienst wartet darüber nicht, aber
  `docker compose ps` zeigt den Zustand).
- **Bewusst nicht angefasst:** der veröffentlichte Postgres-Port (`0.0.0.0:5432`). Die
  Tests laufen vom Host gegen die Datenbank; das zuzumachen wäre eine eigene Entscheidung
  und gehört nicht in eine n8n-Session.

### Die Brücke: `tools/n8n/bridge.ts`

- Eine Operation: einen Webhook aufrufen (`POST ${baseUrl}/webhook/${path}`, JSON rein,
  JSON raus) oder mit einem **benannten** Fehler scheitern. Die Datei kennt kein Tool, keine
  Hülle, keine Session — die Übersetzung steht eine Ebene höher.
- **`fetch` injiziert, nicht importiert** — dieselbe Überlegung wie bei `fetchImpl` in
  `web.fetch` (S09) und `ModelClient` im Loop (S12). Der Test stellt ein `fetchImpl`, das
  einen n8n-Webhook nachbildet; kein Test braucht einen laufenden Container.
- **Timeout auf Brückenebene**, Vorgabe 30 s — deutlich unter dem 60-s-Fenster der
  Ausführungshülle (S05). Der Grund ist derselbe wie bei `WEB_FETCH_TIMEOUT_MS` (S09): ein
  hängender Workflow soll als sauberer Tool-Fehler enden (`reason: "error"`), nicht als
  "unbekannter Ausgang" der Hülle, bei dem der Effekt weiterläuft. Beim Timeout und bei
  Abbruch von außen (`inv.signal`) wird **nicht** wiederholt — beides heißt "aufhören".
- **Retry mit exponentiellem Backoff auf Brückenebene**, Vorgabe drei Versuche (ein erster
  plus zwei Wiederholungen). Wiederholt wird nur bei **vorübergehenden** Fehlern: ein
  Netzfehler ohne Antwort (DNS, Verbindung abgelehnt, Socket-Reset vor der Antwort — der
  Workflow lief nicht) und HTTP 429/502/503/504. **Nicht** bei 4xx außer 429: das ist
  deterministisch (falsche Eingabe, Workflow fehlt), ein zweiter Anlauf ergäbe dasselbe.
  **Nicht** bei 500: n8n gibt 500 zurück, wenn der Workflow lief und in einem Knoten
  scheiterte — ein Retry führte den Seiteneffekt ein zweites Mal aus.
- **Retry nur bei `repeatable`-Workflows.** Ein nicht wiederholbarer Workflow bekommt genau
  einen Versuch. Ob ein zweiter Anlauf sicher wäre, weiß nur der, der den Workflow schreibt,
  nicht die Brücke — dieselbe Haltung wie in der Ausführungshülle ("nicht wiederholbar
  heißt nicht wiederholbar, auch bei einem sauber geworfenen Fehler", S05). At-least-once
  bleibt die Zusage: ein 502/503/504 *kann* heißen, dass der Workflow lief und nur die
  Antwort verlorenging. Der Retry setzt darauf, dass ein `repeatable`-Workflow das aushält —
  genau die Verabredung, die der Autor mit dem Flag eingeht.
- Der Hülle-Retry (über Prozessgrenzen, `attempt` in `kuronami.steps`, S05) und der
  Brücken-Retry (HTTP-Versuche innerhalb eines Hülle-Versuchs) sind verschiedene
  Fehlerdomänen und beide begrenzt. Sie zählen getrennt.
- **Harte Größenbegrenzung** für den Antwortkörper, Vorgabe 5 MiB, mit Stream-Reader und
  Abbruch mitten im Lesen (Muster aus `readBodyCapped`, S09). Das ist der Schutz gegen einen
  ausufernden Workflow, unabhängig von der Auslagerung.
- **Nur JSON.** Ein nicht-JSON-Körper wird zu `N8nResponseFormatError`; ein leerer Körper
  zu `{}`. Sechs benannte Fehlerklassen (`N8nUnavailableError`, `…WebhookTimeoutError`,
  `…WebhookAbortedError`, `…ResponseTooLargeError`, `…WorkflowHttpError`,
  `…ResponseFormatError`), alle mit vollem Wortlaut — der Router macht daraus Fehlerhüllen
  mit Stacktrace (AGENTS.md, "Fehler nie glätten").

### Warum die Brücke **keine** eigene Auslagerung baut

- "Große Antworten automatisch auslagern" steht im Auftrag — und passiert, aber im
  **Router**. `materializeResult` (S07) misst die fertige Hülle jedes `execution: "step"`-
  Tools und schreibt `structured` in ein Artefakt, sobald sie über der Schwelle liegt. Ein
  n8n-Tool ist ein solches Schritt-Tool, also greift das ohne eine Zeile Extra-Code.
- `fs.read` (S08) und `web.fetch` (S09) lagern **selbst** aus, weil sie einen *typisierten*
  Ausschnitt behalten wollen (Rohbytes bzw. excerpt) und ihre Hülle absichtlich unter der
  Router-Schwelle halten. Ein n8n-Ergebnis hat **keine bekannte Form**, aus der sich so ein
  Ausschnitt schneiden ließe — der generische Weg des Routers (ganzes `structured` ins
  Artefakt, `summary` + `preview` + Handle bleiben) ist hier genau der richtige. Der Handler
  sorgt nur dafür, dass `summary` und `preview` auch nach der Auslagerung etwas aussagen
  (synthetische `summary` aus den Feldnamen, `preview` aus den ersten Feldern).
- Im Test nachgewiesen: ein Workflow, der ~76 KB zurückgibt, ergibt eine Hülle unter 2 KB
  mit `offloaded: true`, und das Handle löst auf den vollständigen Körper auf.

### Jeder Workflow ist ein natives Tool: `tools/n8n/workflows.ts`

- `N8nWorkflowDef` trägt Name, Beschreibung, Risikostufe, Wiederholbarkeit, Webhook-Pfad
  und Eingabeschema. `createN8nTools()` macht daraus `ToolDefinition`s. Von da an ist ein
  Workflow von einem `fs.*`-Tool nicht mehr zu unterscheiden:
  * Die **Registry** prüft Namensform, Risikostufe und die Feldnamen
    (`assertPolicyFieldNames`). Genau das ist das zweite Tor, das `policy/risk.ts` seit S11
    für "ein Tool, das aus JSON entsteht (n8n-Bridge, S13)" angekündigt hat — der Compiler
    sichert nur Definitionen im Repo.
  * Der **Router** ruft die **Policy-Engine** vor der Ausführung. Ein schreibender Workflow
    (`mail.send`, S14) wird ohne Freigabe blockiert, ohne dass die Brücke etwas dafür tut.
  * Die **Ausführungshülle** (`execution: "step"`, Vorgabe) gibt Checkpoint davor/danach,
    Idempotenzschlüssel aus der `call_id`, Zeitfenster und Wiederaufnahme nach einem Absturz.
  * Die **einheitliche Rückgabehülle** macht der Router; der Handler liefert nur `summary`,
    `structured`, `preview`.
- **Übersetzung der Antwort.** n8n gibt oft ein Array mit einem Element je Durchlauf zurück;
  ein einzelnes Element wird ausgepackt. `structured` trägt einen Umschlag
  (`{ workflow, http_status, attempts, duration_ms, body }`), `body` den ausgepackten
  Körper. `summary` ist der `summary`-String des Körpers, falls einer da ist, sonst
  synthetisch. So bleibt ein Workflow eine **dumme Integration** — er muss die Hülle nicht
  kennen.

### Abweichung: kein `n8n`-Namensraum, der Testworkflow ist `dev.uppercase`

- Abschnitt 4.8 ordnet die n8n-Workflows den Namensräumen `mail`, `cal`, `github`, `server`
  zu; einen `n8n`-Namensraum gibt es in `TOOL_NAMESPACES` nicht und die Architektur nennt
  keinen. Ein Workflow **ist** ein Tool unter einem dieser Namensräume, kein eigener.
- Der Testworkflow aus dem Auftrag ("nimmt Text entgegen, gibt ihn großgeschrieben zurück")
  ist ein **Prüf-Tool des Harness** und heißt deshalb `dev.uppercase` — Namensraum `dev`,
  der laut Abschnitt 4.8 genau für solche Tools da ist und "in keinen produktiven
  Tool-Katalog" gehört. `HARNESS_N8N_WORKFLOWS` steht neben `DUMMY`-Tools (`dummies.ts`)
  und wird **nicht** in `buildCatalog` verdrahtet.
- Folge: der **ausgelieferte Katalog-Fingerabdruck bleibt `v1-53a18ba0cb4e49c8` mit zehn
  Tools** — S13 fügt dem Katalog kein Tool hinzu. `buildCatalog` bekommt eine **optionale
  Naht** (`config.n8n.workflows`, Vorgabe leer): ist sie leer, ändert sich nichts; S14
  reicht dort die ersten echten (`mail.*`) durch. Zwei Tests halten beides fest — leer →
  `v1-53a18ba0cb4e49c8`/10 Tools, mit `[UPPERCASE_WORKFLOW]` → anderer Fingerabdruck/11
  Tools/`dev.uppercase` drin.
- `runtime/index.ts` sagt beim Start eine Zeile dazu ("n8n-Brücke: <URL oder nicht
  konfiguriert>, 0 Workflows im Katalog") — dieselbe Haltung wie bei der Governance-Lage
  (S11/S12): der Betreiber soll sehen, ob eine Instanz hinterlegt ist.

### `tools/n8n/workflows/uppercase.json`

- Importierbarer n8n-Workflow: Webhook (`POST /webhook/uppercase`, `responseMode:
  responseNode`) → Code-Knoten (`text.toUpperCase()`, dazu eine `summary`) → Respond to
  Webhook (`firstIncomingItem`). Zielversion n8n 2.x.
- **Gefundene Hürde:** `n8n import:workflow` in 2.x erzeugt **keine** `id` mehr, wenn die
  Datei keine hat — der Import scheitert an `null value in column "id"`. Deshalb trägt die
  Datei eine feste `id` (`kuronamiUppercase01`), wie ein Export aus dem Editor sie hätte.
- Zweite Hürde, nur beim manuellen Einspielen: Git Bash wandelt `/tmp/uppercase.json` als
  Argument in einen Windows-Pfad um (`MSYS_NO_PATHCONV=1` davor setzen). Steht in der
  README, nicht im Code.

### Tests

- 22 neue, zusammen **347**.
- `tools/n8n/bridge.test.ts` (15, **ohne Netz, ohne DB**): POST mit geparstem Körper und
  Header; Token als `x-kuronami-token`; leerer Körper → `{}`; Retry bei 503, bei 429, bei
  Netzfehler; **kein** Retry bei 400, bei nicht wiederholbarem Workflow; Aufgeben nach drei
  Versuchen; Backoff wird eingehalten (gemessen); Timeout endet ohne Retry und schnell;
  Abbruch vor dem ersten Versuch (`calls === 0`) und mitten im Aufruf; Größenbegrenzung;
  Nicht-JSON abgewiesen.
- `tools/n8n/tools.test.ts` (7, **mit DB, echtem Router, echter Policy**), darunter das
  **Fertig-Kriterium**: `callTool(deps, session, { name: "dev.uppercase", input: { text:
  "hallo welt" } })` → `status: "ok"`, `structured.body` = `{ text: "HALLO WELT", summary:
  … }`, `summary` durchgereicht, Ereignisfolge `tool.requested, policy.allowed,
  step.started, step.completed, tool.completed`, kein `tool.failed`, und **Replay ergibt
  denselben Zustand wie der Schnappschuss** (S05).
  Dazu: große Antwort → automatische Auslagerung (Hülle < 2 KB, `offloaded: true`, Handle
  löst auf 900 Zeilen auf, Herkunft `dev.uppercase`); dauerhafter 503 → Fehlerhülle
  (`reason: "handler_failed"`, Text enthält "503", `fetchImpl.calls === 3`); 500 wird
  **nicht** wiederholt (`calls === 1`); Schemafehler → `reason: "invalid_input"` und die
  Brücke wird **nie** gerufen (`calls === 0`, kein `step.started`).
- Zwei Katalog-Tests (siehe Abweichung oben).

### Gegenproben

Drei, alle bestätigt und danach zurückgesetzt:

- **`repeatable`-Gate in der Brücke entfernt** (immer `maxAttempts`) → "wiederholt nichts,
  wenn der Workflow nicht wiederholbar ist" rot: ein 503 für einen nicht wiederholbaren
  Workflow wird jetzt zweimal versucht.
- **400 in `RETRYABLE_STATUS` aufgenommen** → "wiederholt einen 4xx-Fehler nicht" rot.
- **`unwrapBody` deaktiviert** (Array nicht auspacken) → das Fertig-Kriterium rot:
  `structured.body` ist `[{…}]` statt `{…}`, und die synthetische `summary` ("… — 1
  Einträge") tritt an die Stelle der durchgereichten.

### Nachweis gegen ein echtes n8n (im Gegensatz zu S12 durchgeführt)

- `docker compose up -d n8n` auf dem gepinnten Bild `2.38.4`: Container nach ~11 s
  `healthy`, Port nur auf `127.0.0.1:5678`, Migrationen im Schema `n8n`.
- Workflow eingespielt: `docker compose cp` der `uppercase.json` in den Container,
  `n8n import:workflow`, `n8n update:workflow --active=true` (in 2.x als "publish"
  bezeichnet), Container neu gestartet — Log: `Activated workflow "dev.uppercase"`.
- Drei Aufrufe:
  * `curl` direkt auf `http://localhost:5678/webhook/uppercase` mit `{"text":"hallo welt
    aus curl"}` → `{"text":"HALLO WELT AUS CURL","summary":"n8n hat 19 Zeichen
    grossgeschrieben"}`, HTTP 200.
  * die echte Brücke (`createN8nBridge({ baseUrl: "http://localhost:5678" }).invoke(...)`) →
    `{ status: 200, body: { text: "DURCH DIE ECHTE BRUECKE", … }, attempts: 1, durationMs:
    136 }`; ein Aufruf auf einen unbekannten Pfad → `N8nWorkflowHttpError` (HTTP 404), **ohne
    Retry**.
  * durch den **echten Router** als Tool `dev.uppercase` → einheitliche Hülle `{ status:
    "ok", summary: "n8n hat 20 Zeichen großgeschrieben", structured: { workflow:
    "dev.uppercase", http_status: 200, body: { text: "HALLO AUS DEM ROUTER", … } },
    artifact_refs: [], preview: [...] }`. Das ist das Fertig-Kriterium, live.
  Probe-Session und -Ereignisse danach gelöscht.
- **n8n läuft nach der Session nicht weiter.** Der Container wurde mit `docker compose stop
  n8n` angehalten; das Volume `n8n-data` und das Schema `n8n` bleiben, `docker compose up -d
  n8n` bringt alles samt dem eingespielten Workflow zurück. Grund: der volle
  vitest-Lauf gegen dieselbe Postgres-Instanz reißt zeitweise die Verbindungsgrenze, während
  n8n seinen eigenen Pool hält (einmal beobachtet: 19 Fehlschläge quer über unbeteiligte
  Testdateien, ein zweiter Lauf unmittelbar danach wieder 347 grün). Das ist eine
  Umgebungsfrage, kein Codefehler — aber der Normalfall `pnpm test` soll nicht daran hängen,
  ob gerade ein Container mitläuft.

### Bewusst nicht gebaut

- **Die echten Assistenz-Tools** (`mail.*`, `cal.*`, `github.*`, `server.*`). Das ist S14
  und danach — S13 baut den Mechanismus und weist ihn mit `dev.uppercase` nach.
- **Workflow-seitige Header-Auth.** Die Brücke *schickt* `x-kuronami-token`, wenn
  `N8N_WEBHOOK_TOKEN` gesetzt ist; den Knoten "Header Auth" im Workflow scharf zu schalten
  ist eine Umgebungsentscheidung und im Compose-Netz nicht nötig (die Netzgrenze trägt die
  Kontrolle). Dokumentiert in `tools/n8n/README.md`.
- **Ein Suchanbieter für `web.search`** über eine n8n-Bridge (seit S09 offen notiert). Der
  Platz dafür ist `WebSearchBackend`; er anzuschließen wäre ein eigener Workflow plus die
  Verdrahtung, und `web.search` meldet bis dahin weiterhin eine Fehlerhülle.
- **Ein GC-Lauf** für n8n-Antwort-Artefakte — dieselbe offene Frage wie für alle Artefakte
  seit S06.

### Offene Befunde

- Der **Postgres-Port ist weiterhin öffentlich** (`0.0.0.0:5432`). Für S13 bewusst nicht
  angefasst (die Tests hängen daran); es bleibt der naheliegende nächste Schritt, wenn die
  Erreichbarkeit als Ganzes drankommt.
- **`N8N_ENCRYPTION_KEY` hat im Compose eine Dev-Vorgabe** (`kuronami-dev-encryption-key-…`).
  Das ist für lokale Arbeit richtig und für alles andere falsch; `.env.example` sagt es.
- Die Brücke misst `durationMs` und legt es in `structured` ab. Eine Kennzahl
  "Tool-Latenz" (Abschnitt 12) entsteht daraus noch nicht — die gehört in dieselbe
  Beobachtbarkeits-Session wie die offenen Punkte aus S12.
- `structured.reason` ist weiterhin eine Verabredung und kein Typ (offen seit S07).
- `pnpm typecheck && pnpm lint && pnpm test` grün, 347 Tests.
- `tasks.json`: S13 auf `done`, S14 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S14 Mail-Tools.

## S12b · Dev-Oberfläche (Tauri, read-mostly) · 2026-09-08

Außerplanmäßig, zwischen S13 und S14 eingeschoben. Zweck: ein Fenster, um beim Bauen des
restlichen Plans einer laufenden Session zusehen und eine Freigabe per Klick erteilen zu
können. **Wegwerf-Werkzeug** — Design, Auth und die 3D-Welt sind ausdrücklich nicht Teil
davon, Phase 6 ersetzt es.

- S13 vorab geprüft: sauber committet (`bc45e55`, Arbeitsbaum rein), `pnpm typecheck`,
  `pnpm lint` und alle **347 Tests** grün. S13 hat nichts kaputt gemacht.
- **Keine Migration, kein neuer Zustand in der Datenbank, keine Änderung an bestehendem
  Runtime-/Context-/Tool-/Policy-Code.** Die Testzahl bleibt deshalb bei 347 — S12b fügt
  keinen Test hinzu, weil es selbst ein Prüf-Werkzeug ist. Dieselbe Linie wie bei
  `runtime/loop/scripted.ts` und `tools/dummies.ts`: die werden durch die Loop-Tests
  ausgeübt, nicht einzeln geprüft. Die drei Endpunkte sind dünner Leim über schon geprüfte
  Funktionen (`deriveLoopState` S12, `deriveSessionState` S05, `createRunner`/`answer` S12);
  ein eigener DB-gestützter HTTP-Test prüfte den Loop ein zweites Mal.

### Drei neue Abhängigkeiten, alle als `devDependencies`

- `express`, `@types/express`, `@tauri-apps/cli`. **Abweichung von der sonst strengen
  Abhängigkeitsdisziplin** (Runtime kennt nur `pg` und `@anthropic-ai/sdk`, jede mit einem
  Absatz Begründung). Sie trägt, weil die DevUI ein Entwicklungswerkzeug ist — dieselbe
  Kategorie wie `vitest` und `biome` — und von `runtime/index.ts` **nie** importiert wird.
  `devDependencies` ist der ehrliche Ort dafür; ein `pnpm install --prod` lässt `runtime/devui`
  weg, und das ist richtig so.
- `express` statt `node:http`: der Auftrag nennt es ausdrücklich, und für ein Wegwerf-Werkzeug
  ist es die pragmatische Wahl (Body-Parsing, Routing, Fehler-Middleware in fünf Zeilen).

### `runtime/devui/server.ts` — drei Endpunkte, ein Schreibpfad

- `GET /sessions` und `GET /sessions/:id/events` sind **reine Leser**: eine Abfrage auf
  `kuronami.sessions`, dann `deriveSessionState` bzw. `deriveLoopState` über das gelesene
  Protokoll. Kein Cache, kein mitgeführter Zustand. `/events` gibt zusätzlich die rohe
  Ereignisliste (`seq`, `type`, `createdAt`) als dünnen Zeitstrahl für die Anzeige.
- **Die eine Stelle, an der „reiner Leser“ nicht reicht:** `Runner.answer()` schreibt nur die
  Entscheidung (`decidePolicyApproval`/`answerUserInput`, S11/S10) — der offene Zug läuft
  davon nicht weiter. Fertig-Kriterium ist aber „Lauf läuft weiter“. Also stößt
  `POST /sessions/:id/answer` nach `answer()` den Zug mit `run()` (ohne `input`) erneut an —
  genau das Muster aus dem S12-Freigabetest („nach `once` läuft derselbe Zug weiter“).
- Dafür hält der Server die Läufer, **die er selbst gestartet hat**, in einer flüchtigen
  `Map`. Das ist **kein Datenbank-Zustand und muss keinen Neustart überleben**: ein Neustart
  lässt die Map leer, und `resumeRunner` baut bei Bedarf über `createRunner` aus
  `thread_id`/`channel` der Session einen neuen Läufer. Der `catalog` ist derselbe
  (`v1-53a18ba0cb4e49c8`), sonst wiese die Session Tool-Aufrufe ab (S07).
- **Modell: das Drehbuch aus S12** (`createScriptedModel`), kein Anbieter. Grund: die
  Oberfläche soll ohne `ANTHROPIC_API_KEY` und ohne Netz einen echten Lauf zeigen, samt
  Freigabestelle. Ein Pausen-Wrapper (1,2 s je Zug, `DEVUI_STEP_DELAY_MS`) macht den
  Fortschritt beim Polling sichtbar.
- **Demo-Aufgabe** (startet beim Booten, abschaltbar mit `DEVUI_NO_DEMO=1`): Plan setzen,
  drei Notizen in den Artefaktbereich schreiben, einen Bericht **in die Quellzone** (das ist
  die Freigabestelle nach Abschnitt 10), eine Notiz gegenlesen. Sechs Werkzeugaufrufe, Halt
  bei Aufruf 4.
- Quellzone und Artefaktbereich der Demo zeigen auf ein `mkdtemp`-Verzeichnis, **nicht** auf
  den Repo-Baum — sonst entstünde bei jedem Lauf ein `bericht.txt` im Arbeitsverzeichnis. Es
  wird beim Herunterfahren (SIGINT/SIGTERM) gelöscht, zusammen mit `pool.end()` und dem Stopp
  aller Läufer.

### `runtime/devui/index.html` — eine Datei

- Eingebettetes CSS/JS, Vanilla, kein Build. Polling alle 1,5 s. Zweispaltig: Sessionliste
  links, Detail rechts (Status-Badge, Loop-Stand aus `deriveLoopState` — offener Zug,
  Aufrufzahl, Fehler in Folge, ausgelagerte Ergebnisse —, Schritt-Tabelle, Ereignis-
  Zeitstrahl, Roh-Verlauf der Nachrichten einklappbar).
- Der **awaiting_user-Block** rendert die vier Knöpfe `once/session/always/deny` aus den
  `options` des `approval.requested` (nicht fest verdrahtet — kommen aus dem Protokoll), Klick
  → `POST /sessions/:id/answer`. Theme-fähig über `prefers-color-scheme`.

### `src-tauri/` — Fenster um `localhost:8787`

- Mit `pnpm exec tauri init --ci` erzeugt (Tauri 2.11), dann angepasst: `identifier`
  `com.kuronami.devui`, Fenster 1120×760, `devUrl`/`frontendDist` auf `http://localhost:8787`.
- `src-tauri/src/lib.rs` startet den Server **als Kindprozess beim App-Start**
  (`node --env-file=.env --import tsx runtime/devui/server.ts`, Arbeitsverzeichnis =
  Projektwurzel über `CARGO_MANIFEST_DIR/..`, unter Windows mit `CREATE_NO_WINDOW`) und nimmt
  ihn bei `RunEvent::Exit` mit (`child.kill()` über einen `Mutex<Option<Child>>` im managed
  state). **Kein `beforeDevCommand`** — der Server gehört zur App, nicht zum Dev-Setup, und
  soll auch aus einem gebauten Binary heraus starten (die Paketierung selbst ist S22).
- `.gitignore`/`.claudeignore`: `!src-tauri/Cargo.lock` — die Lock-Datei einer **Anwendung**
  gehört ins Repo, `*.lock` (seit S01) hätte sie mitgenommen. Beide Dateien synchron
  gehalten. `src-tauri/target/` und `gen/schemas` deckt das von `tauri init` erzeugte
  `src-tauri/.gitignore` ab.

### Nachweis

- Server gestartet, Demolauf im Polling beobachtet: läuft an (Plan, zwei Notizen), **hält bei
  `awaiting_user`** auf `policy:call_step_4` mit den Optionen `once/session/always/deny`,
  Quellzonen-`bericht.txt` ist zu diesem Zeitpunkt **nicht** geschrieben, der Zug bleibt
  offen (kein `turn.completed`). `POST /sessions/:id/answer {"choiceId":"once"}` → der Zug
  läuft weiter → `session.completed`, sechs Werkzeugaufrufe, fünf Schritt-Zeilen alle
  `completed`, Ereignisfolge lückenlos bis `turn.completed, session.completed`. Das ist das
  Fertig-Kriterium, über die HTTP-Oberfläche.
- Tauri: `cargo build` in `src-tauri/` grün (erster Lauf ~2 min, danach ~18 s), Binary
  `target/debug/kuronami-devui.exe`. `pnpm exec tauri dev` gestartet: die CLI führt das
  Binary aus, `setup()` startet den `node`-Kindprozess (`[tauri] devui-Server gestartet
  (pid …)`), wartet über einen TCP-Connect-Loop auf Port 8787 und öffnet dann das Fenster
  auf `http://localhost:8787`. Der Demolauf lief an, hielt bei `awaiting_user`;
  `POST …/answer {"choiceId":"once"}` → `session.completed`, sechs Werkzeugaufrufe. Beim
  Beenden des Fensters nimmt `RunEvent::Exit` den Server-Kindprozess mit.
- **Gefundene Hürde:** `tauri dev` blockiert, solange `build.devUrl` gesetzt ist — es wartet
  auf einen Frontend-Dev-Server, den in unserem Fall erst das noch nicht gestartete Binary
  hochfährt (Henne/Ei). Lösung: `devUrl` raus, das Fenster lädt `build.frontendDist` bzw.
  `app.windows[0].url` = `http://localhost:8787` direkt, ohne Warteschleife. Der TCP-Loop in
  `setup()` schließt die kurze Lücke bis der Server antwortet.
- Der Repo-Arbeitsbaum bleibt sauber (nur die neuen Dateien plus `package.json`/Lockfile und
  die `.gitignore`-Ergänzung); das Demo-Scratch-Verzeichnis liegt unter dem OS-Temp und wird
  beim Stopp gelöscht. `tauri init`/`tauri dev` normalisieren `src-tauri/Cargo.toml`
  (leere `features = []` an `tauri`/`tauri-build`) — so belassen.

### Bewusst nicht gebaut

- **Design, Auth, 3D-Welt** — Phase 6, bzw. wird dort ersetzt (Auftrag).
- **Ein Endpunkt zum Starten eines Laufs.** Der Server startet einen Demolauf beim Booten;
  ein echter, von außen angestoßener Lauf kommt über den Kanal (S16).
- **Das reale Anbieter-Modell.** Kein Schlüssel gesetzt; `pnpm run:task` deckt den Pfad ab.
  Die transiente `resumeRunner`-Bahn ist für einen Lauf gedacht, den das Drehbuch fortsetzen
  kann — ein mit dem echten Modell gestarteter Lauf ließe sich so nicht sinnvoll weiterführen.
- **Paketierung der Tauri-App** zu einem Installer und ein aus dem Binary heraus auffindbarer
  Projektpfad — das ist S22 (Tauri-Desktop-Wrapper).

### Offene Befunde

- Ein voller `pnpm test`-Lauf parallel zum ersten `cargo build` reißt zeitweise die CPU
  (Testdauer ~20 s statt ~6 s), 347 blieben grün. Umgebungsfrage, kein Codefehler.
- Die Sessionliste faltet je Zeile das ganze Protokoll (`deriveSessionState` über
  `readEvents`). Für die Handvoll Sessions eines Entwicklungsrechners belanglos; ein echter
  Verlaufsstand käme aus einem mitgeschriebenen Snapshot (dieselbe offene Frage wie in S12).
- `pnpm typecheck && pnpm lint && pnpm test` grün, 347 Tests.
- `tasks.json`: S12b als `done` ergänzt (Phase 1, hängt an S12).

Status: abgeschlossen. Nächste Session: S14 Mail-Tools.
