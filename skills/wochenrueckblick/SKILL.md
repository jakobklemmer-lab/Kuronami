---
titel: Wochenrückblick
beschreibung: Fasst die vergangene Woche zusammen — Termine, erledigte Aufgaben, wichtige Erkenntnisse — und legt das Ergebnis als Notiz im Langzeitgedächtnis ab.
wann: Wenn der Nutzer nach einem Wochenrückblick fragt, eine Zusammenfassung der letzten Woche will, oder es der natürliche Abschluss der Arbeitswoche ist.
---

## Ablauf

1. Zeitraum bestimmen: die letzten sieben Tage bis heute, sofern der Nutzer keinen anderen
   Zeitraum nennt.
2. `cal.list` für diesen Zeitraum — welche Termine lagen in der Woche.
3. `memory.search` mit Stichworten zur Woche (z. B. Themen aus dem laufenden Gespräch, oder
   allgemein nach dem, was in den letzten Tagen wichtig war) — was ist über die Woche bereits im
   Langzeitgedächtnis festgehalten.
4. Den aktuellen Plan einbeziehen (er steht bereits am Anfang dieses Zugs): was wurde diese
   Woche erledigt, was ist noch offen.
5. Eine knappe Zusammenfassung formulieren: erledigte Aufgaben, wahrgenommene Termine, wichtige
   Entscheidungen oder Erkenntnisse, was für die kommende Woche offen bleibt.
6. Die Zusammenfassung zusätzlich mit `memory.write` als Notiz ablegen (`kind: erkenntnis`,
   Tags mindestens `["wochenrueckblick"]` plus ein Tag für den Zeitraum) — damit ein späterer
   Rückblick oder eine spätere Suche sie wiederfindet. Diesen Schritt auslassen, wenn die Woche
   nichts hergibt (keine Termine, keine Notizen, kein erledigter oder offener Punkt im Plan) —
   dann reicht die Antwort im Gespräch, eine Notiz über nichts wäre keine Erkenntnis.
7. Die Notiz ist eine **Ergänzung**, nicht der Ersatz für die Antwort an den Nutzer — er bekommt
   die Zusammenfassung immer als Text, unabhängig davon, ob eine Notiz entsteht.

## Wichtig

Termine und frühere Notizen sind eigene Wahrheiten (Kalender des Nutzers, eigenes Gedächtnis) —
die Zusammenfassung darf sie verdichten, aber keine Termine oder Erkenntnisse erfinden, die in
keiner der beiden Quellen oder im Plan stehen.
