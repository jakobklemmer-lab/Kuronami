-- Rücknahme von 0008. `kuronami.session_channel` steht danach wieder exakt in der Form von
-- 0001, mit den fünf Werten der Architektur (Abschnitt 5).

-- Sessions auf dem Kanal `gateway` sind vor 0008 nicht darstellbar. Sie stillschweigend auf
-- `web` umzuschreiben wäre eine Bedeutungsänderung hinter dem Rücken des Betreibers: aus
-- einer kanalübergreifenden Unterhaltung würde eine, die behauptet, im Web geführt worden zu
-- sein — und die nächste Telegram-Nachricht legte daneben eine zweite Session an, also genau
-- die zwei Gedächtnisse, die 0008 verhindert. Deshalb bricht die Rücknahme hier ab und sagt,
-- was zu tun ist (AGENTS.md: Fehler nie verstecken oder glätten).
DO $$
DECLARE
    gateway_count integer;
BEGIN
    SELECT count(*) INTO gateway_count FROM kuronami.sessions WHERE channel = 'gateway';
    IF gateway_count > 0 THEN
        RAISE EXCEPTION
            'Migration 0008 lässt sich nicht zurücknehmen: % Session(s) auf dem Kanal "gateway". Dieser Kanal existiert vor 0008 nicht. Entscheide bewusst, ob sie gelöscht oder einem einzelnen Kanal zugeschlagen werden, und tue es vor dem Down.',
            gateway_count;
    END IF;
END $$;

ALTER TYPE kuronami.session_channel RENAME TO session_channel_old;

CREATE TYPE kuronami.session_channel AS ENUM ('web', 'telegram', 'mail', 'heartbeat', 'voice');

ALTER TABLE kuronami.sessions
    ALTER COLUMN channel TYPE kuronami.session_channel
        USING channel::text::kuronami.session_channel;

DROP TYPE kuronami.session_channel_old;
