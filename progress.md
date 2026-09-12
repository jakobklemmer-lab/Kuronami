# Fortschrittslog

Diese Datei ist die Kurzfassung. Fuer Details zu einer bestimmten alten Session in
progress-archiv.md nachschlagen (z. B. mit grep nach der Session-ID).

## Aktueller Stand

**Phase 5 hat begonnen.** Zuletzt fertig: **S19** (Agenten-Registry und `agent.create`),
2026-09-12. Naechste Session: **S20** Erste Subagent-Besetzung, Status `ready`.

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
| S18c | Skill-System (progressive Offenlegung) | done |
| S18d | Erste eigene Skills | done |
| S18e | Modell-Routing | done |
| S18f | Eval-Suite fuer lange Laeufe | done |
| S19 | Agenten-Registry und agent.create | done |
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
- **Kein echter Modellaufruf fuer Kompaktierung/Uebergabe/Klassifikation/Eval-Suite pruefbar**:
  `ANTHROPIC_API_KEY` ist durchgehend leer (S16 ff., zuletzt S18e/S18f). Mechanik ist per
  Drehbuch/echtem Router bewiesen, echtes Modellverhalten nicht — das gilt jetzt auch fuer alle
  vier Szenarien der Eval-Suite (S18f), die genau dafuer gedacht ist.
- **Freigabe-Koernung grob** bei `cal.create`/`cal.update`/`notes.write`/`mail.draft`: eine
  `session`-Freigabe deckt jeden weiteren Aufruf desselben Tools (S15).
- **Serialisierung im Gateway ist prozesslokal**, kein verteilter Lock (S16) — heute ein
  Prozess, daher nicht dringend.
- **`<deferred_tools>`-Block waechst unbegrenzt** mit der Zahl der Assistenz-Tools (S18b);
  bei sieben heute unauffaellig, Phase 5 laesst den Katalog weiter wachsen.
- **Diverse lineare Scans/wiederholte Arbeit je Zug statt je Session**: `estimateFixedOverheadTokens`
  (S18a), `stage3StreakSince`/`taskCompletedSince` (S18b), Teilwortsuche im Langzeitgedächtnis
  (S18) — bei heutigen Groessen unmessbar, aber ohne Faltung ueber Zuege hinweg.
- **`<skills>`-Block waechst unbegrenzt** mit der Zahl der Skills (S18c), dieselbe Lage wie
  bei `<deferred_tools>` (S18b) — bei den drei echten Skills aus S18d heute unauffaellig,
  weiteres Wachstum ist absehbar, keine vergessene Grenze.
- **`skill.load` bietet keine automatische Auslagerung fuer aussergewoehnlich grosse Skills**
  (S18c) — wie bei `tool.load` wirft `callRuntimeTool` stattdessen `ToolOutputTooLargeError`.
  Fuer heutige Skillgroessen kein Thema, aber eine bewusste Grenze, keine vergessene.
- Weitere kleinere, session-lokale Befunde (Web-Postfach-Groesse, Git-Prozessstarts je Notiz,
  Injection-Scan-Groesse, Katalog-Migrationspfad bei zwei Kanaelen, `ensureGitIdentity` nur
  beim Anlegen, u. a.) stehen im Detail in progress-archiv.md bei der jeweiligen Session.
- **S18d (Erste eigene Skills) wurde zunaechst uebersprungen** (S18e lief zuerst, auf
  ausdruecklichen Auftrag) und danach direkt im Anschluss nachgeholt — siehe den Abschnitt
  "S18d" unten, chronologisch nach S18e in dieser Datei, weil so gearbeitet wurde.
- **Der Router (S18e) ist an keinem echten Aufrufer verdrahtet.** `createRunner` kennt `router`
  als Option, aber `runtime/index.ts`, `gateway/conversation.ts` und `heartbeat/` reichen weiter
  nur `model` durch. Bewusst so gelassen (siehe S18e, "Bewusst nicht gebaut") — die tatsaechliche
  Verkabelung fuer den produktiven Pfad ist eine Entscheidung ueber Kosten und Verhalten, die der
  Auftrag S18e nicht verlangt hat.
- **Kein echter Modellaufruf fuer die Klassifikation selbst pruefbar** (S18e), aus demselben
  Grund wie bei Kompaktierung und Uebergabe seit S18a: `ANTHROPIC_API_KEY` ist leer. Die Tests
  beweisen die Mechanik (Klassifikation entscheidet Modellwahl, Entscheidung steht im Protokoll,
  kein zweites Routing in derselben Session), nicht ob ein echtes guenstiges Modell die Frage
  "Routine oder Denkarbeit" in der Praxis richtig beantwortet.
- **Delegation und Anlegen sind grob freigegeben** (S19): das Policy-Subjekt ist
  `agent.delegate|-` bzw. `agent.create|-` (keine Ressource), eine `session`-Freigabe deckt also
  jede weitere Delegation bzw. jedes weitere Anlegen derselben Session — dieselbe grobe Körnung
  wie bei `cal.create`/`notes.write` seit S15.
- **Ein Arbeiter kann auf keine Freigabe warten** (S19): braucht ein Werkzeug seines Profils
  eine, endet sein Lauf als Fehlschlag (die Session wird abgebrochen, damit kein offener Zug
  liegenbleibt). Praktisch heißt das: ein Agent mit `hard_write`-Werkzeugen ist heute nur in
  einem Prozess brauchbar, der diese Aufrufe per Regel oder Dauerfreigabe abdeckt.
- **Ein Agent kann nur bekommen, was der Prozess hat** (S19): der Hintergrundkatalog des
  Heartbeats (S17) ist die Obergrenze für jeden Lauf nach Zeitplan. Ein Agent mit `mail.*` in
  einem Prozess ohne n8n läuft **nicht** halb, sondern gar nicht (`WorkerToolsUnavailableError`,
  sichtbar im Diarium) — bewusst fail closed, aber eine Falle für den Betreiber, der Registry
  und Prozesskonfiguration auseinanderlaufen lässt.
- **Keine Obergrenze für parallele Arbeiter, kein Token-Budget in Token** (S19) — Abschnitt 14
  nennt beides, umgesetzt ist bislang `max_steps` je Lauf.
