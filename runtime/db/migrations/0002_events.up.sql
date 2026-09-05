-- type bleibt bewusst text und wird kein Enum: neue Ereignistypen kommen laufend dazu,
-- bestehende werden nie umbenannt (Architektur 4.4). Ein Enum machte jeden neuen Typ zu
-- einer Migration und damit zu einem Anreiz, einen bestehenden Typ stattdessen umzudeuten.
CREATE TABLE kuronami.events (
    event_id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES kuronami.sessions (session_id),
    seq integer NOT NULL CHECK (seq > 0),
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Lesepfad "Ereignisse in Reihenfolge" und zugleich die Datenbankseite der
-- Lückenlosigkeit: zwei gleiche seq je Session sind hier strukturell unmöglich.
CREATE UNIQUE INDEX idx_events_session_seq ON kuronami.events (session_id, seq);
CREATE INDEX idx_events_created_at ON kuronami.events (created_at);
