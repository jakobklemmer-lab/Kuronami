-- S11. Die Tabelle `kuronami.approvals` steht seit S02 (aus Abschnitt 10 abgeleitet, nicht
-- aus einem JSON-Beispiel), war seither aber unbenutzt: es gab keine Policy-Engine, die
-- Freigaben erteilt hätte. Diese Migration bringt sie auf den Stand, den die Engine braucht.

-- 1. Ein dritter Geltungsbereich: "dauerhaft".
--
-- Abschnitt 10 nennt nur "für diese Session erlauben", deshalb kannte der Enum aus 0001 nur
-- `once` und `session`. Der Sessionauftrag von S11 verlangt ausdrücklich drei Bereiche
-- (einmalig / Session / dauerhaft). `session` und `once` bleiben unverändert in Bedeutung
-- und Schreibweise — es kommt einer dazu, keiner wird umgedeutet.
--
-- Postgres kann einen Enum-Wert nur hinzufügen, nicht entfernen. Damit die Down-Migration
-- den Zustand von 0001 wirklich wiederherstellt (und nicht nur ungefähr), wird der Typ hier
-- umbenannt und neu angelegt statt per ALTER TYPE ... ADD VALUE erweitert. Down macht
-- denselben Weg rückwärts.
ALTER TYPE kuronami.approval_scope RENAME TO approval_scope_old;
CREATE TYPE kuronami.approval_scope AS ENUM ('once', 'session', 'always');

ALTER TABLE kuronami.approvals
    ALTER COLUMN scope DROP DEFAULT,
    ALTER COLUMN scope TYPE kuronami.approval_scope
        USING scope::text::kuronami.approval_scope,
    ALTER COLUMN scope SET DEFAULT 'once';

DROP TYPE kuronami.approval_scope_old;

-- 2. Wofür die Freigabe gilt.
--
-- Ohne dieses Feld wäre eine gespeicherte Freigabe nur "irgendwas mit fs.write" — und eine
-- Freigabe, deren Reichweite man nachträglich auslegen muss, ist keine. `subject` ist der
-- kanonische Schlüssel, den die Engine aus Tool und betroffener Ressource bildet
-- (`fs.write|zone:source`, `web.fetch|host:example.com`, `fs.read|secret:dotenv:.env`).
-- Er entsteht aus denselben Feldern, an denen auch die statischen Regeln greifen; zwei
-- Aufrufe teilen sich eine Freigabe genau dann, wenn sie denselben Schlüssel ergeben.
ALTER TABLE kuronami.approvals ADD COLUMN subject text NOT NULL;

-- Der Aufruf, zu dem die Entscheidung gefallen ist. Pflicht für `once`: "einmalig" heißt
-- genau dieser Aufruf und nicht "der nächste beliebige" — sonst griffe die Freigabe an einer
-- Stelle, an der niemand sie erteilt hat. Weil `call_id` stabil aus dem Plan folgt (S07),
-- findet ein wiederaufgenommener Lauf seine eigene Einmal-Freigabe wieder.
ALTER TABLE kuronami.approvals ADD COLUMN call_id text;
ALTER TABLE kuronami.approvals
    ADD CONSTRAINT approvals_once_needs_call CHECK (scope <> 'once' OR call_id IS NOT NULL);

-- Wer entschieden hat. Teil des Freigabepfads aus Abschnitt 10 ("Auslöser, Eingaben,
-- Freigabepfad, Ausgaben, Zeitstempel") und damit Pflicht, sobald eine Entscheidung steht.
ALTER TABLE kuronami.approvals ADD COLUMN decided_by text;
ALTER TABLE kuronami.approvals
    ADD CONSTRAINT approvals_decided_fields CHECK (
        status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
    );

-- 3. Indizes für die beiden Lesepfade der Engine und eine Zusage der Datenbank.
--
-- Sessiongebundene Freigaben werden je Session und Subjekt gesucht, dauerhafte allein am
-- Subjekt (sie überleben die Session, das ist ihr ganzer Zweck).
CREATE INDEX idx_approvals_session_subject ON kuronami.approvals (session_id, subject, status);
CREATE INDEX idx_approvals_subject_scope ON kuronami.approvals (subject, scope, status);

-- Eine dauerhafte Freigabe je Subjekt, und zwar strukturell statt per Anwendungslogik —
-- nach dem Muster von idx_events_session_seq (S03) und idx_sessions_thread_channel (S04).
-- Sonst sammelte sich bei jedem "dauerhaft erlauben" eine weitere Zeile an, und welche von
-- ihnen gilt, entschiede die Sortierung einer Abfrage.
CREATE UNIQUE INDEX idx_approvals_persistent_subject
    ON kuronami.approvals (subject)
    WHERE scope = 'always' AND status = 'granted';
