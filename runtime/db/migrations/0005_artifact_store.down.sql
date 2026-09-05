-- Nimmt nur 0005 zurück. Die artifacts-Tabelle selbst stammt aus 0001 und bleibt stehen;
-- danach hat sie wieder exakt die Form aus S02 (summary nullbar, source mit DEFAULT '{}',
-- keine size_bytes-Spalte).
ALTER TABLE kuronami.artifacts DROP CONSTRAINT IF EXISTS artifacts_source_has_provenance;
ALTER TABLE kuronami.artifacts ALTER COLUMN source SET DEFAULT '{}'::jsonb;

ALTER TABLE kuronami.artifacts DROP CONSTRAINT IF EXISTS artifacts_summary_not_blank;
ALTER TABLE kuronami.artifacts ALTER COLUMN summary DROP NOT NULL;

ALTER TABLE kuronami.artifacts DROP COLUMN IF EXISTS size_bytes;
