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

Status: abgeschlossen. Nächste Session: S06 Artefaktspeicher.
