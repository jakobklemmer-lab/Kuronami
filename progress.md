# Fortschrittslog

Diese Datei ist die Kurzfassung. Fuer Details zu einer bestimmten alten Session in
progress-archiv.md nachschlagen (z. B. mit grep nach der Session-ID).

## Aktueller Stand

Phase 4 laeuft. Zuletzt abgeschlossen: **S18b** (Frisches-Fenster-Heuristik und verzoegertes
Tool-Laden), 2026-09-11. Naechste Session: **S18c** Skill-System (progressive Offenlegung),
Status `ready`.

## Sessions

| ID | Titel | Status |
| --- | --- | --- |
| S01 | Repo-Grundgerüst | done |
| S02 | Postgres-Schema | done |
| S03 | Ereignisprotokoll | done |
| S04 | Runtime-Skelett | done |
| S05 | Wiederaufnahme und Abbruch | done |
| S06 | Artefaktspeicher | done |
| S07 | Tool-Router | done |
| S08 | Kern-Tools fs.* | done |
| S09 | web.search / web.fetch | done |
| S10 | task.* und user.ask | done |
| S11 | Policy-Engine | done |
| S12 | Erster echter Loop | done |
| S12b | Dev-Oberfläche (Tauri, read-mostly) | done |
| S13 | n8n-Brücke | done |
| S14 | Mail-Tools | done |
| S15 | Kalender und Obsidian | done |
| S16 | Gateway | done |
| S17 | Heartbeat | done |
| S18 | Langzeitgedächtnis | done |
| S18a | Kompaktierung Stufe 2+3 und Cache-Messung | done |
| S18b | Frisches-Fenster-Heuristik und verzoegertes Tool-Laden | done |
| S18c | Skill-System (progressive Offenlegung) | ready |
| S18d | Erste eigene Skills | queued |
| S18e | Modell-Routing | queued |
| S18f | Eval-Suite fuer lange Laeufe | queued |
| S19 | Agenten-Registry und agent.create | queued |
| S20 | Erste Subagent-Besetzung | queued |
| S21 | Kosten-Tracking und Modell-Routing | queued |
| S22 | Tauri-Desktop-Wrapper | queued |
| S23 | Sprachschicht-Grundgerüst | queued |
| S24 | Barge-in und Backend-Brücke | queued |

Details siehe progress-archiv.md.

## Offene Befunde (gesamte Historie)

- **Postgres-Port oeffentlich** (`0.0.0.0:5432`), offen seit S13, in jeder folgenden Session
  bestaetigt. Bewusst nicht angefasst, weil Tests daran haengen; naechster Schritt, sobald
  Erreichbarkeit als Ganzes drankommt.
- **`web.search`-Anbieter fehlt**, offen seit S09. Digest (S17) laesst den News-Abschnitt
  deshalb weg, Prompt sagt dem Modell das explizit.
- **`structured.reason` ist eine Verabredung, kein Typ**, offen seit S07. Mehrfach als
  "sobald etwas darauf verzweigen will, gehoert es in eine Aufzaehlung" vermerkt (S08, S09,
  S11, S12, S13, S14, S15, S16). S12 verzweigt inzwischen ueber den Fehlertyp, nicht das Feld.
- **`fs.*`/`web.*`-Fehler tragen `reason: "handler_failed"`** ohne Detail im Feld (nur im
  Meldungstext) — S08, S09.
- **Zeitzonen-Themen**: `cal.list`-Vorgabefenster ist lokale Zeit des Prozesses (seit S15),
  ebenso Heartbeat-Tagesgrenze/Cron (S17) und Notizdatum im Langzeitgedächtnis (S18). Braucht
  eine Nutzer-Zeitzone, die bislang nirgends bekannt ist.
- **Gateway-Zusammenfassung bewusst nicht gebaut**: Sessionliste/Verlaufsstand falten bislang
  das ganze Protokoll je Abfrage (S12b, aehnlich S12) — fuer heutige Groessen unmessbar, aber
  ein mitgeschriebener Snapshot waere die Antwort, sobald es das nicht mehr ist.
- **Kein echter Modellaufruf fuer Kompaktierung/Uebergabe pruefbar**: `ANTHROPIC_API_KEY` ist
  durchgehend leer (S16 ff., zuletzt S18a/S18b). Mechanik ist per Drehbuch/echtem Router
  bewiesen, echtes Modellverhalten nicht.
