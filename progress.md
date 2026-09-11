# Fortschrittslog

Diese Datei ist die Kurzfassung. Fuer Details zu einer bestimmten alten Session in
progress-archiv.md nachschlagen (z. B. mit grep nach der Session-ID).

## Aktueller Stand

Phase 4 laeuft. Zuletzt abgeschlossen: **S18e** (Modell-Routing), 2026-09-11 — **S18d** (Erste
eigene Skills) wurde dabei übersprungen, auf ausdrücklichen Auftrag ("Aufgabe dieser Session:
Modell-Routing"), und steht weiter auf `ready`. Naechste Session: **S18f** Eval-Suite fuer lange
Laeufe, Status `ready`. Wer S18f angeht, sollte vorher entscheiden, ob S18d nachgeholt wird.

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
| S18d | Erste eigene Skills | ready |
| S18e | Modell-Routing | done |
| S18f | Eval-Suite fuer lange Laeufe | ready |
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
- **`<skills>`-Block waechst unbegrenzt** mit der Zahl der Skills (S18c), dieselbe Lage wie
  bei `<deferred_tools>` (S18b) — bei zehn Dummy-Skills im Test unauffaellig, S18d laesst den
  Bestand wachsen.
- **`skill.load` bietet keine automatische Auslagerung fuer aussergewoehnlich grosse Skills**
  (S18c) — wie bei `tool.load` wirft `callRuntimeTool` stattdessen `ToolOutputTooLargeError`.
  Fuer heutige Skillgroessen kein Thema, aber eine bewusste Grenze, keine vergessene.
- Weitere kleinere, session-lokale Befunde (Web-Postfach-Groesse, Git-Prozessstarts je Notiz,
  Injection-Scan-Groesse, Katalog-Migrationspfad bei zwei Kanaelen, `ensureGitIdentity` nur
  beim Anlegen, u. a.) stehen im Detail in progress-archiv.md bei der jeweiligen Session.
- **S18d (Erste eigene Skills) wurde uebersprungen**, S18e (Modell-Routing) lief direkt danach
  auf ausdruecklichen Auftrag. `tasks.json` haelt S18d bewusst auf `ready`, nicht auf `done` —
  wer als naechstes S18f angeht, sollte vorher entscheiden, ob S18d nachgeholt wird oder endgueltig
  entfaellt.
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
- **Nur zwei Klassen, Abschnitt 11 kennt drei** (S18e): "klein und guenstig", "mittel",
  "stark" — der Router kennt nur die aeusseren beiden ("Routine"/"Denkarbeit"), wie im Auftrag
  woertlich verlangt ("grob klassifiziert"). Die mittlere Klasse ("Zusammenfassen, einfache
  Tool-Auswahl") bleibt vorerst unbenannt; `compactionModel` (S18a) faellt weiterhin auf das
  Orchestrator-Modell zurueck, wenn niemand explizit ein zweites uebergibt.

## S18e · Modell-Routing · 2026-09-11

Fünfte Session der Phase 4, nach S18d übersprungen auf ausdrücklichen Auftrag. Vier Vorgaben,
alle wörtlich: ein Routing-Schritt vor dem eigentlichen Lauf, der grob zwischen Routine (günstig)
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

10 neue, zusammen 626 (62 Dateien).

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

Siehe die neuen Einträge oben unter "Offene Befunde (gesamte Historie)": S18d übersprungen, der
Router an keinem echten Aufrufer verdrahtet, kein echter Modellaufruf für die Klassifikation
prüfbar, nur zwei statt drei Klassen aus Abschnitt 11.

- `pnpm typecheck && pnpm lint && pnpm test` grün, 626 Tests.
- `tasks.json`: S18e auf `done`, S18f von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S18f Eval-Suite für lange Läufe.

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
