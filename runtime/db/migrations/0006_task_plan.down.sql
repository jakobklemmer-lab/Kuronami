-- Nimmt nur 0006 zurück. Die tasks-Tabelle selbst stammt aus 0001 und bleibt stehen;
-- danach hat sie wieder exakt die Form aus S02 (task_id allein als PK, kein session_id,
-- keine position). Schlägt das ADD PRIMARY KEY (task_id) fehl, stehen in den Daten zwei
-- Sessions mit derselben task_id — dann ist ein sauberes Down nicht möglich, so wie
-- 0002-down vor 0001-down laufen muss.
DROP INDEX IF EXISTS kuronami.idx_tasks_session_position;
DROP INDEX IF EXISTS kuronami.idx_tasks_session_id;
ALTER TABLE kuronami.tasks DROP CONSTRAINT tasks_pkey;
ALTER TABLE kuronami.tasks ADD CONSTRAINT tasks_pkey PRIMARY KEY (task_id);
ALTER TABLE kuronami.tasks DROP COLUMN IF EXISTS position;
ALTER TABLE kuronami.tasks DROP COLUMN IF EXISTS session_id;
