DROP INDEX IF EXISTS kuronami.idx_steps_session_idempotency;
ALTER TABLE kuronami.steps DROP COLUMN IF EXISTS result;
ALTER TABLE kuronami.steps DROP COLUMN IF EXISTS repeatable;
ALTER TABLE kuronami.steps DROP COLUMN IF EXISTS attempt;
ALTER TABLE kuronami.steps DROP COLUMN IF EXISTS idempotency_key;
