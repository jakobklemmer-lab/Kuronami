CREATE SCHEMA IF NOT EXISTS kuronami;

CREATE TYPE kuronami.session_channel AS ENUM ('web', 'telegram', 'mail', 'heartbeat', 'voice');
CREATE TYPE kuronami.approval_mode AS ENUM ('ask', 'accept_edits', 'bypass_in_sandbox');
CREATE TYPE kuronami.task_status AS ENUM (
    'queued', 'ready', 'in_progress', 'blocked', 'awaiting_user', 'done', 'canceled', 'failed'
);
CREATE TYPE kuronami.step_kind AS ENUM ('plan', 'tool_call', 'verify', 'message');
CREATE TYPE kuronami.step_status AS ENUM ('pending', 'running', 'completed', 'failed', 'canceled');
CREATE TYPE kuronami.risk_level AS ENUM ('read', 'soft_write', 'hard_write', 'destructive');
CREATE TYPE kuronami.approval_scope AS ENUM ('once', 'session');
CREATE TYPE kuronami.approval_status AS ENUM ('pending', 'granted', 'denied');

CREATE TABLE kuronami.sessions (
    session_id text PRIMARY KEY,
    thread_id text NOT NULL,
    channel kuronami.session_channel NOT NULL,
    mode text NOT NULL DEFAULT 'execute',
    model_profile text NOT NULL,
    tool_catalog_version text NOT NULL,
    approval_mode kuronami.approval_mode NOT NULL DEFAULT 'ask',
    context_state jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_created_at ON kuronami.sessions (created_at);

CREATE TABLE kuronami.tasks (
    task_id text PRIMARY KEY,
    title text NOT NULL,
    status kuronami.task_status NOT NULL DEFAULT 'queued',
    owner text NOT NULL,
    dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
    blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
    artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_status ON kuronami.tasks (status);
CREATE INDEX idx_tasks_created_at ON kuronami.tasks (created_at);

CREATE TABLE kuronami.steps (
    step_id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES kuronami.sessions (session_id),
    kind kuronami.step_kind NOT NULL,
    tool_name text,
    status kuronami.step_status NOT NULL DEFAULT 'pending',
    started_at timestamptz,
    ended_at timestamptz,
    artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_steps_session_id ON kuronami.steps (session_id);
CREATE INDEX idx_steps_status ON kuronami.steps (status);
CREATE INDEX idx_steps_created_at ON kuronami.steps (created_at);

CREATE TABLE kuronami.artifacts (
    artifact_id text PRIMARY KEY,
    uri text NOT NULL UNIQUE,
    mime_type text NOT NULL,
    summary text,
    sha256 text NOT NULL,
    source jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_created_at ON kuronami.artifacts (created_at);
CREATE INDEX idx_artifacts_source_session ON kuronami.artifacts (((source ->> 'session_id')));

CREATE TABLE kuronami.approvals (
    approval_id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES kuronami.sessions (session_id),
    step_id text REFERENCES kuronami.steps (step_id),
    tool_name text,
    risk_level kuronami.risk_level NOT NULL,
    scope kuronami.approval_scope NOT NULL DEFAULT 'once',
    status kuronami.approval_status NOT NULL DEFAULT 'pending',
    requested_input jsonb NOT NULL DEFAULT '{}'::jsonb,
    decision_reason text,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_approvals_session_id ON kuronami.approvals (session_id);
CREATE INDEX idx_approvals_status ON kuronami.approvals (status);
CREATE INDEX idx_approvals_created_at ON kuronami.approvals (created_at);
