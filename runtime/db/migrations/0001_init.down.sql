DROP TABLE IF EXISTS kuronami.approvals;
DROP TABLE IF EXISTS kuronami.artifacts;
DROP TABLE IF EXISTS kuronami.steps;
DROP TABLE IF EXISTS kuronami.tasks;
DROP TABLE IF EXISTS kuronami.sessions;

DROP TYPE IF EXISTS kuronami.approval_status;
DROP TYPE IF EXISTS kuronami.approval_scope;
DROP TYPE IF EXISTS kuronami.risk_level;
DROP TYPE IF EXISTS kuronami.step_status;
DROP TYPE IF EXISTS kuronami.step_kind;
DROP TYPE IF EXISTS kuronami.task_status;
DROP TYPE IF EXISTS kuronami.approval_mode;
DROP TYPE IF EXISTS kuronami.session_channel;

DROP SCHEMA IF EXISTS kuronami;
