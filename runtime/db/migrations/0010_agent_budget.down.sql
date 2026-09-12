-- Rücknahme von 0010. Die Spalte verschwindet samt ihrer Bedingung; die Profile bleiben
-- stehen und laufen danach ohne Kostengrenze — was der Zustand von 0009 war.
ALTER TABLE kuronami.agents DROP CONSTRAINT IF EXISTS agents_token_budget_positive;
ALTER TABLE kuronami.agents DROP COLUMN IF EXISTS token_budget;