- **Freigabe-Koernung grob** bei `cal.create`/`cal.update`/`notes.write`/`mail.draft`: eine
  `session`-Freigabe deckt jeden weiteren Aufruf desselben Tools (S15).
- **Serialisierung im Gateway ist prozesslokal**, kein verteilter Lock (S16) — heute ein
  Prozess, daher nicht dringend.
- **`<deferred_tools>`-Block waechst unbegrenzt** mit der Zahl der Assistenz-Tools (S18b);
  bei sieben heute unauffaellig, S18d/Phase 5 lassen den Katalog wachsen.
- **Diverse lineare Scans/wiederholte Arbeit je Zug statt je Session**: `estimateFixedOverheadTokens`
  (S18a), `stage3StreakSince`/`taskCompletedSince` (S18b), Teilwortsuche im Langzeitgedächtnis
  (S18) — bei heutigen Groessen unmessbar, aber ohne Faltung ueber Zuege hinweg.
- Weitere kleinere, session-lokale Befunde (Web-Postfach-Groesse, Git-Prozessstarts je Notiz,
  Injection-Scan-Groesse, Katalog-Migrationspfad bei zwei Kanaelen, `ensureGitIdentity` nur
  beim Anlegen, u. a.) stehen im Detail in progress-archiv.md bei der jeweiligen Session.

## S18b · Frisches-Fenster-Heuristik und verzögertes Tool-Laden · 2026-09-11

Zweite Session der Phase 4. Der Auftrag nennt ein Nutzerbild als Leitplanke, wörtlich: Kuronami
ist **ein** durchgängiger Assistent, kein Interface mit mehreren Chat-Fenstern. Der "frische
Abschnitt" ist reine interne Buchführung, für den Nutzer unsichtbar — wie ein Notizbuch, das im
Hintergrund umblättert, während das Gespräch nahtlos weitergeht. Jede Entscheidung in dieser
Session hält sich an dieses Bild: nichts, was hier entsteht, verändert, wie sich eine
Unterhaltung anfühlt — nur, was im Hintergrund dafür sorgt, dass sie sich noch lange so anfühlt.

Keine Migration. Ein Ereignistyp kommt dazu (`context.section_started`), ein Namensraum
(`tool`), ein optionales Feld an `ToolDefinition` (`deferred`) — alles additiv, nichts
Bestehendes ändert seine Bedeutung.

### Kontextstufe 4 — ein anderer Auslöser, dieselbe Mechanik

Der naheliegende erste Gedanke war, Stufe 4 als eigenen Kürzungsmechanismus zu bauen — ein
zweites `applyStage4` neben `applyStage3`. Beim Hinsehen zeigte sich: das wäre eine zweite
Wahrheit über dieselbe Frage ("was wird aus der Historie vor einem Schnittpunkt"), nur mit
anderem Auslöser und knapperer Übergabe. Also die Umkehrung: `context/compaction.ts`s
`Stage3Record`/`latestStage3`/`applyStage3` wurden zu `CutRecord`/`latestCut`/`applyCut`
verallgemeinert — sie lesen jetzt **beide** Ereignistypen (`context.compacted` Stufe 3 **und**
`context.section_started`) und nehmen die höchste `through_seq` über beide hinweg. Das ist immer
korrekt und braucht keinen Sonderfall "welcher Typ ist neuer": ein frischer Abschnitt schneidet
per Konstruktion immer bei der zum Auslösezeitpunkt jüngsten Nachricht, sein `through_seq` ist
also nie kleiner als der einer zuvor gelesenen Stufe-3-Marke, und weil Sequenznummern über die
Zeit nur wachsen, ist "die höchste Marke, gleich woher" automatisch "die vollständigste bekannte
Kürzung". `context/section.ts` (neu) entscheidet nur noch, *ob* ein frischer Abschnitt beginnt,
schreibt den Rohverlauf als Artefakt, holt die Übergabe über einen eigenen Modellaufruf und
protokolliert `context.section_started` — die eigentliche Wirkung entsteht erst beim nächsten
`compactHistory`-Aufruf, ohne dass die beiden Module sich kennen müssten außer über das
Protokoll. `largestBalancedPrefix` und `renderSpan` wurden aus `compaction.ts` exportiert statt
verdoppelt.

**Die drei Auslöser** (Auftrag, wörtlich, "beides kombiniert, was zuerst eintritt", plus
Fallback):

