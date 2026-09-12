-- S20. Das **Token-Budget** eines Agenten.
--
-- Abschnitt 14 nennt drei Obergrenzen für Subagenten: "explizite Tool-Beschränkung pro
-- Subagent, Obergrenze für parallele Worker und Token-Budget". Die erste steht seit 0009 in
-- `tools`, die zweite ist eine Eigenschaft des **Prozesses** und keine des Agenten (sie steht
-- deshalb als Konstante in `tools/agent/worker.ts`, nicht hier). Diese Spalte ist die dritte.
--
-- Warum sie neben `max_steps` steht und es nicht ersetzt: die beiden begrenzen Verschiedenes.
-- `max_steps` begrenzt, **wie oft** ein Arbeiter handeln darf — eine Aussage über seinen
-- Aktionsraum, die schon greift, bevor ein einziges Token fließt. `token_budget` begrenzt, was
-- der Lauf **kostet**; ein Agent mit fünf Schritten kann einen 200-KB-Anhang durch den Kontext
-- ziehen und mehr verbrauchen als einer mit vierzig kleinen Aufrufen. Abschnitt 11 sagt, warum
-- die Kostenseite eine eigene Grenze verdient: "Cron-Agenten sind der eigentliche Kostentreiber,
-- nicht der Chat mit dem Nutzer."
--
-- NULL heißt "kein Budget" und ist die Vorgabe für Bestandszeilen: eine geratene Zahl sähe aus
-- wie eine entschiedene (AGENTS.md, zur Risikostufe — hier gilt dasselbe). Die erste Besetzung
-- (S20, `runtime/agents/besetzung.ts`) setzt für jede der sieben Rollen ausdrücklich eine.
ALTER TABLE kuronami.agents ADD COLUMN token_budget integer;

ALTER TABLE kuronami.agents
    ADD CONSTRAINT agents_token_budget_positive
        CHECK (token_budget IS NULL OR token_budget > 0);
