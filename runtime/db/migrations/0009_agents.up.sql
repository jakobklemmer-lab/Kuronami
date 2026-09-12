-- S19. Die Agenten-Registry — die Tabelle, aus der `agent.create` und `agent.delegate` leben.
--
-- ## Woher das Schema kommt
--
-- `docs/ARCHITEKTUR.md` nennt in Abschnitt 5 vier Entitäten (Session, Task, Step, Artifact)
-- und sechs Tabellen "in Phase 1" — eine `agents`-Tabelle steht dort nicht als JSON-Beispiel.
-- Ihre Felder sind deshalb **abgeleitet**, und zwar aus den Sätzen, die die Architektur über
-- Subagenten ohnehin festlegt; jede Spalte unten steht für genau einen davon:
--
--   * Abschnitt 14: "Neue Rollen entstehen über `agent.create` per Sprach- oder Textbefehl,
--     nicht durch neuen Code pro Agent"  → die Registry ist eine Tabelle und kein Quelltext:
--     `name`, `role`, `purpose`, `system_prompt`.
--   * Abschnitt 14: "Werkzeug-Zugriff ist rollenspezifisch, nie pauschal"  → `tools`.
--   * Abschnitt 14: "explizite Tool-Beschränkung pro Subagent, Obergrenze für parallele
--     Worker und Token-Budget"  → `max_steps` als das Budget, das diese Runtime wirklich
--     durchsetzen kann (die Schrittobergrenze des Loops, Abschnitt 13).
--   * Abschnitt 11: "Modell pro Agent bewusst wählen"  → `model`.
--   * Abschnitt 10, Risikostufen  → `max_risk`: die Obergrenze, die für diesen Agenten gilt.
--     Kein Tool ohne Zuordnung, und kein Agent ohne Obergrenze.
--   * Abschnitt 11: "Cron-Agenten sind der eigentliche Kostentreiber"  → `schedule`, der
--     Cron-Ausdruck, unter dem der Heartbeat-Dienst (S17) diesen Agenten laufen lässt.
--
-- Der Eintrag in `progress.md` zu S19 hält fest, dass diese Ableitung eine Entscheidung war;
-- `docs/ARCHITEKTUR.md` Abschnitt 5 trägt das Ergebnis jetzt als fünfte Entität.
--
-- ## Ein siebter Kanalwert: `agent`
--
-- Ein delegierter Arbeiter (Abschnitt 14: "Worker bekommen enge Aufträge und isolierte
-- Kontexte") bekommt eine **eigene Session** — das ist der isolierte Kontext, denn der
-- Kontext einer Session *ist* ihr Ereignisprotokoll. Diese Session gehört keiner Oberfläche:
-- sie kommt nicht aus dem Web, nicht aus Telegram, nicht vom Heartbeat. Sie einem der
-- bestehenden Werte zuzuschlagen wäre eine Falschaussage über ihre Herkunft, und `gateway`
-- (S16) meint das Gegenteil — eine Session, die *mehreren* Oberflächen gehört.
--
-- Wie in 0007 (`approval_scope`) und 0008 (`session_channel`) wird der Typ umbenannt und neu
-- angelegt statt per ALTER TYPE ... ADD VALUE erweitert: Postgres kann einen Enum-Wert nur
-- hinzufügen, nicht entfernen, und die Down-Migration soll den Zustand von 0008 wirklich
-- wiederherstellen. Die bestehenden sechs Werte bleiben unverändert in Bedeutung und
-- Schreibweise.
ALTER TYPE kuronami.session_channel RENAME TO session_channel_old;

CREATE TYPE kuronami.session_channel AS ENUM (
    'web', 'telegram', 'mail', 'heartbeat', 'voice', 'gateway', 'agent'
);

ALTER TABLE kuronami.sessions
    ALTER COLUMN channel TYPE kuronami.session_channel
        USING channel::text::kuronami.session_channel;

DROP TYPE kuronami.session_channel_old;

-- Der Lebenszustand eines Agenten. Drei Werte, und `active` ist die Vorgabe, weil das
-- Fertig-Kriterium von S19 wörtlich "sofort aktiv" verlangt: ein frisch angelegter Agent, der
-- erst noch freigeschaltet werden müsste, wäre ein zweites Tor hinter der Bestätigung, die
-- `agent.create` ohnehin einholt.
--
--   * `active`  — delegierbar, und bei gesetztem `schedule` vom Heartbeat fällig.
--   * `paused`  — bleibt stehen, läuft aber nicht: weder Delegation noch Zeitplan.
--   * `retired` — ausgemustert. Kein Löschen: eine Delegation im Protokoll zeigt auf diesen
--                 Namen, und ein Protokoll, dessen Verweise ins Leere laufen, ist keins.
CREATE TYPE kuronami.agent_status AS ENUM ('active', 'paused', 'retired');

CREATE TABLE kuronami.agents (
    agent_id text PRIMARY KEY,
    -- Der stabile Handgriff: `agent.delegate` nennt diesen Namen, nicht die Kennung. Form wie
    -- ein Skill-Verzeichnis (S18c) und aus demselben Grund geprüft wie ein Toolname (S07):
    -- zwei Schreibweisen desselben Agenten wären zwei Agenten.
    name text NOT NULL UNIQUE,
    -- Die Rolle in der Besetzung aus Abschnitt 14 ("Coder", "Mail-Agent", …), menschenlesbar.
    role text NOT NULL,
    -- Ein Satz: wofür es diesen Agenten gibt. Steht später in der Auswahlliste des
    -- Orchestrators, an derselben Stelle, an der eine Tool-Beschreibung steht.
    purpose text NOT NULL,
    -- Die stehende Anweisung des Arbeiters. Sie geht in den System-Prompt seiner Session und
    -- nicht in den Auftragstext: ein Auftrag wechselt, eine Rolle nicht.
    system_prompt text NOT NULL,
    -- Abschnitt 11, "Modell pro Agent bewusst wählen".
    model text NOT NULL,
    -- Abschnitt 14, "Werkzeug-Zugriff ist rollenspezifisch, nie pauschal": die vollständige
    -- Liste der Toolnamen, die dieser Agent aufrufen darf. Sie ist eine **Obergrenze** — was
    -- der Katalog des Prozesses nicht kennt, kommt dadurch nicht dazu (wie BACKGROUND_TOOLSET,
    -- S17).
    tools jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Die Risikostufe (Abschnitt 10), bis zu der dieser Agent gehen darf. Vorgabe `read`:
    -- die niedrigste Stufe ist die einzige, die man vergeben kann, ohne sie zu entscheiden.
    max_risk kuronami.risk_level NOT NULL DEFAULT 'read',
    -- Das Budget aus Abschnitt 14, in der Einheit, die diese Runtime durchsetzen kann:
    -- Werkzeugaufrufe je Lauf (Abschnitt 13, DEFAULT_MAX_STEPS = 50 für den Orchestrator).
    -- 25 ist die Vorgabe des Hintergrundlaufs seit S17 — ein enger Auftrag braucht weniger.
    max_steps integer NOT NULL DEFAULT 25,
    -- Cron-Ausdruck (fünf Felder, `runtime/schedule/cron.ts`) oder NULL. Gesetzt heißt: der
    -- Heartbeat-Dienst lässt diesen Agenten nach Zeitplan laufen. Die Registrierung *ist*
    -- diese Spalte — es gibt keine zweite Liste im Speicher eines Prozesses, die ein Neustart
    -- verlöre (dieselbe Haltung wie bei der Tagesobergrenze in S17).
    schedule text,
    status kuronami.agent_status NOT NULL DEFAULT 'active',
    -- Wer ihn angelegt hat (Abschnitt 10, "Jede ausgeführte Aktion hinterlässt: Auslöser …").
    created_by text NOT NULL,
    -- In welcher Session er entstand. **Ohne Fremdschlüssel, mit Absicht:** die Registry
    -- überlebt die Session, in der sie entstand. Ein aufgeräumtes Protokoll soll einen Agenten
    -- weder mitnehmen noch am Aufräumen hindern; die belastbare Herkunft steht ohnehin im
    -- `agent.created`-Ereignis dieser Session.
    created_in_session text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agents_name_form CHECK (name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
    CONSTRAINT agents_tools_array CHECK (jsonb_typeof(tools) = 'array'),
    CONSTRAINT agents_max_steps_range CHECK (max_steps BETWEEN 1 AND 200),
    CONSTRAINT agents_schedule_nonempty CHECK (schedule IS NULL OR btrim(schedule) <> '')
);

-- Der Lesepfad des Orchestrators: welche Agenten kann ich beauftragen?
CREATE INDEX idx_agents_status ON kuronami.agents (status);

-- Der Lesepfad des Heartbeats: welche Agenten haben einen Zeitplan? Partiell, weil der
-- Normalfall ein Agent **ohne** Zeitplan ist — ein Cron-Agent kostet Geld, auch wenn niemand
-- mit ihm spricht (Abschnitt 11).
CREATE INDEX idx_agents_scheduled ON kuronami.agents (status) WHERE schedule IS NOT NULL;