- **Ruhepause** — `idleMs` seit dem letzten Ereignis der Session (Startwert 45 Minuten).
- **Aufgabenabschluss** — ein `task.created`/`task.updated` mit `status: "done"` seit dem
  letzten Abschnittswechsel. Kein neues Ereignis dafür nötig: `task.*` trägt `status` schon im
  Payload (S05), ein frisches "task.completed" wäre eine zweite Schreibweise derselben Aussage.
- **Stufe-3-Fallback** — `maxConsecutiveStage3` (Startwert 3) aufeinanderfolgende
  Stufe-3-Kompaktierungen seit dem letzten Abschnittswechsel, ohne dass die beiden ersten
  angesprungen wären. Ohne ihn bekäme ein Lauf, der weder ruht noch je eine Aufgabe abschließt,
  nie einen frischen Abschnitt und liefe für immer auf Stufe 3 allein.

**Nur beim Beginn eines neuen Zugs geprüft**, nicht mitten in einem laufenden — dieselbe Stelle,
an der auch das Langzeitgedächtnis nachschlägt (`runtime/loop/loop.ts`, vor `turn.started`). Für
die Ruhepause ist das keine Einschränkung, sondern die einzig mögliche Stelle: eine Lücke
zwischen Nachrichten wird erst beim Eintreffen der nächsten Nachricht erkennbar, es gibt keinen
Hintergrund-Zeitgeber, der eine Session ohne Anlass aufweckt. Für Aufgabenabschluss und den
Stufe-3-Fallback ist es eine bewusste Vereinfachung: beide *könnten* auch mitten in einem sehr
langen Zug auftreten (der 110-Schritte-Nachweis aus S18a zeigt genau so einen Fall), werden aber
erst beim nächsten Zugbeginn wirksam — ein frischer Abschnitt mitten in einem Zug stellte der
geschützten letzten Runde aus Stufe 2 und 3 einen zweiten, widersprechenden Mechanismus zur
Seite, ohne dass der Auftrag das verlangt.

**Kompakt, mit Absicht.** Stufe 3 fragt nach sechs Abschnitten (Ziel, Stand, offene Aufgaben,
Entscheidungen, Artefakt-Refs, nächster Schritt) — eine vollständige Übergabe für einen
Ausschnitt, der sonst ersatzlos verschwindet. Ein frischer Abschnitt fragt nach dreien (Stand,
offen, Referenzen) — "kompakt, nur was der nächste Abschnitt braucht" (Auftrag, wörtlich).
Länger geltendes Wissen geht **nicht** über dieses Feld zurück: es geht über das
Langzeitgedächtnis aus S18.

### Die Lücke, die das erst zum Ganzen macht: wann eine Unterhaltung endet

S18 hatte offen gelassen, "wann eine Unterhaltung endet" (progress.md, offene Befunde zu S18)
und `runtime/loop/api.ts` koppelte `summarizeToMemory` an `completeOnDone`. Das Gateway (S16)
setzt `completeOnDone: false`, weil ein fertiger Zug dort kein fertiger Auftrag ist — die
Unterhaltung geht mit der nächsten Nachricht weiter. Die Kopplung riss dabei unbeabsichtigt
`summarizeToMemory` mit: **das Gateway schrieb nie eine Gedächtnisnotiz**, unabhängig davon, ob
S18 überhaupt verdrahtet war (`gateway/index.ts` reichte bislang gar kein `memory` an
`buildCatalog` durch). Ohne diesen zweiten Fund wäre Stufe 4 eine Übergabe ins Leere gewesen: die
Historie würde gekürzt, aber nichts läge zum Zurückfinden bereit, und "für den Nutzer wirkt es
wie ein einziges durchgängiges Gespräch" (Auftrag) wäre falsch gewesen, sobald ein Abschnitt
wechselt.

