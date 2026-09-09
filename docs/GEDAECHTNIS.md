# Das Langzeitgedächtnis und der Namensraum `memory.*`

Entstanden in S18. Diese Datei ist die von AGENTS.md verlangte **Begründung in `docs/`** für
einen neuen Tool-Namensraum, und dazu die Stelle, an der die Abweichung vom Wortlaut des
Sessionauftrags festgehalten ist.

## Die Abweichung

Der Auftrag von S18 nennt die Werkzeuge **`notes.search(query)`** und
**`notes.write(inhalt, tags)`**. Gebaut wurden **`memory.search`** und **`memory.write`**.

Der Grund ist eine Kollision, die der Auftrag nicht kennen konnte: `notes.read` und
`notes.write` gibt es seit **S15**. Sie greifen direkt auf den **Obsidian-Vault des Nutzers**
zu — `notes.write(note, content)` schreibt eine Datei an einen vom Aufrufer bestimmten Pfad im
Vault, ist `hard_write` und pausiert bei jedem Aufruf für eine Freigabe.

## Die drei Auflösungen, die nicht gewählt wurden

**`notes.write` überladen.** Ein Aufruf mit `note` schriebe in den Vault, einer mit `tags` ins
Gedächtnis. Damit hätte ein Tool zwei Ziele, zwei Risikostufen und zwei Zonen, und das Modell
entschiede über den Speicherort, indem es ein Feld wegließe. Ein vergessenes `note` schriebe
eine Vault-Notiz ins Gedächtnis, ein vergessenes `tags` umgekehrt — beides ohne Fehlermeldung,
weil beide Aufrufe gültig wären. Das ist die Art stiller Falle, gegen die dieses Projekt an
jeder anderen Stelle baut (vgl. `assertPolicyFieldNames` in `policy/resource.ts`).

**Nur `notes.search` bauen und das Schreiben lassen.** Dann zeigte `notes.search` auf
`memory/` und `notes.read` daneben auf den Vault. Ein Namensraum, dessen Verben verschiedene
Korpora meinen, ist schlimmer als zwei Namensräume: die Fehlannahme fällt erst auf, wenn
jemand ein Suchergebnis mit `notes.read` öffnen will und nichts findet.

**Die Obsidian-Tools umbenennen.** Kostet dieselbe Erweiterung der Namensraumliste *plus* eine
Umbenennung ausgelieferter, getesteter Tools, einen neuen Katalog-Fingerabdruck und eine
Abweichung zu Abschnitt 9 der Architektur, wo `notes.*` ausdrücklich für Obsidian steht.

## Warum der eigene Namensraum sachlich richtig ist

Es sind zwei Ablagen mit verschiedenen **Eigentümern**:

| | `notes.*` (S15) | `memory.*` (S18) |
| --- | --- | --- |
| Wem gehört es | dem Menschen | dem Assistenten |
| Was liegt drin | der Obsidian-Vault | Ereignisse und Erkenntnisse aus Läufen |
| Wer schreibt | der Assistent, mit Freigabe | der Assistent, selbständig |
| Risikostufe | `hard_write`, pausiert immer | `soft_write`, läuft durch |
| Ort | `OBSIDIAN_VAULT_PATH`, außerhalb jeder `fs`-Zone | `memory/`, eigenes Git-Repo |
| Wer bestimmt den Pfad | der Aufrufer (Feld `note`) | der Speicher (Datum + Titel) |
| Wird automatisch gelesen | nein | ja, vor jedem Zug |

Der letzte Punkt trägt allein schon: das Gedächtnis wird **ohne Werkzeugaufruf** in jeden Zug
geladen. Ein Speicher mit dieser Eigenschaft ist etwas anderes als einer, den man aufruft.

S17 hatte den Namensraum bereits vorgezeichnet: „Ein `memory.*`-Namespace als Tool. Es gibt
ihn nicht (S18). `background-longterm-memory-write` greift heute über den **Pfad**
(`memory/**`), nicht über den Toolnamen; kommt der Namespace, ist die zusätzliche Regel
`when: { tool: "memory.*" }` eine Zeile."

## Die Zeile war nötig, und zwar mehr als vorhergesagt

`memory.write` hat **kein Pfadfeld** — der Dateiname folgt aus Datum und Titel (siehe unten).
Damit ordnet die Policy-Engine den Aufruf als Ressource `none` ein, und die Regel
`background-longterm-memory-write` aus S17 (`when: { path: "memory/**" }`) trifft ihn
**nicht**: sie verlangt `resource.kind === "path"`.

Ohne die neue Regel `background-memory-tool-write` wäre die Schreibgrenze aus S17 mit dem
neuen Werkzeug also lautlos umgangen gewesen — ein Hintergrundlauf hätte ins Gedächtnis
geschrieben, obwohl S17 genau das ausschließt, und die alte Regel hätte weiter dagestanden und
den Eindruck erweckt, sie greife. Als Gegenprobe bestätigt: mit entfernter Tool-Regel läuft
`memory.write` im Hintergrundprofil durch.

## Warum `memory.write` kein Pfadfeld hat

Dieselbe Überlegung wie beim Feld `note` in S15, nur andersherum. Die Policy-Engine findet
Pfade unter dem Namen `path` und löst sie über den `fs`-Zonen-Resolver auf. `memory/` liegt in
der **Quellzone**, und die Regel `write-outside-artifact-zone` höbe jeden Schreibzugriff dort
auf `hard_write` an — jede Gedächtnisnotiz pausierte dann für eine Freigabe, auch die
automatische nach dem Lauf, für die niemand mehr da ist.

Ohne Pfadfeld bleibt die Ressource `none`, der Boden `soft_write` greift, und der Aufruf läuft
durch. Der Nebeneffekt ist der eigentliche Gewinn: **der Aufrufer kann gar nicht bestimmen,
wohin geschrieben wird.** `memory.write` schreibt strukturell nur ins Gedächtnis.

## Was das Gedächtnis nicht ist

Es ist **kein Ersatz für AGENTS.md**. Konventionen, Vorlieben und Dauerregeln gehören dorthin,
Ereignisse und Erkenntnisse hierher. Die Trennung ist am Feld `art` festgemacht (zwei Werte,
keiner für „Konvention"), lässt sich aber nicht vollständig erzwingen — ob ein Satz eine
Dauerregel ist, sieht man ihm nicht an. Deshalb steht daneben ein Hinweis
(`conventionSmell`), der meldet statt abzulehnen.

Es ist auch **kein Protokoll**. Das Protokoll (`kuronami.events`) hält jeden Lauf vollständig
fest und ist die Wahrheit über das, was geschah. Das Gedächtnis ist eine **Auswahl** daraus,
getroffen mit Blick darauf, was beim nächsten Mal den Unterschied macht. Die meisten Läufe
hinterlassen nichts.
