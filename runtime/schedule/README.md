Hierhin gehört alles, was "wann läuft etwas" beantwortet, ohne selbst etwas zu starten: heute
der winzige Cron-Parser (`cron.ts`, fünf Felder, Minutengranularität, ohne Bibliothek). Er lag
bis S19 in `heartbeat/` und ist hierher gewandert, als ein Zeitplan aufhörte, allein die
Einstellung des Heartbeat-Dienstes zu sein: seit der Agenten-Registry ist er eine Eigenschaft
eines Agenten (`kuronami.agents.schedule`), und `agent.create` prüft ihn beim Anlegen — aus
`tools/` heraus, das nichts aus `heartbeat/` importieren darf (Abschnitt 3, harte Regel). Zwei
Parser nebeneinander wären zwei Wahrheiten über dieselbe Form; also steht der eine dort, wo
beide Seiten ihn erreichen. Wer hier etwas ergänzt, ergänzt Parsen und Rechnen auf Zeitpunkten,
keine Ausführung — die steht in `heartbeat/`.
