-- S16. Ein sechster Kanalwert: `gateway`.
--
-- Der Grund steht im Fertig-Kriterium der Session: "Zwei Kanäle, ein Agent, ein Gedächtnis".
-- Das Gedächtnis einer Unterhaltung ist ihr Ereignisprotokoll, und das ist je Session
-- geführt. Beide Kanäle müssen also in **dieselbe** Session schreiben, sonst hätte derselbe
-- Nutzer zwei Gedächtnisse und der Agent wüsste am Telegram-Kanal nichts von dem, was im Web
-- besprochen wurde.
--
-- Die Session wird über `(thread_id, channel)` wiedergefunden (UNIQUE seit 0003). Damit zwei
-- Kanäle dieselbe Zeile treffen, muss `channel` für sie **derselbe Wert** sein — und dieser
-- Wert kann weder `web` noch `telegram` heißen, weil er dann für die jeweils andere Hälfte
-- der Unterhaltung eine Falschaussage wäre. `gateway` sagt genau das Richtige: diese Session
-- gehört keiner einzelnen Oberfläche, sondern der Surface-Schicht, die mehrere bedient.
--
-- Der Kanal der einzelnen **Nachricht** geht dabei nicht verloren: er steht im
-- `gateway.received`-Ereignis, zusammen mit Absender, Inhalt, Anhängen und Zeit. Genau
-- daraus leitet das Gateway ab, an welchen Kanal eine Freigabeanfrage gehört. Der Kanal
-- wandert also von der Session-Zeile in die Nachricht — dorthin, wo er hingehört, weil er
-- sich je Nachricht ändern kann und die Session nicht.
--
-- Die bestehenden fünf Werte bleiben unverändert in Bedeutung und Schreibweise. Es kommt
-- einer dazu, keiner wird umgedeutet.
--
-- Postgres kann einen Enum-Wert nur hinzufügen, nicht entfernen. Damit die Down-Migration
-- den Zustand von 0001 wirklich wiederherstellt (und nicht nur ungefähr), wird der Typ hier
-- umbenannt und neu angelegt statt per ALTER TYPE ... ADD VALUE erweitert — dasselbe
-- Vorgehen wie bei `approval_scope` in 0007. Down macht denselben Weg rückwärts.
--
-- Der UNIQUE-Index `idx_sessions_thread_channel` aus 0003 überlebt den Typwechsel: Postgres
-- baut die Indizes einer Spalte beim ALTER COLUMN ... TYPE neu auf. Die Zusage "eine Session
-- je Faden und Kanal" gilt also lückenlos weiter.
ALTER TYPE kuronami.session_channel RENAME TO session_channel_old;

CREATE TYPE kuronami.session_channel AS ENUM (
    'web', 'telegram', 'mail', 'heartbeat', 'voice', 'gateway'
);

ALTER TABLE kuronami.sessions
    ALTER COLUMN channel TYPE kuronami.session_channel
        USING channel::text::kuronami.session_channel;

DROP TYPE kuronami.session_channel_old;
