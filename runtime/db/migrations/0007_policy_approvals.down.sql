-- Rücknahme von 0007. `kuronami.approvals` steht danach wieder exakt in der Form von 0001.

DROP INDEX kuronami.idx_approvals_persistent_subject;
DROP INDEX kuronami.idx_approvals_subject_scope;
DROP INDEX kuronami.idx_approvals_session_subject;

ALTER TABLE kuronami.approvals DROP CONSTRAINT approvals_decided_fields;
ALTER TABLE kuronami.approvals DROP CONSTRAINT approvals_once_needs_call;
ALTER TABLE kuronami.approvals DROP COLUMN decided_by;
ALTER TABLE kuronami.approvals DROP COLUMN call_id;
ALTER TABLE kuronami.approvals DROP COLUMN subject;

-- Dauerhafte Freigaben sind vor 0007 nicht darstellbar. Sie stillschweigend auf `session`
-- umzuschreiben wäre eine Bedeutungsänderung hinter dem Rücken des Betreibers: aus einer
-- bewussten Dauerfreigabe würde eine, die beim nächsten Neustart weg ist — oder schlimmer,
-- eine, die weiter greift, obwohl niemand sie mehr so erteilt hätte. Deshalb bricht die
-- Rücknahme hier ab und sagt, was zu tun ist (AGENTS.md: Fehler nie verstecken oder glätten).
DO $$
DECLARE
    persistent_count integer;
BEGIN
    SELECT count(*) INTO persistent_count FROM kuronami.approvals WHERE scope = 'always';
    IF persistent_count > 0 THEN
        RAISE EXCEPTION
            'Migration 0007 lässt sich nicht zurücknehmen: % dauerhafte Freigabe(n) in kuronami.approvals. Der Geltungsbereich "always" existiert vor 0007 nicht. Entscheide bewusst, ob sie gelöscht oder auf "session" umgestellt werden, und tue es vor dem Down.',
            persistent_count;
    END IF;
END $$;

ALTER TYPE kuronami.approval_scope RENAME TO approval_scope_old;
CREATE TYPE kuronami.approval_scope AS ENUM ('once', 'session');

ALTER TABLE kuronami.approvals
    ALTER COLUMN scope DROP DEFAULT,
    ALTER COLUMN scope TYPE kuronami.approval_scope
        USING scope::text::kuronami.approval_scope,
    ALTER COLUMN scope SET DEFAULT 'once';

DROP TYPE kuronami.approval_scope_old;