- **Nur zwei Klassen, Abschnitt 11 kennt drei** (S18e): "klein und guenstig", "mittel",
  "stark" — der Router kennt nur die aeusseren beiden ("Routine"/"Denkarbeit"), wie im Auftrag
  woertlich verlangt ("grob klassifiziert"). Die mittlere Klasse ("Zusammenfassen, einfache
  Tool-Auswahl") bleibt vorerst unbenannt; `compactionModel` (S18a) faellt weiterhin auf das
  Orchestrator-Modell zurueck, wenn niemand explizit ein zweites uebergibt.

## S19 · Agenten-Registry und `agent.create` · 2026-09-12

Erste Session der Phase 5. Fünf Vorgaben, alle wörtlich: die Postgres-Tabelle `agents` nach dem
Schema in `docs/ARCHITEKTUR.md`, `agent.delegate` im Orchestrator-Worker-Muster mit isoliertem
Kontext, `agent.create` (Nutzerauftrag → Claude entwirft Profil-JSON → `user.ask` zur
Bestätigung → Insert), Risikostufen-Validierung mit Zusatzbestätigung bei hartem
Schreiben/Zerstörendem, und bei gesetztem `schedule` die Registrierung beim Heartbeat-Dienst.

**Das Schema stand nicht in der Architektur — es ist abgeleitet und jetzt nachgetragen.**
Abschnitt 5 nannte vier Entitäten (Session, Task, Step, Artifact) und sechs Tabellen "in Phase
1"; eine `agents`-Tabelle gab es dort nicht. Jede Spalte von Migration `0009` steht deshalb für
genau einen Satz, den die Architektur ohnehin festlegt: `tools` für "Werkzeug-Zugriff ist
rollenspezifisch, nie pauschal" (Abschnitt 14), `max_steps` für das "Token-Budget" ebendort in
der Einheit, die diese Runtime durchsetzen kann, `model` für "Modell pro Agent bewusst wählen"
(Abschnitt 11), `max_risk` für die Risikostufen-Tabelle (Abschnitt 10), `schedule` für
"Cron-Agenten sind der eigentliche Kostentreiber" (Abschnitt 11). Das Ergebnis steht jetzt als
fünfte Entität in Abschnitt 5, samt dem Hinweis, dass es eine Ableitung war.

**Ein siebter Kanalwert: `agent`.** Ein Arbeiter bekommt eine eigene Session — das *ist* der
isolierte Kontext, denn der Kontext einer Session ist die Faltung ihres Protokolls. Diese
Session gehört keiner Oberfläche; sie einem bestehenden Wert zuzuschlagen wäre eine
Falschaussage über ihre Herkunft, und `gateway` (S16) meint das Gegenteil (eine Session, die
*mehreren* Oberflächen gehört). Umbenennen-und-neu-anlegen wie bei `approval_scope` (0007) und
`session_channel` (0008), damit das Down den Zustand von 0008 wirklich wiederherstellt.

**Der Cron-Parser ist von `heartbeat/` nach `runtime/schedule/cron.ts` gewandert.** Ein
Zeitplan ist seit dieser Session nicht mehr nur die Einstellung des Heartbeat-Dienstes, sondern
eine Eigenschaft eines Agenten, und `agent.create` prüft ihn **beim Anlegen** — aus `tools/`
heraus, das nichts aus `heartbeat/` importieren darf (Abschnitt 3, geprüft in
`heartbeat/layering.test.ts`). Ein zweiter Parser daneben wäre eine zweite Wahrheit über
dieselbe Form. Die Prüfung beim Anlegen ist dieselbe Haltung wie bei
`heartbeatConfigFromEnv` seit S17: ein kaputter Ausdruck soll sofort auffallen und nicht später
stumm nie feuern.

**`agent.create` läuft dreimal und entwirft einmal.** Der Handler ist `execution: "runtime"`
wie `user.ask` (er hält für einen Menschen an; ein Schritt, der stundenlang auf `running`
steht, wäre eine Falschaussage über den Lauf). Seine Idempotenz kommt deshalb aus dem
Protokoll, an drei Stellen: das eigene `agent.created` zur selben `call_id`, die offene oder
entschiedene Rückfrage zur selben `ask_id` — **von dort** wird der Entwurf zurückgelesen, statt
ihn neu zu erzeugen —, und der UNIQUE-Index auf dem Namen. Dafür trägt `AskSpec` jetzt zwei
neue Felder: `kind` (die Art der Rückfrage, neu `agent_create`) und `details` (was zur
Entscheidung gehört, wenn die Frage mehr trägt als ihren Wortlaut). Der Nachweis steht im Test:
der Handler läuft dreimal, `draftCalls` bleibt bei eins — und was eingetragen wird, ist damit
nachweislich das, was der Nutzer gesehen hat, nicht eine zweite, ähnliche Antwort desselben
Modells.

**Drei Tore, drei verschiedene Fragen.** Die Policy-Engine fragt "darf dieser Lauf so etwas
überhaupt" (`agent.create` ist `hard_write`: es ändert die Datenbank, Abschnitt 10). Die erste
Rückfrage fragt "ist *dieses* Profil das, was du wolltest". Die zweite — nur bei
`hard_write`/`destructive` — fragt nach der **stehenden Erlaubnis**: eine Freigabe deckt einen
Aufruf, ein Profil deckt jeden künftigen Aufruf dieses Agenten, auch die nach Zeitplan, bei
denen niemand zusieht. Dazu kommt die Prüfung des Profils selbst (`checkAgentDraft`), deren
inhaltlich wichtigste Regel lautet: ein Werkzeug über der Obergrenze des Profils ist ein
Widerspruch und wird abgewiesen, nicht später stillschweigend abgelehnt.

**Keine rekursiven Subagenten, als Form statt als Regel.** `runtime/loop/api.ts` registriert die
`agent.*`-Tools **zuletzt** und übergibt ihnen den Katalog, wie er vorher aussah — derselbe
Zweischritt wie bei `tool.load` (S18b), nur mit anderer Absicht. Ein Profil kann daraus kein
`agent.delegate` wählen, ein Arbeiter bekommt keins: es existiert in seinem Katalog nicht.
`FORBIDDEN_AGENT_TOOLS` (`agent.*` plus `user.ask` — ein Arbeiter hat kein Gegenüber) ist nur
die zweite Sicherung für den Tag, an dem jemand die Registrierreihenfolge ändert.

**Registrierung beim Heartbeat heißt: die Zeile.** `heartbeat/agents.ts` liest bei jedem Tick
die aktiven Agenten mit Zeitplan aus der Registry. Keine Anmeldeliste im Prozess — die ginge
beim Neustart verloren, und ein Agent, den der Nutzer angelegt und bestätigt hat, liefe danach
stumm nie wieder, ohne dass irgendwo etwas fehlte, woran man es sähe. Dieselbe Haltung wie bei
der Tagesobergrenze seit S17 ("Kein Zustand im Speicher"), und zugleich der Grund, warum das
Fertig-Kriterium "sofort aktiv" ohne Neustart erfüllt ist. Die Agenten teilen sich die
**bestehende** Tagesobergrenze mit Digest und Meldung (`overDailyCap`, jetzt exportiert): eine
zweite Grenze daneben wäre eine, die man beim nächsten Hebel vergisst mitzuziehen.

**`ToolDefinition.timeoutMs`** ist neu: ein Tool darf sein eigenes Zeitfenster der
Ausführungshülle nennen. `agent.delegate` trägt einen ganzen Arbeiterlauf; ein Abbruch nach der
Router-Minute wäre kein hängender Aufruf, sondern ein abgeschnittener. Zählt nicht in den
Katalog-Fingerabdruck (interne Weiche wie `execution` und `deferred`).

### Tests

22 neue, zusammen 653 (65 Dateien, davon drei neu).

- **`runtime/agents/store.test.ts`** (10): die Profilprüfung (Namensform, leere/unbekannte
  Werkzeuge, Werkzeug über der Obergrenze, verbotene Werkzeuge, Cron beim Anlegen,
  Schrittbudget) und die Registry gegen die echte Datenbank (Zeile + genau ein `agent.created`,
  Wiederfinden über die `call_id`, Namenskollision, Redaction des Profiltexts).
- **`tools/agent/tools.test.ts`** (7, echte Datenbank, echter Router, echte Policy): der
  vollständige Weg von `agent.create` samt beider Pausen und dem Nachweis "ein Entwurf trotz
  dreier Handler-Läufe"; die Zusatzbestätigung bei `hard_write` und ihr Gegenstück (verweigert
  → nichts angelegt); ein abgelehnter Entwurf; ein unbrauchbares Profil als Fehlerhülle; und
  `agent.delegate` über die echte Schleife: eigene Session auf Kanal `agent`, der Arbeiter sieht
  das Geheimwort des Hauptagenten **nicht**, seine Werkzeugliste ist genau das eine Werkzeug
  seines Profils, sein Ergebnis steht in der Historie des Auftraggebers, seine Zwischenschritte
  nur in seinem eigenen Protokoll.
