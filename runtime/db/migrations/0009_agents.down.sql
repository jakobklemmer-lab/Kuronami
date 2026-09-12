-- Rücknahme von 0009. Danach steht der Zustand von 0008 wieder exakt da: keine
-- `kuronami.agents`, kein `agent_status`, und `session_channel` mit den sechs Werten aus 0008.

DROP TABLE IF EXISTS kuronami.agents;
DROP TYPE IF EXISTS kuronami.agent_status;

-- Sessions auf dem Kanal `agent` sind vor 0009 nicht darstellbar. Sie stillschweigend auf
-- einen anderen Kanal umzuschreiben wäre eine Bedeutungsänderung hinter dem Rücken des
-- Betreibers: aus dem isolierten Lauf eines Arbeiters (Abschnitt 14) würde eine Unterhaltung,
-- die behauptet, aus dem Web oder vom Heartbeat zu kommen. Also bricht die Rücknahme ab und
-- sagt, was zu tun ist — dieselbe Haltung wie beim Down von 0008 (AGENTS.md: Fehler nie
-- verstecken oder glätten).
DO $$
DECLARE
    agent_count integer;
BEGIN
    SELECT count(*) INTO agent_count FROM kuronami.sessions WHERE channel = 'agent';
    IF agent_count > 0 THEN
        RAISE EXCEPTION
            'Migration 0009 lässt sich nicht zurücknehmen: % Session(s) auf dem Kanal "agent". Dieser Kanal existiert vor 0009 nicht. Entscheide bewusst, ob sie gelöscht werden, und tue es vor dem Down.',
            agent_count;
    END IF;
END $$;

ALTER TYPE kuronami.session_channel RENAME TO session_channel_old;

CREATE TYPE kuronami.session_channel AS ENUM (
    'web', 'telegram', 'mail', 'heartbeat', 'voice', 'gateway'
);

ALTER TABLE kuronami.sessions
    ALTER COLUMN channel TYPE kuronami.session_channel
        USING channel::text::kuronami.session_channel;

DROP TYPE kuronami.session_channel_old;
