-- S10. Die tasks-Tabelle steht seit S02 (Abschnitt 5), aber ohne Session-Bezug. `task.set`
-- und `task.update` brauchen einen: der aktive Plan ist Kurzzeitgedächtnis der Session
-- (Abschnitt 8, "aktiver Plan" = Checkpointed Runtime-State), und ein neu gestarteter
-- Prozess muss "den Plan dieser Session" laden können, nicht den irgendeiner. `owner` bleibt
-- als freies Textfeld für die spätere Mehr-Agenten-Welt (Abschnitt 14) — es benennt, wer die
-- Aufgabe hält, nicht, in welchem Lauf sie entstand.

-- Die Tabelle ist seit S05 leer, NOT NULL greift also sofort und ohne Datenmigration — wie
-- schon bei `summary`/`source` in 0005. Ein Backfill hätte auch keinen richtigen Wert:
-- eine Aufgabe ohne Session ist im Phase-1-Modell keine Aufgabe.
ALTER TABLE kuronami.tasks
    ADD COLUMN session_id text NOT NULL REFERENCES kuronami.sessions (session_id);

-- Der Primärschlüssel wird zusammengesetzt: `(session_id, task_id)`. Abweichung von
-- Abschnitt 5, wo `task_id` allein steht — begründet im `progress.md`-Eintrag zu S10:
-- `task.set` adressiert Aufgaben über eine **vom Aufrufer stabil gewählte** `id`
-- ("summarize-mails" statt "task_abc123"), damit ein `task.update` nach einem Neustart
-- dieselbe Aufgabe trifft. Diese Schlüssel sind innerhalb einer Session eindeutig, aber
-- zwei Sessions dürfen dieselbe `id` vergeben. Nichts verweist per Fremdschlüssel auf
-- `kuronami.tasks`, die Änderung ist also lokal.
ALTER TABLE kuronami.tasks DROP CONSTRAINT tasks_pkey;
ALTER TABLE kuronami.tasks ADD CONSTRAINT tasks_pkey PRIMARY KEY (session_id, task_id);

-- Ein Plan ist eine geordnete Liste. `created_at` trägt die Reihenfolge nicht: ein einziges
-- `task.set` schreibt alle Zeilen in derselben Transaktion und damit mit praktisch gleichem
-- Zeitstempel (`now()` ist in Postgres die Transaktionszeit). `position` ist die Ordnung,
-- die `task.set` vergibt; Gleichstand entscheidet die `task_id`, nach dem Muster von
-- `compareSteps` aus S05.
ALTER TABLE kuronami.tasks ADD COLUMN position integer NOT NULL DEFAULT 0;

CREATE INDEX idx_tasks_session_id ON kuronami.tasks (session_id);
CREATE INDEX idx_tasks_session_position ON kuronami.tasks (session_id, position);