- **`heartbeat/agents.test.ts`** (5, gestellte Uhr): ein fälliger Agent läuft genau einmal je
  Anlass (drei Ticks, ein Lauf; ein Dienst-Neustart ändert nichts; 10:20 ist ein neuer Anlass),
  Stille bleibt stumm (`heartbeat.silent`, nichts zugestellt), ein pausierter Agent läuft nicht,
  ein Agent mit Werkzeugen außerhalb des Hintergrundkatalogs wird zum sichtbaren Fehlschlag —
  und das **Fertig-Kriterium**: ein per Satz angelegter Agent ("erstelle einen Agenten, der alle
  20 Minuten meine Mails checkt") ist ohne jeden Neustart beim nächsten Tick fällig und meldet
  sich über den Kanal.

### Gegenproben

Keine gesonderten — jeder Mechanismus ist mit seinem Gegenstück geprüft: bestätigt/abgelehnt,
Zusatzbestätigung erteilt/verweigert, Agent aktiv/pausiert, Meldung/Stille, Werkzeug im
Profil/außerhalb, erster Anlass/derselbe Anlass noch einmal.

### Bewusst nicht gebaut

- **Kein `agent.update`/`agent.retire`.** Was mit einer laufenden Delegation und einem gerade
  fälligen Zeitplan geschieht, ist eine eigene Entscheidung; `status` steht schon in der
  Tabelle, damit ein späteres Pausieren nur eine Zeile schreiben muss.
- **Keine Obergrenze für parallele Arbeiter und kein Token-Budget in Token.** Abschnitt 14
  nennt beides; S19 setzt davon `max_steps` um (Werkzeugaufrufe je Lauf). Delegationen laufen
  heute nacheinander in einem Zug.
- **Keine Kostenrechnung je Agent.** Das ist S21.
- **Keine feinere Freigabe-Körnung.** Das Subjekt einer Delegation ist `agent.delegate|-`, eine
  `session`-Freigabe deckt also jede weitere Delegation derselben Session — dieselbe grobe
  Körnung wie bei `cal.create`/`notes.write` seit S15.

### Offene Befunde (Details zu S19)

Siehe die neuen Einträge oben unter "Offene Befunde (gesamte Historie)".

- `pnpm typecheck && pnpm lint && pnpm test` grün, 653 Tests.
- `tasks.json`: S19 auf `done`, S20 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S20 Erste Subagent-Besetzung.

## S18e · Modell-Routing · 2026-09-11

Fünfte Session der Phase 4, zunächst vor S18d gelaufen, auf ausdrücklichen Auftrag ("Aufgabe
dieser Session: Modell-Routing") — S18d wurde direkt im Anschluss nachgeholt (siehe unten). Vier
Vorgaben, alle wörtlich: ein Routing-Schritt vor dem eigentlichen Lauf, der grob zwischen Routine (günstig)
und Denkarbeit (stark) unterscheidet; die Modellzuteilung als einfache Konfiguration statt einer
Registry-Tabelle — die baut erst S19 —, im Code klar als Übergangslösung markiert; der Router
selbst läuft auf dem günstigsten sinnvollen Modell; die Entscheidung samt Begründung landet im
Ereignisprotokoll.

**Neu: `runtime/model/router.ts`.** Der Kern ist eine einzige Funktion, `routeTask`: sie schickt
die Eingabe an `deps.routineModel` mit einem knappen Klassifikationsauftrag ("ROUTINE" oder
"THINKING", je ein Satz Begründung, `maxTokens: 128`) und wählt danach eines der beiden
übergebenen Modelle. Der Klassifikator ist **kein dritter Modell-Client**: er läuft über
`routineModel` selbst — dieselbe Instanz, die auch für Routineaufgaben lief —, weil
Klassifikation nach Abschnitt 11 selbst in die günstigste Klasse fällt und ein eigener,
dritter Client dem eigenen Zweck widerspräche. Eine uneindeutige Antwort fällt sicher auf
`thinking` zurück (eine unterversorgte Denkaufgabe kostet mehr als eine überversorgte
Routineaufgabe), ein gescheiterter Klassifikationsaufruf wird **nicht** verschluckt (AGENTS.md:
"Fehler nie verstecken") — es gibt keine sinnvolle Rückfalloption, welches Modell einen ganzen
Lauf trägt.

**Konfiguration statt Registry, mit Verfallsdatum im Kommentar.** `resolveModelRouteConfig` liest
zwei Umgebungsvariablen (`MODEL_ROUTINE`, `MODEL_THINKING`) mit Startwerten
(`claude-haiku-4-5-20251001` bzw. dasselbe `DEFAULT_MODEL` wie der Orchestrator) — zwei globale
Werte für die ganze Runtime, keine Tabelle mit einem Eintrag pro Agent oder Rolle. Der
Moduldoc-Kommentar sagt das ausdrücklich: S19 (Agenten-Registry, `agent.create`) ersetzt diese
Datei durch ein Nachschlagen in der Registry, ohne dass der Aufrufer (`runtime/loop/api.ts`)
sich ändern muss — er reicht schon heute nur zwei `ModelClient`s herein und bekommt eine
`RouteDecision` zurück, nichts davon ist an "zwei globale Werte" gebunden.

**Wo der Schritt sitzt: vor der Session, nicht vor dem Zug.** Der naheliegende erste Ort wäre
`runTurn` gewesen, dort, wo ohnehin schon Kontextstufe 4 und das Langzeitgedächtnis vor einem
neuen Zug greifen (`runtime/loop/loop.ts`). Das ist aber falsch: `deps.model` gilt nicht nur für
einen Zug, sondern für **jeden** Schritt der ganzen Session (Abschnitt 7: "Modell nicht mitten in
der Session wechseln, stattdessen Subagent starten"), und eine lange Unterhaltung (Gateway, S16)
hat viele Züge, aber nur eine Session. "Vor dem eigentlichen Lauf" heißt deshalb: vor
`createRunner`s Session-Anlage, nicht vor jedem `runTurn`. `RunnerConfig` bekommt ein optionales
`router: ModelRouterDeps & { classifyInput: string }`, das `model` überschreibt; `model` selbst
wurde dafür optional (Laufzeitprüfung statt Typtrick: `RunnerModelConfigError`, wenn beides
fehlt — dieselbe Haltung wie `MissingApiKeyError`).

**Die Reihenfolge um `startRuntime` herum ist die eigentliche Feinheit.** `SessionDefaults.
modelProfile` will beim Anlegen einer *neuen* Session schon das Modell kennen, aber ob eine
Session neu ist, weiß erst `startRuntime` selbst (`RuntimeHandle.created`). Aufgelöst über
dieselbe Erkenntnis wie bei `context_compactions`/`cache_hit_rate` (Abschnitt 12): `modelProfile`
ist ohnehin nur dokumentierend, keine zweite Wahrheit — bei geroutetem Lauf bleibt es auf der
Startvorgabe, und die maßgebliche Aussage steht im neuen Ereignis `model.routed`, geschrieben
**nach** `startRuntime`, sobald `RuntimeHandle.created` bekannt ist. Bei einer **neuen** Session
läuft `routeTask` frisch; bei einer **wiederaufgenommenen** wird die frühere Entscheidung aus
`model.routed` zurückgelesen (Modellname gegen `routineModel.model`/`thinkingModel.model`
abgeglichen) und **nicht** neu klassifiziert — ein zweiter Routing-Lauf mitten in der Session
widerspräche genau der Abschnitt-7-Regel, die der ganze Mechanismus einhalten soll. Ohne
frühere Entscheidung (Session älter als S18e, oder ohne Router angelegt) bleibt `config.model`
der Ausweg, sonst der sichere Fallback auf `thinkingModel`.

**`model.routed` ist ein neues Ereignis, kein neuer Namensraum.** `model.*` trägt seit
Abschnitt 4.4 schon `model.requested`/`model.responded` für den eigentlichen Aufruf;
`model.routed` beantwortet dieselbe Familie von Fragen ("was hat das Modell hier getan"), nur vor
dem ersten `model.requested` eines Laufs und mit einer anderen Frage ("welches Modell wurde für
den ganzen Lauf gewählt, und warum"). Trägt `task_class`, `reason`, `chosen_model`,
`classifier_model`. Kein Feld in `session.created` oder `runtime.started`: dieselbe Begründung
wie bei `skill.invoked` und `memory.recalled` — eine Begründung, die man später sucht, gehört in
ein eigenes, leicht filterbares Ereignis, nicht in ein Feld eines sessionfremden.

### Tests

10 neue, zusammen 626 (60 Dateien).

- **`runtime/model/router.test.ts`** (7, reine Einheitentests, kein Router/keine Datenbank —
  wie `context/compaction.test.ts` für Stufe 3): ROUTINE wählt das günstige Modell, THINKING das
  starke, die Klasse wird auch ohne Doppelpunkt-Trenner erkannt, eine uneindeutige Antwort fällt
  sicher auf `thinking` zurück, ein Fehler des Klassifikators wird weitergereicht statt
  verschluckt, `resolveModelRouteConfig` liefert die Startwerte ohne Umgebungsvariablen und
  gewichtet Override vor Umgebungsvariable vor Startwert.
- **`runtime/loop/loop.test.ts`**, neue Gruppe "Loop · Modell-Routing (S18e)" (3, echte
  Datenbank, echter Router/Policy, `classifyingModel`-Fake statt Anbieter): eine Routineaufgabe
  ("Wie ist der Serverstatus?") läuft nachweisbar mit dem günstigen Modell — `model.routed`
  trägt `task_class: "routine"`, steht vor `turn.started`, und `model.requested` trägt den
  Namen des günstigen Modells; eine Planungsaufgabe ("Migrationsplan …") läuft nachweisbar mit
  dem starken Modell, symmetrisch geprüft; ein zweiter Zug in derselben Session routet **nicht**
  erneut, selbst mit ganz anderem Text — genau ein `model.routed` im ganzen Protokoll, jeder
  `model.requested` trägt weiter dasselbe Modell. Das ist der Ende-zu-Ende-Nachweis des
  Fertig-Kriteriums: "Routine- und Denkaufgabe zeigen unterschiedliche, passende Modellwahl."

### Gegenproben

Keine gesonderten Gegenproben in dieser Session — die drei Mechanismen (Klassifikation wählt das
richtige Modell, die Entscheidung steht im Protokoll, kein zweites Routing in derselben Session)
sind direkt durch positive **und** negative Fälle abgedeckt: der dritte Loop-Test prüft
ausdrücklich, dass ein zweiter, andersartiger Zug **nicht** zu einem zweiten `model.routed`
führt, und die Router-Einheitentests decken sowohl die eindeutige als auch die uneindeutige
Antwort sowie den Fehlerfall ab.

### Bewusst nicht gebaut

- **Keine Verdrahtung in einen echten Aufrufer.** `runtime/index.ts` kennt `input` zwar schon vor
  der Modellwahl (dieselbe Stelle, an der heute `createAnthropicClient()` bedingt aufgerufen
  wird) und wäre der nächstliegende Ort — aber jeder Aufruf über den Router kostet einen
  zusätzlichen Modellaufruf (die Klassifikation) gegenüber dem heutigen Verhalten, und das ist
  eine Verhaltensänderung an einem produktiven Pfad, die der Auftrag nicht verlangt hat. `gateway/`
  (eine Unterhaltung ohne klares Laufende, Abschnitt 7 gilt über ihre ganze Lebensdauer) und
  `heartbeat/` (fester Hintergrund-Digest, kein Text, den man vorab klassifizieren müsste) passen
  ohnehin schlechter. Der Mechanismus steht bereit; ihn an einen echten Aufrufer anzuschließen
  ist eine Entscheidung, die der nächste Auftrag treffen sollte, nicht diese Session von sich aus.
- **Keine dritte Klasse ("mittel").** Abschnitt 11 kennt drei Stufen, der Auftrag verlangt
  ausdrücklich nur die grobe Zweiteilung ("Routine (günstiges Modell) vs. Denkarbeit (starkes
  Modell)"). `compactionModel` (S18a) bleibt unverändert bei "fällt auf das Orchestrator-Modell
  zurück, wenn nicht gesetzt".
- **Kein Umschalten des Modells mitten in einer laufenden Session**, auch nicht bei einem
  thematischen Sprung mitten in einer langen Unterhaltung — das wäre genau das, was Abschnitt 7
  verbietet ("stattdessen Subagent starten"), und dieser Auftrag baut keinen Subagenten (S19/S20).
- **Keine Kostenrechnung.** Die Begründung im Protokoll sagt, *warum* geroutet wurde, nicht was es
  gekostet hat — das ist S21 ("Kosten-Tracking und Modell-Routing").

### Offene Befunde (Details zu S18e)

Siehe die neuen Einträge oben unter "Offene Befunde (gesamte Historie)": der Router an keinem
echten Aufrufer verdrahtet, kein echter Modellaufruf für die Klassifikation prüfbar, nur zwei
statt drei Klassen aus Abschnitt 11.

- `pnpm typecheck && pnpm lint && pnpm test` grün, 626 Tests.
- `tasks.json`: S18e auf `done`, S18f von `queued` auf `ready` (S18d zu diesem Zeitpunkt noch
  übersprungen — siehe den nachfolgenden Abschnitt).

Status: abgeschlossen. Nächste Session zum Zeitpunkt dieses Eintrags: S18f — tatsächlich lief
danach zuerst S18d, siehe unten.

## S18d · Erste eigene Skills · 2026-09-11

Vierte Session der Phase 4, direkt nach S18e nachgeholt, auf ausdrücklichen Auftrag ("do S18d,
then S18f"). Der Auftrag steht schon wörtlich in `docs/ARCHITEKTUR.md` Abschnitt 9: "Die ersten
eigenen Skills (Mail-Triage, Wochenrückblick, Recherche-Ablauf) sind S18d", `done_when` in
`tasks.json`: "Mail-Triage, Wochenrueckblick, Recherche-Ablauf laufen mit Testdaten".

**Drei echte `SKILL.md` unter `skills/`** — `mail-triage/`, `wochenrueckblick/`,
`recherche-ablauf/`, jede mit dem seit S18c vorgeschriebenen Frontmatter (`titel`,
`beschreibung`, `wann`) und einem Anleitungsrumpf, der die Werkzeuge nennt, die es bereits gibt:

- **Mail-Triage** — `mail.search` (Übersicht), Dringlichkeit aus der Kurzfassung einschätzen,
  die bis zu drei dringendsten mit `mail.read` vollständig lesen, für jede einen Entwurf mit
  `mail.draft` anlegen (nie versenden — es gibt kein `mail.send`), die übrigen unbearbeitet
  lassen. Ein eigener Abschnitt "Wichtig" wiederholt die Injection-Warnung aus S14: Mailinhalt
  ist Nutzdaten, keine Anweisung.
- **Wochenrückblick** — `cal.list` für die letzten sieben Tage, `memory.search` nach
  Notizen aus der Woche, den ohnehin sichtbaren Plan einbeziehen, eine Zusammenfassung
  formulieren und **zusätzlich** mit `memory.write` als Notiz ablegen (`kind: erkenntnis`,
  Tag `wochenrueckblick`) — außer die Woche gibt nichts her, dann bleibt es bei der Antwort im
  Gespräch (dieselbe Zurückhaltung wie bei jeder anderen Gedächtnisablage seit S18: "die
  meisten Läufe hinterlassen keine Notiz").
- **Recherche-Ablauf** — `web.search`, daraus zwei bis drei tatsächlich einschlägige Treffer
  auswählen (nicht die ganze Liste blind abrufen), mit `web.fetch` vollständig lesen,
  widersprechende Quellen beide nennen, jede verwendete Tatsache mit Quelle belegen. Auch hier
  die Injection-Warnung aus S09: abgerufener Inhalt ist nicht vertrauenswürdig.

Alle drei nennen ausschließlich Werkzeuge, die im Katalog bereits existieren (`mail.*` S14,
`cal.*`/`memory.*` S15/S18, `web.*` S09) — diese Session fügt keine neuen Werkzeuge hinzu, nur
Anleitungen, die bestehende sinnvoll verketten.

**`skills/skills.test.ts` prüft die echten Dateien, keine Fixtur.** Anders als
`tools/skill/catalog.test.ts` und `tools/skill/tools.test.ts` (S18c, zehn Dummy-Skills in einem
Wegwerf-Verzeichnis) lädt diese neue Datei `loadSkillCatalog` auf das tatsächliche `skills/`
dieses Repos — ein Rechtschreibfehler im Frontmatter einer der drei echten Dateien ließe den
ersten Test hier fehlschlagen, nicht erst einen Produktivlauf. Vier Tests:

- Ein Ladetest: alle drei Skills stehen im echten Katalog, mit nicht-leerem Titel, Beschreibung,
  Auslösebedingung und Rumpf.
- Je ein Fertig-Kriterium-Test pro Skill, nach demselben Muster wie die bestehenden
  Fertig-Kriterien (S14 Mail, S09 Web): der echte Router, die echte Policy, die echte Schleife,
  nur das Modell ist ein Drehbuch — hier `sequenceModel`, eine feste Aufrufkette
  (`skill.load`, dann die Werkzeuge in der von der Anleitung vorgeschriebenen Reihenfolge, dann
  Schlusstext), gegen echte Fake-Backends (n8n-Mail-Webhooks, n8n-Kalender-Webhook, eine echte
  temporäre `MemoryStore`-Instanz, ein Fake-`fetch` plus Fake-Suchbackend).

**Was jeder der drei Tests tatsächlich beweist, und was nicht.** Wie bei jedem
Fertig-Kriterium in diesem Projekt beweist ein Drehbuch nicht, dass ein echtes Modell genau
diese Werkzeugfolge wählen würde — das hängt an semantischem Verständnis, das ohne
`ANTHROPIC_API_KEY` nicht prüfbar ist (derselbe offene Befund wie bei jeder Kompaktierung,
Übergabe und Klassifikation seit S18a). Bewiesen wird die andere Hälfte: dass der in der
Anleitung beschriebene Ablauf, mit den echten Werkzeugen und echten Testdaten ausgeführt,
tatsächlich zum beschriebenen Ergebnis führt — die Mail-Triage liest und beantwortet nur die
zwei als dringend markierten von fünf ungelesenen Mails und versendet nichts; der
Wochenrückblick liest zwei Kalendertermine und eine ältere Notiz und legt danach nachweislich
eine zweite Notiz ab (`memoryStore.count()` steigt von 1 auf 2); die Recherche liest genau die
zwei gewählten Treffer und die Antwort nennt beide Quellen.

### Tests

4 neue, zusammen 630 (61 Dateien) — `skills/skills.test.ts`, wie oben beschrieben.

### Gegenproben

Keine gesonderten Gegenproben — die drei Fertig-Kriterien sind bereits das direkte,
End-zu-Ende-Gegenstück zu den entsprechenden Tests aus S09/S14/S18 (dieselbe Art Nachweis, nur
über `skill.load` statt direkt verdrahteter Werkzeugfolgen), und der Ladetest prüft positiv
gegen den echten Bestand.

### Bewusst nicht gebaut

- **Kein `notes.write` (Obsidian) im Wochenrückblick.** `memory.write` (soft_write, keine
  Freigabe) hält den Testaufbau einfach und passt inhaltlich: eine Wochenzusammenfassung ist
  eine Erkenntnis des Assistenten über den Verlauf, kein Eintrag im Vault des Nutzers. Wer sie
  zusätzlich im Obsidian-Vault haben will, kann das in einer künftigen Fassung der Anleitung
  ergänzen — `notes.write` ist `hard_write` und bräuchte dafür eine Freigabe im Ablauf.
- **Keine vierte oder fünfte Anleitung.** Der Auftrag nennt genau drei Skills; weitere sind
  denkbar, aber nicht Teil des `done_when`.
- **Keine Änderung am Skill-Mechanismus selbst.** S18d ist reine Inhaltsarbeit auf dem seit
  S18c bestehenden Fundament — `tools/skill/catalog.ts`, `tools/skill/tools.ts`,
  `context/request.ts` bleiben unverändert.

### Offene Befunde (Details zu S18d)

- **Kein echter Modellaufruf für die Werkzeugwahl selbst prüfbar** (dieselbe Grenze wie überall
  seit S18a) — siehe oben, "was jeder Test beweist, und was nicht".
- Der `<skills>`-Block trägt jetzt drei echte Einträge statt null — siehe den aktualisierten
  Eintrag oben unter "Offene Befunde (gesamte Historie)" zum unbegrenzten Wachstum dieses
  Blocks.

- `pnpm typecheck && pnpm lint && pnpm test` grün, 630 Tests.
- `tasks.json`: S18d auf `done`.

Status: abgeschlossen. Nächste Session: S18f Eval-Suite für lange Läufe.

## S18f · Eval-Suite für lange Läufe · 2026-09-11

Sechste und letzte Session der Phase 4, direkt nach S18d, auf denselben Auftrag ("do S18d, then
S18f, then everything should be finished"). `done_when` aus `tasks.json`: "Vier Eval-Szenarien
laufen automatisiert, strukturierter Report" — und `docs/ARCHITEKTUR.md` nennt den Ordner dafür
schon seit Phase 0 (Abschnitt 3: "`evals/` (Harness-Evals)") und die Begründung in Anti-Muster 9:
"Das Harness selbst nicht evaluieren, Tool-Tests reichen nicht".

**Ein Eval ist kein Unit-Test, sondern ein Szenario mit eigenem Bericht.** `tools/*/tools.test.ts`
und `runtime/loop/loop.test.ts` prüfen längst jeden einzelnen Mechanismus aus Phase 4 (S18a–S18c)
mit `expect()`. Was fehlte: eine Stelle, die dieselben vier Mechanismen **als System** und **auf
Kommando** prüft, mit einem Ergebnis, das man weiterreichen kann (ein CI-Schritt, ein Betreiber,
ein späteres Dashboard), nicht nur eine grüne oder rote Zeile im Testrunner. Deshalb ein eigenes
Vokabular (`evals/types.ts`): `EvalCheck` (eine Aussage, bestanden oder nicht, mit Begründung),
`EvalScenario` (eigenständig lauffähig — öffnet und schließt seine eigenen Ressourcen),
`EvalResult`/`EvalReport` (das Ergebnis eines Szenarios bzw. der ganzen Suite). Dieselbe Haltung
wie die einheitliche Tool-Rückgabehülle (`status`/`summary`/`structured`, AGENTS.md) auf eine
Ebene darüber angewendet.

**Vier Szenarien, eines je Phase-4-Mechanismus** (`evals/scenarios/`), jedes eine eigenständige
Erweiterung des jeweiligen Unit-Tests — nicht desselbe noch einmal, sondern länger geführt, um
genau die Eigenschaft zu zeigen, die ein kurzer Unit-Test nicht zeigen kann: **hält der
Mechanismus über mehrere weitere Schritte, nicht nur den einen Übergang?**

- **`kompaktierung-langer-lauf`** (S18a) — 110 Leseläufe, kein gesendeter Prompt überschreitet
  das konfigurierte Fenster, Stufe 2 **und** 3 greifen, Cache-Trefferquote ist ablesbar.
  Praktisch derselbe Aufbau wie der 110-Schritte-Test aus `runtime/loop/loop.test.ts`.
- **`frisches-fenster-und-gedaechtnis`** (S18b/S18) — drei Züge: eine Notiz entsteht trotz
  `completeOnDone: false`, eine Ruhepause löst genau ein frisches Fenster aus, ein dritter Zug
  zu einem alten Thema findet die Notiz über `memory.recalled` wieder. Derselbe
  "Gedächtnis-Rundlauf" wie in S18b, hier als eigenständiges Szenario.
- **`verzoegertes-tool-laden-langer-lauf`** (S18b) — fünf Assistenz-Tools (Testdouble im
  Namensraum `dev.*`, AGENTS.md: "Prüf-Tools des Harness, gehören in keinen produktiven
  Katalog") bleiben außerhalb der Werkzeugliste, bis `tool.load` eines nachlädt; **anders als**
  der Drei-Schritte-Unit-Test bleibt das geladene Tool hier über **vier weitere** Anfragen mit
  vollem Schema aufrufbar, nicht nur die unmittelbar nächste — genau die Frage "hält es über
  einen längeren Lauf" wird hier zum ersten Mal geprüft.
- **`skills-langer-lauf`** (S18c) — acht Dummy-Skills bleiben in der Kurzliste (< 5000 Zeichen
  im Systemblock), bis `skill.load` einen vollständig nachlädt; derselbe Zusatz wie beim
  vorigen Szenario: der volle Rumpf bleibt über zwei weitere Züge in der Historie sichtbar.

**Warum keine der drei Testdateien importiert wurde.** `runtime/loop/scripted.ts` ist die
Ausnahme (produktiver Quellbaum, kein Testmodul) und wird auch hier nicht wiederverwendet, weil
es an Ergebnisblöcken in der **gesendeten** Historie zählt — bei Kompaktierung genau der
Bauteil, der irreführt (siehe die Begründung bei `manyReadsModel` in `runtime/loop/loop.test.ts`,
S18a): eine Kompaktierung entfernt `tool_result`-Blöcke aus der gesendeten Historie, und ein
Drehbuch, das daraus seinen nächsten Schritt herleitet, verwechselte "vom Modell noch nicht
gesehen" mit "kompaktiert" und liefe nie fertig. `evals/harness.ts` trägt deshalb eigene, kleine
Kopien der Modell-Doubles aus `loop.test.ts` (`manyReadsModel`, `fixedSummaryModel`,
`memoryRoundTripModel`, `recording`) — eine Testdatei ist kein Modul, von dem Produktions- oder
Eval-Code abhängen sollte, dieselbe Trennung, aus der `scripted.ts` überhaupt als eigene,
produktive Datei existiert und nicht Teil einer `.test.ts` ist.

**Jedes Szenario ist vollständig eigenständig** — eigener `Pool`, eigene temporäre Verzeichnisse,
eigene Aufräumarbeit in seinem eigenen `finally`. Kein gemeinsamer Kontext, den `runEvals`
durchreichen müsste: ein Szenario, das seinen Pool nicht schlösse, wäre ein Leck, das erst beim
nächsten Szenario oder gar nicht auffiele, wenn die Verantwortung dafür woanders läge.
`runEvals` (`evals/index.ts`) fasst jeden Szenario-Lauf einzeln in ein `try/catch` — ein
werfendes Szenario wird zu einem Fehlschlag im Bericht (samt Wortlaut, AGENTS.md: "Fehler nie
verstecken"), reißt aber die übrigen drei nicht mit ab.

**Zwei Einstiege auf demselben Kern, aus demselben Grund wie bei jedem CLI-Werkzeug seit S12.**
`evals/run.ts` (`pnpm evals`) ist der Terminal-Einstieg: druckt eine menschenlesbare Zeile je
Szenario und Check, dazu den vollständigen `EvalReport` als JSON auf einer eigenen Zeile — der
"strukturierte Report" aus dem Auftrag, wörtlich, maschinenlesbar für ein späteres Dashboard
oder einen CI-Schritt. `evals/run.test.ts` ruft denselben Kern (`runEvals` aus `evals/index.ts`)
direkt auf, ohne Subprozess — damit die Suite Teil von `pnpm test` bleibt und nicht unbemerkt
verrottet: AGENTS.md verlangt einen grünen `pnpm test` vor jedem Commit, und ein Eval, der nur
von Hand liefe, würde das nicht erzwingen.

### Tests

1 neuer Testfall, der intern alle vier Szenarien ausführt — zusammen 631 Testfälle (62 Dateien,
davon eine neu: `evals/run.test.ts`). Bewusst **ein** `it()` über die ganze Suite statt vier
einzelner: die Szenarien sind voneinander unabhängig, aber der Bericht ist die Aussage dieser
Session, und den prüft man an einem Bericht, nicht an vier verstreuten Erwartungen. Jeder
Check, der nicht besteht, steht mit seinem Namen im Fehlertext (nicht nur "passed: false").

### Gegenproben

Keine gesonderten Gegenproben. Beim Bauen selbst zeigten sich zwei echte Fehlschläge, die die
Suite korrekt gemeldet hat, bevor sie behoben wurden — der eigentliche Nachweis, dass ein
Check, der nicht besteht, auch sichtbar wird:

- Das erste `kompaktierung-langer-lauf` schlug fehl, weil es zunächst `createScriptedModel`
  (`runtime/loop/scripted.ts`) verwendete — genau der oben beschriebene Fehler ("vom Modell
  noch nicht gesehen" mit "kompaktiert" verwechselt). Der Bericht zeigte "Schrittobergrenze
  erreicht: 115 von 115" statt eines sauberen Abschlusses.
- `skills-langer-lauf` schlug mit "Kein Werkzeugaufruf ist fehlgeschlagen: false" fehl, weil das
  Drehbuch `task.update` mit dem Feld `id` statt `task_id` aufrief (`tools/task/tools.ts`
  verlangt `task_id`). Ohne den strukturierten Check wäre das ein stiller `tool.failed`
  gewesen, den man erst im Protokoll hätte suchen müssen.

### Bewusst nicht gebaut

- **Kein fünftes oder sechstes Szenario.** Der Auftrag nennt "vier Eval-Szenarien" wörtlich;
  weitere Phase-4-Mechanismen (z. B. Modell-Routing aus S18e) sind denkbare Kandidaten für eine
  spätere Erweiterung, aber nicht Teil dieses `done_when`.
- **Kein persistenter Report auf der Platte.** `pnpm evals` druckt den `EvalReport` als JSON auf
  stdout; nichts schreibt automatisch eine Datei ins Repo. Artefakte sind unveränderlich
  (AGENTS.md) — ein Report, der bei jedem Lauf denselben Dateinamen beanspruchte, verletzte das,
  und ein Report mit Zeitstempel im Namen wäre eine Ablage, die niemand angefordert hat. Wer den
  Report archivieren will, leitet die Ausgabe um (`pnpm evals > bericht.json`) oder einen
  späteren CI-Schritt lädt ihn als Artefakt hoch — beides außerhalb dieser Session.
- **Keine Integration in `pnpm test` als eigene Kennzahl-Schwelle** (z. B. "Cache-Trefferquote
  darf X nicht unterschreiten"). Die Szenarien prüfen heute, *dass* die Mechanismen greifen,
  nicht *wie gut* — eine Qualitätsschwelle wäre eine weitere Entscheidung, keine, die aus "vier
  Szenarien, automatisiert, strukturierter Report" folgt.

### Offene Befunde (Details zu S18f)

- **Kein echter Modellaufruf für keines der vier Szenarien** — dieselbe Grenze wie überall seit
  S18a: `ANTHROPIC_API_KEY` ist leer, jedes Szenario läuft mit einem Modell-Double. Die Eval-
  Suite beweist damit, was ein Unit-Test schon beweist (die Mechanik hält), nicht, was nur ein
  Eval eigentlich leisten sollte: eine Aussage über echtes Modellverhalten über einen langen
  Lauf. Das ist der wichtigste offene Punkt dieser Session und wartet auf einen Anbieterschlüssel.
- **`evals/harness.ts` dupliziert kleine Modell-Doubles aus `runtime/loop/loop.test.ts`**
  bewusst (siehe oben, "warum keine Testdatei importiert wurde) — zwei Stellen, die dieselbe
  Fiktion pflegen müssen, falls sich `ModelResponse` je ändert. Vertretbar, weil beide klein und
  stabil sind (Abschnitt 4.4-ähnliche Typen ändern sich nicht leichtfertig), aber kein
  automatischer Schutz gegen Auseinanderlaufen.

- `pnpm typecheck && pnpm lint && pnpm test` grün, 631 Tests.
- `tasks.json`: S18f auf `done`, S19 von `queued` auf `ready` — **Phase 4 ist damit
  abgeschlossen.**

Status: abgeschlossen. Nächste Session: S19 Agenten-Registry und `agent.create` (Beginn Phase 5).

## S18c · Skill-System (progressive Offenlegung) · 2026-09-11

Dritte Session der Phase 4. Der Auftrag verlangt vier Dinge, alle wörtlich: `skills/<name>/
SKILL.md` mit Frontmatter (Titel, Beschreibung, wann anwenden), nur die Kurzliste aller Skills
im Prompt, die volle `SKILL.md` erst bei tatsächlicher Nutzung nachgeladen, Skill-Nutzung als
eigener Ereignistyp, und fremde Skills vor Aktivierung gelesen statt blind ausgeführt.

**Dieselbe Mechanik wie das verzögerte Tool-Laden (S18b), auf ein anderes Gebiet angewendet.**
`ToolDefinition.deferred` trennt schon Kern-Primitive von Assistenz-Tools; ein Skill ist aber
kein Tool (kein Handler, kein Eingabeschema) und passt nicht in dieses Feld. Also ein
paralleler, eigener Mechanismus mit demselben Prinzip: `tools/skill/catalog.ts` scannt
`skills/` einmal beim Sessionstart (`loadSkillCatalog`, dieselbe Bauart wie `loadConventions()`
für `AGENTS.md`) und hält Titel, Beschreibung, Auslösebedingung **und** den vollen Rumpf jedes
Skills im Speicher. `context/request.ts` legt daraus einen `<skills>`-Block neben die
Konventionen — eine Zeile je Skill, nach demselben Muster wie `<deferred_tools>` —, der leer
bleibt, wenn kein Skill konfiguriert ist. `skill.load` (`tools/skill/tools.ts`, neuer
Namensraum `skill`) ist der Weg zur vollen Anleitung: ein Aufruf mit Namen liefert Titel,
Beschreibung, Auslösebedingung und Rumpf als Ergebnis, damit ab diesem Zug im Kontext.

**Ein Unterschied zu `tool.load`, mit Absicht.** Die Kurzliste **schrumpft nicht**, wenn ein
Skill geladen wurde — anders als ein geladenes Tool-Schema (das die native Werkzeugliste
ersetzt) gibt es für einen benutzten Skill keine Zweitrepräsentation, die den Kurzeintrag
überflüssig machte; er kann in einem späteren Zug erneut gebraucht werden. Ein zweiter
Unterschied, technisch: `skill.load` braucht **nicht** den Zweischritt-Einfrieren, den
`tool.load` beim Registrieren braucht (`runtime/loop/api.ts`, `prelim`/`full`) — es schlägt in
einer eigenen Struktur (`SkillCatalog`) nach, nicht im `ToolCatalog`, den es selbst mitbildet,
also kein Henne-Ei-Problem.

**Skill-Nutzung als eigener Ereignistyp.** `skill.load` schreibt wie jedes Tool ein generisches
`tool.completed` (der Router tut das unabhängig vom Handler), aber der Handler schreibt
zusätzlich `skill.invoked` mit den geladenen Namen — dieselbe Bauart wie `memory.conflicted`
neben `tool.completed` von `memory.write` (S18): ein Handler, der neben seinem Ergebnis noch
eine domänenspezifische Aussage ins Protokoll trägt, die ein generisches Ereignis nur als
schwer filterbares Feld hätte. `skill` ist damit sowohl ein neuer Tool-Namensraum
(`tools/types.ts`) als auch ein neuer Ereignis-Namensraum (`runtime/events/types.ts`, 17. statt
16. Namensraum — `runtime/events/log.test.ts` hatte die Zahl fest verdrahtet und wurde
angepasst).

**"Fremde Skills werden vor Aktivierung gelesen, nicht blind ausgeführt" ist eine Eigenschaft
der Bauart, keine Verabredung.** Es gibt in diesem System keinen zweiten Weg, auf dem eine
Skill-Anleitung wirksam werden könnte: der `<skills>`-Block trägt nie mehr als die
Kurzfassung, es gibt kein `skill.run`, das eine Anleitung ausführte, ohne sie vorher in den
Kontext zu legen. Jeder Weg, auf dem ein Skill etwas bewirkt, führt zwingend zuerst durch
`skill.load` (oder durch `fs.read` auf dieselbe Datei — mit demselben Ergebnis: voller Text im
Kontext, bevor irgendetwas daraus befolgt wird). Diese Session baut **keine** Installation
neuer Skills aus einer externen Quelle — das meint der Wortlaut in Abschnitt 4.7 ("vor der
Installation gelesen") eigentlich, aber ein Installationsmechanismus ist nicht Teil des
Auftrags von S18c und auch von keinem Test verlangt; die erste eigene Nutzung echter Skills
ist S18d.

**Wiederverwendeter Frontmatter-Parser, keine zweite Wahrheit.** `tools/skill/catalog.ts`
importiert `parseNote`/`requireScalar` aus `tools/memory/frontmatter.ts` statt einen zweiten,
strukturell identischen Parser zu schreiben — der dortige ist bereits generisch (zwei Formen,
ohne Kopplung an Notizen) und genau das, was eine `SKILL.md` auch braucht. Dieselbe Haltung wie
bei `largestBalancedPrefix`/`renderSpan`, die S18b aus `context/compaction.ts` exportiert hat,
statt sie in `context/section.ts` zu verdoppeln.

**Wiring.** `runtime/loop/api.ts`: `CatalogConfig.skills?: { root?: string }` (opt-in wie
`memory`/`obsidian` — ohne das Feld bleibt der Katalog-Fingerabdruck unverändert),
`BuiltCatalog.skills`, `"skill.load"` zusätzlich in `BACKGROUND_TOOLSET` (dieselbe Begründung
wie bei `tool.load`: ein Digest, der später einer eigenen Anleitung folgen soll, S18d, braucht
denselben Ausweg aus dem `<skills>`-Block). `runtime/loop/loop.ts`: `LoopDeps.skills`,
durchgereicht an `buildModelRequest`. `runtime/index.ts` und `gateway/index.ts` schalten
Skills **immer** ein (`skills: {}`), aus derselben Begründung wie beim Langzeitgedächtnis:
kein Anschluss nach draußen wie n8n oder der Obsidian-Vault, sondern Teil des Systems.
`heartbeat/index.ts` bleibt unangetastet — es verdrahtet heute auch `memory` nicht, und das
nachzuziehen ist ein eigenes, hier nicht aufgeworfenes Thema.

### Tests

23 neue, zusammen 616 (61 Dateien) — inklusive der zehn Dummy-Skills aus dem Auftrag.

- **`tools/skill/catalog.test.ts`** (9, reines Dateisystem, kein Router): lädt zehn Dummy-Skills
  sortiert nach Namen, trägt Titel/Beschreibung/Auslösebedingung/Rumpf korrekt je Skill, liefert
  einen leeren Katalog bei fehlender Wurzel, überspringt ein Verzeichnis ohne `SKILL.md` und eine
  Datei auf oberster Ebene (`skills/README.md`), lässt einen kaputten Skill (fehlendes
  Pflichtfeld, leerer Rumpf) draußen, ohne die übrigen mitzureißen, ignoriert einen Ordnernamen
  außerhalb der Namenskonvention.
- **`tools/skill/tools.test.ts`** (5, echter Router): `skill.load` lädt die volle Anleitung ohne
  Schritt, schreibt `skill.invoked` mit Namen und Pfad, meldet unbekannte Namen ohne die
  bekannten zu verlieren, schreibt kein `skill.invoked`, wenn kein Name bekannt ist, weist eine
  leere Namensliste ab.
- **`context/request.test.ts`**, neue Gruppe "Skills (S18c)" (5): die Kurzliste aller zehn
  Dummy-Skills steht neben den Konventionen; der volle Anleitungstext (mit einem eindeutigen
  Marker) steht **nicht** darin und die Kurzliste bleibt unter 3000 Zeichen, obwohl die vollen
  Anleitungen zusammen über 12.000 Zeichen trügen; kein `<skills>`-Block ohne Katalog bzw. bei
  leerem Katalog; Redaction greift auf Titel/Beschreibung/Auslösebedingung.
- **`runtime/loop/loop.test.ts`**, neue Gruppe "Skill-System (S18c)" (1, echte Datenbank, echter
  Router, Drehbuch-Modell): legt zehn Dummy-Skills in ein Wegwerf-Verzeichnis, baut einen Katalog
  mit `skill.load`, lässt ein Drehbuch `skill.load` für `dummy-05` aufrufen und dann fertig
  antworten — die erste Anfrage trägt nur die Kurzliste (kein Marker aus irgendeinem der zehn
  Skills), die zweite trägt den vollen Rumpf von `dummy-05` (Marker vorhanden) in der Historie,
  und `skill.invoked` steht im Protokoll. Das ist der Ende-zu-Ende-Nachweis des
  Fertig-Kriteriums: "ein Skill wird bei Bedarf korrekt vollständig geladen und genutzt".
- **`runtime/events/log.test.ts`**: die fest verdrahtete Namensraum-Zahl (16) musste auf 17
  angehoben werden — derselbe Nachzug wie bei den Katalog-Fingerabdrücken in S18b, diesmal für
  die Ereignis-Taxonomie statt den Tool-Katalog.

### Gegenproben

Keine gesonderten Gegenproben in dieser Session — die drei zentralen Mechanismen (Kurzliste
bleibt klein, volle Anleitung erst nach `skill.load`, `skill.invoked` nur bei tatsächlichem
Treffer) sind direkt durch positive **und** negative Testfälle abgedeckt (siehe oben: die
Redaction- und Leer-Fälle in `context/request.test.ts`, die Marker-Abwesenheit/-Anwesenheit in
`runtime/loop/loop.test.ts`, das fehlende `skill.invoked` bei ausschließlich unbekannten Namen
in `tools/skill/tools.test.ts`).

### Bewusst nicht gebaut

- **Eine Installation neuer Skills aus einer externen Quelle.** Siehe oben — Abschnitt 4.7
  spricht davon, ist aber ein späterer, hier nicht verlangter Mechanismus.
- **Automatische Auslagerung für außergewöhnlich große Skills.** `skill.load` ist
  `execution: "runtime"` wie `tool.load` und wirft bei einer zu großen Hülle
  (`ToolOutputTooLargeError`), statt sie in ein Artefakt auszulagern — dieselbe Grenze wie bei
  `tool.load`s Schemata. Für die heutigen Skillgrößen kein Problem.
- **Eine feinere Freigabe-Granularität für `skill.load`.** Es ist `read`, wie `tool.load` — ein
  Nachschlagen auf lokalem, beim Start eingefrorenem Bestand, kein Grund für `soft_write` oder
  höher.
- **Ein Zwischenzustand "geladen, aber noch nicht gelesen".** Wie bei S18b (zwei Zustände, nicht
  drei) gibt es nur "im `<skills>`-Block" und "vollständig im Kontext" — kein Halbzustand.

### Offene Befunde (Details zu S18c)

Siehe die neuen Einträge oben unter "Offene Befunde (gesamte Historie)": der `<skills>`-Block
wächst unbegrenzt mit der Zahl der Skills, und `skill.load` bietet keine automatische
Auslagerung für außergewöhnlich große Skills.

- `pnpm typecheck && pnpm lint && pnpm test` grün, 616 Tests.
- `tasks.json`: S18c auf `done`, S18d von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S18d Erste eigene Skills.

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
