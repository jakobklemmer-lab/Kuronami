-- S05. Ein Schritt braucht einen Schlüssel, den ein wiederaufnehmender Prozess kennt,
-- bevor er den Schritt anlegt. Abschnitt 6 nennt dafür `step_id` — als Idempotenzschlüssel
-- reicht der aber nur, solange die Zeile schon existiert: nach einem Absturz leitet der
-- neue Prozess seinen Plan neu ab und würde für dieselbe logische Arbeit eine neue
-- step_id würfeln. Der Schlüssel muss also aus der Arbeit folgen, nicht aus der Zeile.
-- step_id bleibt die Identität der Zeile, idempotency_key wird die Identität der Arbeit.
ALTER TABLE kuronami.steps ADD COLUMN idempotency_key text;

-- Bestehende Zeilen bekommen ihre eigene step_id als Schlüssel: das ist genau die Lesart
-- aus Abschnitt 6 und damit für alles, was vor dieser Migration entstand, korrekt.
UPDATE kuronami.steps SET idempotency_key = step_id WHERE idempotency_key IS NULL;
ALTER TABLE kuronami.steps ALTER COLUMN idempotency_key SET NOT NULL;

-- Zählt die Ausführungsversuche desselben Schlüssels. 0 heißt: noch nie gestartet.
-- Ohne diesen Zähler wäre im Protokoll ein wiederholter Schritt nicht von einem
-- erstmaligen zu unterscheiden, und die Obergrenze aus Abschnitt 13 hinge in der Luft.
ALTER TABLE kuronami.steps ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0);

-- Darf dieser Seiteneffekt gefahrlos ein zweites Mal laufen? Das entscheidet bei der
-- Wiederaufnahme, ob ein unterbrochener Schritt wiederholt oder endgültig als
-- fehlgeschlagen abgelegt wird ("Nie raten", Abschnitt 6). DEFAULT false ist bewusst die
-- vorsichtige Seite: wer nichts sagt, bekommt keinen zweiten Seiteneffekt. Die
-- TypeScript-Hülle verlangt das Feld trotzdem ausdrücklich, damit die Entscheidung an der
-- Aufrufstelle fällt und nicht in einem Default verschwindet.
ALTER TABLE kuronami.steps ADD COLUMN repeatable boolean NOT NULL DEFAULT false;

-- Das Ergebnis des Seiteneffekts. Es steht ohnehin im Ereignis step.completed; hier steht
-- es, weil ein zweiter Aufruf mit demselben Schlüssel es zurückgeben muss, ohne den
-- Seiteneffekt noch einmal auszulösen. Beide entstehen in derselben Transaktion und
-- können deshalb nicht auseinanderlaufen.
ALTER TABLE kuronami.steps ADD COLUMN result jsonb;

-- Die Zusage liegt in der Datenbank, nicht in der Anwendungslogik — nach dem Muster von
-- idx_events_session_seq (S03) und idx_sessions_thread_channel (S04). Zwei gleichzeitig
-- laufende Prozesse können denselben Schritt damit nicht zweimal anlegen.
CREATE UNIQUE INDEX idx_steps_session_idempotency
    ON kuronami.steps (session_id, idempotency_key);
