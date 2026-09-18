-- Nachtrag 2026-09-16. MCP-Server-Konfiguration aus der Oberfläche heraus verwaltbar, analog
-- zur Agenten-Registry (S19, 0009_agents.up.sql): eine Tabelle statt einer Liste im
-- Prozessspeicher, die ein Neustart verlöre.
--
-- `createMcpTools` (tools/mcp/tools.ts) entdeckt Fern-Tools genau einmal beim Katalogbau (S27,
-- "Einmalige Entdeckung" im Modulkommentar) — eine Änderung hier gilt deshalb, wie bei den
-- Provider-Schlüsseln aus der Oberfläche (S33), erst nach einem Neustart des Gateways. Keine
-- Fernsteuerung mitten im Betrieb; dieselbe Grenze, aus demselben Grund.
--
-- Nur stdio-Server (S27: "kein zweiter Transport (HTTP+SSE) neben Stdio"): `command`/`args`/
-- `env` sind exakt `StdioMcpClientConfig` aus tools/mcp/client.ts, minus die Laufzeit-Felder
-- (`spawnImpl`, `clientInfo`), die der Prozess selbst setzt, nicht die Oberfläche.
CREATE TABLE kuronami.mcp_servers (
    -- Wird Teil des lokalen Toolnamens (`mcp.<id>__<...>`, tools/mcp/tools.ts) — dieselbe Form
    -- wie SERVER_ID_PATTERN dort geprüft.
    server_id text PRIMARY KEY,
    command text NOT NULL,
    args jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Umgebungsvariablen für den Kindprozess (z. B. ein API-Schlüssel des Fernservers). Wie
    -- Provider-Schlüssel (S33) ein Geheimnis — `GET /settings/mcp-servers` gibt deshalb nie die
    -- Werte zurück, nur ob und wie viele gesetzt sind (siehe gateway/server.ts).
    env jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Obergrenze für JEDES Tool dieses Servers (S27, Härtungsachse 1) — nie aus der
    -- Fernbeschreibung übernommen.
    risk kuronami.risk_level NOT NULL DEFAULT 'read',
    repeatable boolean NOT NULL DEFAULT true,
    -- Ausgeschaltet heißt: der Prozess versucht beim nächsten Start gar nicht erst, ihn zu
    -- spawnen — anders als `agent_status` (S19) kein Betriebszustand, den irgendein Lauf im
    -- Protokoll noch referenzierte; ein Löschen wäre hier genauso ehrlich, aber ein Haken
    -- lässt die zuvor gesetzten Felder (Kommando, Argumente) für ein Wiedereinschalten stehen.
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT mcp_servers_id_form CHECK (server_id ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT mcp_servers_args_array CHECK (jsonb_typeof(args) = 'array'),
    CONSTRAINT mcp_servers_env_object CHECK (jsonb_typeof(env) = 'object'),
    CONSTRAINT mcp_servers_command_nonempty CHECK (btrim(command) <> '')
);

-- Der Lesepfad des Gateways beim Start: welche Server soll ich spawnen?
CREATE INDEX idx_mcp_servers_enabled ON kuronami.mcp_servers (enabled) WHERE enabled;
