# `memory.*` — das Langzeitgedächtnis (S18)

Markdown-Notizen in `memory/` (eigenes Git-Repo), daneben ein SQLite-Volltextindex.
**Keine Vektordatenbank** — die Begründung steht in `index-db.ts`.

| Datei | Aufgabe |
| --- | --- |
| `frontmatter.ts` | Winziger Parser für den Notizkopf, ohne YAML-Bibliothek |
| `index-db.ts` | SQLite mit FTS5: Schema, Suche, BM25-Gewichte, Anfragenaufbereitung |
| `store.ts` | Dateien, Kennungen, Git-Commits, Widerspruchsvermerke |
| `recall.ts` | Das automatische Laden **vor** dem Zug |
| `summary.ts` | Die strukturierte Zusammenfassung **nach** dem Lauf |
| `tools.ts` | `memory.search` und `memory.write` |

## Die beiden Hälften laufen ohne Werkzeugaufruf

Das ist der Kern von S18 und der Grund für die eigenen Ereignisse:

* **Vor dem Zug** sucht `recallForTurn` mit der Eingabe des Nutzers und legt die Treffer in
  die Eröffnungsnachricht (`memory.recalled`). Das Modell muss nicht danach fragen — und das
  ist der Punkt: wer nicht weiß, dass es zu einem Thema schon eine Erkenntnis gibt, sucht
  nicht danach und macht den Fehler noch einmal.
* **Nach dem Lauf** entscheidet `summarizeRun`, ob etwas bleibt. Meistens bleibt nichts, und
  dann steht das als `memory.skipped` im Protokoll — sonst sähe eine bewusste Auswahl aus wie
  eine vergessene Zusammenfassung.

`memory.search` gibt es zusätzlich, für gezielte Nachfragen mit anderen Suchwörtern.

## Wer wohin gehört

| Hierher (`memory/`) | Nach `AGENTS.md` |
| --- | --- |
| Ereignisse mit Folgen für später | Konventionen und Arbeitsregeln |
| Erkenntnisse über die Welt außerhalb des Codes | Vorlieben und Dauerregeln |
| Widerlegte Annahmen, Entscheidungen samt Grund | Alles, was *immer* gilt |

Technisch festgemacht am Feld `art`: es kennt genau `ereignis` und `erkenntnis`, für eine
Konvention gibt es bewusst keinen Wert. Wer es trotzdem versucht, bekommt einen Fehlertext,
der auf AGENTS.md zeigt. Ergänzend meldet `conventionSmell` einen Verdacht im Ergebnis —
als Hinweis, nicht als Ablehnung: eine Erkenntnis darf das Wort „immer" enthalten.

## Widersprüche

Es gibt keinen Schreibpfad, der eine bestehende Notiz ersetzt. Kollidiert eine Kennung, hängt
der Speicher `-2`/`-3` an (die Regel, die AGENTS.md für Artefakte aufstellt). Wer eine ältere
Notiz für überholt hält, sagt das mit `supersedes`: die alte behält ihren Text und bekommt im
Frontmatter ein `ersetzt_durch`, die neue ein `ersetzt`, und beide bleiben auffindbar. Der
Recall lädt zu einem Treffer die widersprechende Notiz **immer** mit, auch wenn das Limit
schon voll ist — sonst wäre die Suche der Ort, an dem ein Widerspruch doch still verschwindet.

## Warum `memory.*` und nicht `notes.*`

Der Sessionauftrag nennt `notes.search`/`notes.write`. Die Namen sind seit S15 vergeben:
`notes.*` greift auf den **Obsidian-Vault des Nutzers** zu. Zwei Ablagen mit verschiedenen
Eigentümern, Risikostufen und Zonen in einem Namensraum zu führen hieße, den Speicherort davon
abhängig zu machen, welches Feld das Modell gerade füllt. Die vollständige Abwägung steht in
`docs/GEDAECHTNIS.md` und im Kopf von `tools.ts`.

## Risikostufen

`memory.search` ist `read`. `memory.write` ist `soft_write` und pausiert **nicht** — anders
als `notes.write` (`hard_write`): das Gedächtnis ist die eigene Ablage dieses Systems, sie
liegt in Git, und ein Assistent, der für jede Notiz nachfragt, führt kein Gedächtnis.

Die Ausnahme ist der **Hintergrundlauf**: `BACKGROUND_RULES` verbietet `memory.write` mit
`deny` (nicht `ask` — ohne Menschen am anderen Ende wäre das ein `hang`). Die Regel greift
über den **Toolnamen**; die ältere Pfadregel aus S17 (`path: memory/**`) trifft `memory.write`
nicht, weil es bewusst kein Pfadfeld hat. Ohne die neue Regel wäre die Schreibgrenze lautlos
offen gewesen — als Gegenprobe bestätigt.