Die Antwort, jetzt umgesetzt: `completeOnDone` und `summarizeToMemory` sind zwei verschiedene
Fragen — ob **die Session** vorbei ist, und ob **dieser Zug** etwas hinterlässt —, und nur die
erste hängt an "eine Unterhaltung endet nie". `gateway/conversation.ts` setzt
`summarizeToMemory: deps.memory !== undefined`, entkoppelt von `completeOnDone`; jeder
abgeschlossene Zug bekommt seine Chance auf eine Notiz. Die Auswahl bleibt trotzdem eng — kein
neuer Mechanismus, `summarizeRun`s eigene Zurückhaltung (`NICHTS` ist der Normalfall) verhindert
zweihundert Routinenotizen genauso im Gateway wie überall sonst. `gateway/index.ts` reicht jetzt
`memory: {}` an `buildCatalog` durch (derselbe Startwert wie in `runtime/index.ts`, das dasselbe
schon seit S18 tut — "kein Anschluss nach draußen wie n8n oder der Vault, sondern ein Teil des
Systems") und schließt den Store beim Herunterfahren.

### Verzögertes Tool-Laden

Section 9 trennt schon länger "Kern-Primitive, nativ in der Runtime" von "Assistenz-Tools über
n8n" — diese Grenze trägt jetzt auch technisch. `ToolDefinition.deferred` (Vorgabe `false`)
markiert ein Tool als Assistenz-Tool: sein volles Eingabeschema steht nicht mehr in der
`tools`-Liste der Anfrage, sondern nur Name und Kurzbeschreibung im `<deferred_tools>`-Block
neben den Konventionen (`context/request.ts`, `renderDeferredStubs`). `mail.*`, `cal.*`,
`server.metrics`, `memory.*` und jeder generische n8n-Workflow (`createN8nTools`) sind jetzt
`deferred: true` — `fs.*`, `web.*`, `task.*`, `user.*`, `notes.*` (Kern-Primitive laut Section 9)
bleiben es nicht.

`tool.load` (`tools/tool/tools.ts`, neuer Namensraum `tool`) ist der Weg zurück: ein Aufruf mit
Toolnamen liefert deren volles Schema als Ergebnis. `deriveLoadedToolNames` liest zurück, welche
Namen ein `tool.completed` von `tool.load` schon geliefert hat (dieselbe
Wiederanwenden-statt-wiederholen-Idempotenz wie bei Kontextstufe 2 und 3), und
`toolSpecs`/`buildModelRequest` nehmen ein geladenes Tool ab dem nächsten Modellaufruf mit vollem
Schema in die `tools`-Liste auf — an seiner alphabetischen Stelle, keine Sonderreihenfolge. Der
**Katalog** selbst bleibt dabei unberührt: er kennt jedes Tool die ganze Zeit, der eingefrorene
Fingerabdruck (S07) ändert sich nicht, wenn ein Tool geladen wird, und der Router führt es
unverändert aus, ob geladen oder nicht — `deferred` ist eine reine Presentation-Layer-Frage, was
in einer bestimmten Anfrage steht, keine Frage der Katalog-Identität. Deshalb zählt `deferred`
auch nicht in `fingerprintTools`, aus derselben Begründung wie bei `execution` seit S10.

`tool.load` selbst ist **nie** `deferred` — ohne einen von Anfang an sichtbaren Weg, ein Tool
nachzuladen, gäbe es keinen Ausweg aus dem `<deferred_tools>`-Block. Weil es Namen aus dem
übrigen Katalog nachschlagen muss, aber selbst Teil des endgültigen Katalogs sein soll, friert
`buildCatalog` (`runtime/loop/api.ts`) jetzt zweimal ein: einmal ohne `tool.load` (nur zum
Nachschlagen im Handler), dann mit. Das ist der einzige Punkt, an dem der ausgelieferte
Basiskatalog sich sichtbar ändert — 11 Tools statt 10, Fingerabdruck `v1-127776df761f8134` statt
`v1-53a18ba0cb4e49c8` (S12/S13) —, und fünf bestehende Tests, die den alten Wert fest verdrahtet
hatten (`tools/mail`, `tools/cal`, `tools/server`, `tools/n8n`), mussten entsprechend
nachgezogen werden. Das ist keine Regression, sondern die genaue Aussage der Session: der
ausgelieferte Katalog trägt jetzt immer einen Weg aus dem `<deferred_tools>`-Block heraus.

**Warum eine Presentation-Layer-Lösung und keine Katalogänderung mitten in der Session.**
Abschnitt 7 verbietet ausdrücklich, Tools mitten in der Session hinzuzufügen oder zu entfernen —
das würde den Katalog-Fingerabdruck und damit die Session-Kompatibilität (S07) untergraben. Ein
Tool, das erst nach `tool.load` in der `tools`-Liste einer Anfrage auftaucht, verändert weder den
Katalog noch dessen Fingerabdruck; es ändert nur, welcher **Ausschnitt** des immer gleichen,
immer eingefrorenen Katalogs in einer bestimmten Anfrage steht — dieselbe Unterscheidung, die
Kontextstufe 2 und 3 schon zwischen Protokoll (unveränderlich) und Anfrage (kleiner) treffen.

### Tests

20 neue, zusammen 596 (57 Dateien).

- **`context/section.test.ts`** (6, mit Datenbank, ohne Loop — dieselbe Isolation wie
  `compaction.test.ts` für Stufe 2/3): jeder der drei Auslöser einzeln, und die Gegenprobe, dass
  keiner ohne triftigen Grund feuert (Ruhepause noch nicht erreicht, fallengelassene bzw.
  nicht-`done`-Aufgabe, Kette unterhalb der konfigurierten Länge).
- **`context/compaction.test.ts`**, neue Gruppe "Kontextstufe 4" (1): `compactHistory` wendet
  einen von außen geschriebenen `context.section_started` genauso an wie eine eigene
  Stufe-3-Zusammenfassung — der Nachweis, dass die beiden Module nur über das Protokoll
  zusammenspielen, nicht über eine gemeinsame Funktion.
- **`context/request.test.ts`**, neue Gruppe "Verzögertes Tool-Laden" (5): ein `deferred`-Tool
  fehlt in `toolSpecs`, bis sein Name in `loadedTools` steht; der `<deferred_tools>`-Block trägt
  Name und Kurzbeschreibung und verschwindet ganz, sobald alles geladen ist;
  `deriveLoadedToolNames` liest ein `tool.completed` von `tool.load` richtig zurück.
- **`tools/tool/tools.test.ts`** (3, echter Router): `tool.load` läuft ohne Schritt (wie
  `task.set`), meldet unbekannte Namen ohne die bekannten zu verlieren, weist eine leere
  Namensliste ab.
- **`runtime/loop/loop.test.ts`**, zwei neue Gruppen:
  - "Kontextstufe 4" (4, mit echtem Router/Policy/`fs.*`): Ruhepause (mit künstlich kleinem
    `idleMs`, echter kurzer Wartezeit zwischen zwei Zügen) entfernt das alte Thema nachweislich
    aus der dritten gesendeten Anfrage; Aufgabenabschluss über `task.set`; der Stufe-3-Fallback
    über denselben 110-Schritte-Aufbau wie S18a (hier mit 40 Schritten, `maxConsecutiveStage3: 2`
    — reicht zuverlässig); und der Gedächtnis-Rundlauf: ein Zug hinterlässt trotz
    `completeOnDone: false` eine Notiz, ein zweiter (ruhepausenausgelöster) Abschnittswechsel
    folgt, ein dritter Zug zu einem alten Thema findet die Notiz über `memory.recalled` wieder —
    der Nachweis für "für den Nutzer wirkt es wie ein einziges durchgängiges Gespräch" auf
    mechanischer Ebene (was das Modell daraus semantisch macht, ist außerhalb dessen, was ohne
    Anbieterschlüssel prüfbar ist, siehe offene Befunde).
  - "Verzögertes Tool-Laden" (1): ein Drehbuch ruft `tool.load` für ein `deferred`-Tool, dann
    das Tool selbst — die erste Anfrage trägt sein Schema nicht, die zweite (nach dem
    `tool.completed` von `tool.load`) trägt es vollständig, ohne dass sich der Katalog geändert
    hätte.
- Der freigegebene Katalog (`runtime/loop/api.ts`) trägt jetzt immer `tool.load`; fünf
  bestehende Tests mit fest verdrahtetem Fingerabdruck/Toolzahl wurden entsprechend angepasst
  (siehe oben).

### Gegenproben

Drei, alle bestätigt und danach zurückgesetzt:

- **Den Stufe-3-Fallback in `maybeStartFreshSection` deaktiviert** (`if (false && streak >= …)`)
  → genau der zugehörige Test in `context/section.test.ts` rot: `started` bleibt `false`, obwohl
  drei Stufe-3-Kompaktierungen im Protokoll stehen.
- **Die verallgemeinerte `purpose`-Prüfung in `deriveLoopState` auf `"compaction"` zurückgesetzt**
  (wie vor dieser Session) → beide betroffenen Loop-Tests sterben mit demselben echten Fehler wie
  in S18a Gegenprobe 2: "Ereignis model.responded trägt keine Inhaltsblöcke" — die
  Übergabe-Antwort eines frischen Abschnitts hat kein `tool_calls`-Feld im Sinn der
  Transkript-Faltung, weil sie keine Zugantwort ist.
- **Den `context.section_started`-Zweig aus `latestCut` entfernt** → der neue
  Kontextstufe-4-Test in `compaction.test.ts` rot: `compactHistory` liefert die volle,
  ungekürzte Historie zurück (5 statt 4 Nachrichten) — der Beweis, dass die beiden Module
  tatsächlich nur über das eine gelesene Ereignis verbunden sind und nicht zufällig durch
  irgendeinen anderen Pfad.

### Bewusst nicht gebaut

- **Ein Hintergrund-Zeitgeber für die Ruhepause.** Sie wird beim Eintreffen der nächsten
  Nachricht rückwirkend erkannt, nicht durch einen Prozess, der eine Session nach 45 Minuten
  Stille von sich aus aufweckt. Für eine reine Kontext-Ökonomie-Maßnahme (kein Digest, keine
  Zustellung) wäre ein solcher Zeitgeber ein zweiter Mechanismus für etwas, das die nächste
  Nachricht ohnehin beiläufig mitbringt.
- **Ein frischer Abschnitt mitten in einem laufenden Zug.** Siehe oben — beide "könnten"-Fälle
  sind bewusst auf den nächsten Zugbeginn verschoben.
- **Eine vierte Stufe der Tool-Ladung mit Teilschemata oder Platzhalter-Schemata in der
  `tools`-Liste.** Ein Tool ist entweder mit vollem, korrektem Schema aufrufbar oder gar nicht in
  der Liste — ein Platzhalter-Schema wäre eine falsche Zusage an den Anbieter darüber, wie ein
  Aufruf aussehen darf.
- **Eine feinere Tiering-Logik als das eine `deferred`-Feld** (z. B. Stufen wie "geladen, aber
  noch nicht bestätigt"). Der Auftrag nennt zwei Zustände ("Kurzbeschreibung" und "volles
  Schema"), nicht drei.

### Offene Befunde (Details zu S18b)

- **Kein echter Modellaufruf für die Übergabe eines frischen Abschnitts** (wie schon für Stufe 3
  seit S18a): `ANTHROPIC_API_KEY` ist weiterhin leer. Der Gedächtnis-Rundlauf-Test beweist die
  **Mechanik** (Notiz schreiben, Abschnitt wechseln, Notiz wiederfinden), nicht, dass ein echtes
  Modell die Frage "wie hieß noch mein Lieblingscafé?" nach einem echten Abschnittswechsel
  tatsächlich richtig beantwortet — das hängt an semantischer Suche und Modellverhalten, die
  ohne Anbieterschlüssel nicht prüfbar sind.
- **`stage3StreakSince`/`taskCompletedSince` sind lineare Scans über das ganze Protokoll seit dem
  letzten Abschnittswechsel**, bei jedem neuen Zugbeginn erneut. Für die heutigen Sessionlängen
  unmessbar, aber es ist dieselbe Art wiederholter Arbeit, die S18a schon bei
  `estimateFixedOverheadTokens` notiert hat — keine Faltung über Züge hinweg.
- **`idleMs` misst die Zeit seit dem letzten Ereignis der Session, nicht seit der letzten
  Nutzernachricht ausdrücklich.** In der Praxis identisch (zwischen zwei Zügen passiert nichts
  anderes), würde aber auseinanderfallen, sobald irgendein anderer Prozess in dieselbe Session
  schriebe, ohne dass ein Zug läuft — heute nicht der Fall, aber kein technisch erzwungener
  Ausschluss.
- **Der `<deferred_tools>`-Block wächst unbegrenzt mit der Zahl der Assistenz-Tools.** Bei den
  heutigen sieben (`mail.*` drei, `cal.*` drei, `server.metrics` eins, plus `memory.*`/n8n-
  Workflows situativ) unauffällig; S18d und Phase 5 lassen den Katalog wachsen, und irgendwann
  könnte auch die Kurzbeschreibungsliste selbst groß genug werden, um eine eigene Auslagerung zu
  brauchen — heute nicht nötig, aber absehbar.
- Der Postgres-Port ist weiterhin öffentlich (offen seit S13). Der `web.search`-Anbieter fehlt
  weiterhin (offen seit S09). Abschnitt 4.8 nannte `memory` bisher nicht in der Liste erlaubter
  Namensräume, obwohl S18 ihn längst nutzte — mit `tool` in derselben Session nachgezogen.
- `pnpm typecheck && pnpm lint && pnpm test` grün, 596 Tests.
- `tasks.json`: S18b auf `done`, S18c von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S18c Skill-System (progressive Offenlegung).
