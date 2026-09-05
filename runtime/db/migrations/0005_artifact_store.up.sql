-- S06. Die artifacts-Tabelle steht seit S02 (Abschnitt 5), aber ohne drei Zusagen, die der
-- Artefaktspeicher braucht. Alle drei kommen aus dem Session-Auftrag, nicht aus einer neuen
-- Idee: Größe für head(), summary als Pflichtfeld, Herkunft immer vollständig.

-- 1. Größe in Bytes. head() soll Metadaten liefern, "ohne die Datei zu laden" (Auftrag S06).
--    Die Größe gehört zu diesen Metadaten und darf deshalb nicht erst aus einem stat() der
--    Datei stammen — sonst wäre head() bei einem 5-MB-Artefakt doch wieder ein Dateizugriff.
--    bigint statt integer, weil ein Artefakt eine ausgelagerte Tool-Ausgabe ist (Abschnitt
--    4.5, Auslagerungsschwelle) und die 2-GB-Grenze von integer grundsätzlich reißen kann.
ALTER TABLE kuronami.artifacts ADD COLUMN size_bytes bigint NOT NULL CHECK (size_bytes >= 0);

-- 2. summary ist Pflichtfeld (Auftrag S06). Das Feld ist das, was statt der Bytes in den
--    Modellkontext geht (Abschnitt 4.5); ein Artefakt ohne Zusammenfassung ist ein stilles
--    Loch im Kontext. Kein Backfill wie bei idempotency_key in 0004: für eine fehlende
--    Zusammenfassung gibt es keinen richtigen Ersatzwert. Die Tabelle ist leer (nach S05),
--    der Constraint greift also sofort und ohne Datenmigration.
ALTER TABLE kuronami.artifacts ALTER COLUMN summary SET NOT NULL;

--    NOT NULL allein ließe den Leerstring '' und reines Whitespace durch. Der CHECK schließt
--    das in der Datenbank, nach dem Muster von idx_events_session_seq (S03): die Zusage
--    liegt im Schema, nicht bloß im Anwendungscode, der sie umgehen könnte.
ALTER TABLE kuronami.artifacts
    ADD CONSTRAINT artifacts_summary_not_blank CHECK (length(btrim(summary)) > 0);

-- 3. Herkunft (Tool, Session, Schritt) immer mitspeichern (Auftrag S06). Bisher war das
--    nur Konvention des schreibenden Codes. Hier wird es eine Zusage der Datenbank, nach
--    demselben Muster wie oben. `?` prüft die Präsenz des Schlüssels, nicht seinen Wert:
--    step_id darf JSON-null sein (ein Artefakt, das jedem Schritt vorausgeht), aber der
--    Schlüssel muss dastehen. Damit ist "immer mitspeichern" strukturell erzwungen.
--    Der DEFAULT '{}' fällt weg: ein leeres source erfüllt den CHECK nicht mehr, ein
--    Default, der jede Einfügung sofort verletzt, wäre nur eine Falle.
ALTER TABLE kuronami.artifacts ALTER COLUMN source DROP DEFAULT;
ALTER TABLE kuronami.artifacts
    ADD CONSTRAINT artifacts_source_has_provenance
    CHECK (source ? 'tool' AND source ? 'session_id' AND source ? 'step_id');
