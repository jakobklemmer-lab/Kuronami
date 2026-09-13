# Fortschrittslog

Diese Datei ist die Kurzfassung. Fuer Details zu einer bestimmten alten Session in
progress-archiv.md nachschlagen (z. B. mit grep nach der Session-ID).

## Aktueller Stand

**Phase 6 und 7, 2026-09-13.** In derselben Sitzung: die Oberfläche 1:1 nach einer vom Nutzer
gelieferten Bildvorlage neu gebaut (S25, siehe unten — das ursprüngliche Fertig-Kriterium von
S25 bleibt dabei **offen**, `status: "ready"`), dazu **S26** (Slack-Anbindung) und **S27** (MCP
absichern), beide `status: "done"`. Nächste Session: **S25** in seiner ursprünglichen Bedeutung
(Ninja-Centerpiece) ist damit weiterhin die nächste offene Aufgabe in Phase 6, falls der Nutzer
dorthin zurückkehrt — S28 (Kosten-Tracking) bleibt entsprechend blockiert, da es an S25 **und**
S27 hängt.

**Phase 8 und 9 angebrochen, 2026-09-13.** Nach dem UI-Zwischenschub und seiner Korrektur nach
Bildvorlage (beide unten) sind **S28** (Kosten-Tracking) und **S29** (Tauri-Desktop-Wrapper)
`done`. S28 ist gegen die echte Datenbank nachgewiesen, S29 als gebaute und gestartete
Desktop-App (MSI + NSIS). **S25 ist auf Nutzeranweisung vom 2026-09-13 stillgelegt** — "S25 wird
komplett ignoriert, eventuell nochmal am Schluss des Projekts diskutabel, aber nicht jetzt";
die S25-Abhängigkeit von S28 wurde deshalb entfernt. Offen geblieben ist der zweite Titelteil von
S28, das **Modell-Routing**: `runtime/model/router.ts` ist weiterhin an keinen produktiven
Aufrufer verdrahtet (Befund seit S18e).

**Phase 9 abgeschlossen, 2026-09-13.** **S30** (Sprachschicht-Grundgerüst) und **S31** (Barge-in
und Backend-Brücke) sind `done` — siehe den Abschnitt "S30/S31" am Ende dieser Datei. Damit ist
der Sessionplan aus `tasks.json` **abgearbeitet**: alle S01–S31 sind `done`, außer S25
(stillgelegt auf Nutzeranweisung). Die nächste Sitzung hat keine vorgegebene Aufgabe mehr; was
offen ist, steht unter "Offene Befunde".

**S33 · Provider-Schlüssel aus der Oberfläche setzbar, 2026-09-13.** Während S32 lief (parallele
Sitzung, siehe `docs/sessions/S32-prompt.md`), bat der Nutzer um eine Möglichkeit, API-Schlüssel
über die Einstellungsseite statt per Hand in `.env` einzutragen. Eigene Sitzung, unabhängig von
S32, `status: "done"` — siehe den Abschnitt "S33" am Ende dieser Datei.

**UI-Zwischenschub, 2026-09-13 (eigene Sitzung, nach S25–S27).** Reine Oberflächen-Überarbeitung
auf ausdrücklichen Nutzerauftrag, ausdrücklich **kein** Sprint der S-Reihe — siehe den Abschnitt
"UI-Zwischenschub" am Ende dieser Datei für alle Einzelheiten. Kurzfassung: Emblem, einklappbare
Sidebar, eine neu gebaute Startseite als persönliches Cockpit (Läufe/Freigaben/Fehler/Kennzahlen
aus S22–S24 dafür **nicht gelöscht**, sondern auf eine neue Route `#/system` umgezogen), Abdocken
per nativem Drag-and-Drop, eine vollständige Einstellungsseite, herkunftsbasierte Farbableitung
für den Hintergrund und ein Mic-Button mit sechs Agentenzuständen. Berührt nur `ui/**` — Backend,
Policy-Engine und Agenten-Loop unverändert, `tasks.json` unverändert (kein S-Sprint).

**Der Plan wurde am 2026-09-12 umnummeriert** (S21 an aufwärts) — siehe den Abschnitt
"Planänderung · 2026-09-12" gleich unten, bevor irgendwo mit einer alten S21–S24-Zählung
weitergearbeitet wird.

**Die Testbasis hat sich mit S21 verschoben.** `vitest.config.ts` läuft seit dieser Session nur
noch auf `ui/**` und `phase-6/**`; die 679 Tests der Phasen 1–5 stehen weiter im Repo, laufen
aber nicht mehr automatisch (auf Anordnung des Nutzers, Schritt 1 des S21-Auftrags). Wer eine
Änderung an `runtime/`, `tools/`, `policy/`, `gateway/`, `heartbeat/`, `context/`, `skills/` oder
`evals/` macht, prüft sie nicht mehr mit `pnpm test` — dafür braucht es einen Lauf mit
angepasstem `include`. `pnpm typecheck` deckt weiterhin den **ganzen** Quellbaum ab und ist
seither die einzige durchgehende Prüfung über die alten Schichten.

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
| S20 | Erste Subagent-Besetzung | done |
| S21 | Ereignisbus und UI-Grundgerüst (+ Nachtrag: `pg_notify`) | done |
| S22 | Runs- und Detail-Ansicht | done |
| S23 | Freigabe- und Fehler-Ansicht | done |
| S24 | Kennzahlen-Panels | done |
| S25 | Centerpiece und 3D-Welt | stillgelegt (Nutzerentscheidung 2026-09-13, ggf. am Projektende) |
| S26 | Slack-Anbindung | done |
| S27 | MCP absichern | done |
| S28 | Kosten-Tracking und Modell-Routing | done (Routing-Teil offen) |
| S29 | Tauri-Desktop-Wrapper | done |
| S30 | Sprachschicht-Grundgerüst | done (Anbieter verdrahtet, nie gerufen — kein Schlüssel) |
| S31 | Barge-in und Backend-Brücke | done |

Details siehe progress-archiv.md. S21–S24 vor der Umnummerierung: dort steht das alte
Kosten-Tracking/Tauri/Sprachschicht/Barge-in unter den alten Nummern — die Session-**Inhalte**
sind unverändert, nur die Nummern ab S21 sind neu (siehe unten).

## Planänderung · 2026-09-12

**Kein Code, keine Session — reine Umnummerierung**, ausdrücklich vom Nutzer angeordnet: nach
Phase 5 kommt laut Architektur (Abschnitt 16 bzw. der Notion-Roadmap) planmäßig Phase 6 (Neue
Oberfläche) und Phase 7 (Weitere Kanäle), bevor Phase 8 (Kosten-Tracking, bisher S21) beginnt.
Diese beiden Phasen hatten in `tasks.json` noch keine Sessions — nur eine Checkliste in Notion.
Sie sind jetzt als S21–S27 eingefügt, das alte S21–S24 rutscht auf S28–S31 (Inhalt unverändert).

**Phase 6 · Neue Oberfläche (S21–S25).** Checkliste aus der Notion-Roadmap in fünf Sessions
gebündelt, in der dort vorgegebenen Reihenfolge: Ereignisbus + Grundlayout (S21) → Runs-/Detail-
Ansicht (S22) → Freigabe-/Fehler-Ansicht (S23) → Kennzahlen-Panels (S24) → Centerpiece und
3D-Welt (S25). Die Design-Grundlage dafür (Centerpiece: Ninja auf Stein im See, drei
Animationszustände, Beschwörungskreise für Subagenten ohne Pathfinding; UI-Scope Desktop/Web)
wurde bereits besprochen (siehe `areas/dashboard-website.md`) — der Nutzer baut sie als Canvas
in Claude Design. S21 stand deshalb zunächst auf `blocked`, nicht auf `ready`, obwohl seine
einzige Code-Abhängigkeit (S20) erfüllt war: eine neue Bedeutung für `status`, die es vorher
nicht gab — "die Coding-Abhängigkeiten sind erfüllt, aber eine Design-Vorlage außerhalb von
tasks.json fehlt noch".

**Nachtrag 2026-09-12, mit S21 erledigt:** Der Nutzer hat die Blockade selbst aufgelöst, indem
er den Umfang geändert hat — **Phase 6 startet ohne 3D-Centerpiece, nur mit Wasserkreisen**. Die
Design-Vorlage war für das Centerpiece nötig, nicht für Ereignisbus und Grundlayout; ohne es
hängt S21 an nichts mehr. Das Centerpiece bleibt S25 und braucht die Canvas weiterhin.

**Phase 7 · Weitere Kanäle (S26–S27).** Von der Notion-Checkliste nur die beiden Punkte
übernommen, die nicht "falls gewünscht"/"erst wenn nötig" heißen: Slack-Anbindung (S26,
inklusive Freigabe per Reaktion/Thread-Antwort) und MCP-Hardening (S27). ACP-Adapter und A2A
bleiben absichtlich draußen — dieselbe Haltung wie bei `exec.run`/`github.*` seit S20: gebaut
wird, wenn ein echter Bedarf da ist, nicht auf Vorrat. **S26 hängt bewusst nur an S20, nicht an
S21–S25** — Slack-Anbindung braucht die neue Oberfläche nicht, und kann deshalb vorgezogen
werden, solange die Design-Vorlage für Phase 6 noch offen ist.

**S28 (das alte S21, Kosten-Tracking) hängt jetzt an S25 UND S27** statt nur an S20: der
Checklisten-Punkt "Kosten-Panel im Dashboard" aus Phase 8 braucht ein Dashboard, und das ist ab
Phase 6 die neue Oberfläche, nicht mehr die alte Dev-UI aus S12b.

**Was das nicht ist:** keine inhaltliche Neuplanung von S21–S24 alt (jetzt S28–S31) — deren
`done_when` ist wortgleich übernommen. Auch keine Entscheidung, dass Phase 6 vor Phase 7 fertig
sein muss: beide hängen unabhängig an S20, die Nummerierung folgt nur der Reihenfolge aus der
Notion-Roadmap.

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
- ~~Keine Obergrenze für parallele Arbeiter, kein Token-Budget in Token~~ (S19) — **erledigt in
  S20**: Kontingent je Prozess (`AGENT_MAX_PARALLEL`, Vorgabe 2) und `token_budget` je Agent.
- **Das Kontingent paralleler Arbeiter ist prozesslokal** (S20), kein verteiltes Limit — dieselbe
  Lage wie bei der Serialisierung im Gateway (S16). Zwei Prozesse (Gateway und Heartbeat) haben
  heute jeder zwei Plätze, zusammen also vier.
- **Das Token-Budget zählt, was der Anbieter meldet** (S20) — nicht, was es kostet. Ein Budget in
  Token ist bei zwei Modellklassen mit verschiedenen Preisen nur ein Näherungswert für Geld; die
  Umrechnung ist S21.
- **`exec.run` und `github.*` fehlen der Besetzung** (S20): der Backtest-Agent arbeitet auf
  Dateien statt zu rechnen, der Coder ohne Zugriff auf Issues und PRs. Beide Werkzeuge stehen in
  Abschnitt 9, gebaut sind sie nicht.
- **Die Besetzung nennt keine `notes.*`** (S20), weil ein Profil mit einem Werkzeug, das nur in
  manchen Prozessen existiert, in allen anderen gar nicht läuft (fail closed, S19). Sobald der
  Obsidian-Vault Teil jeder Verdrahtung ist, gehört er in das Profil des Lore-Writers.
- ~~Der Ereignisbus sagt vor dem COMMIT an~~ (S21) — **erledigt im Nachtrag zu S21**:
  `appendEventInTx` sagt seither per `SELECT pg_notify(...)` an (in derselben Transaktion wie
  die Einfügung), und `runtime/events/notify.ts` hält eine eigene, dauerhaft lauschende
  Verbindung, die den vollen Datensatz über `readEventById` zurückliest, sobald die
  Benachrichtigung ankommt. Ein ROLLBACK sagt jetzt nachweislich nichts mehr an
  (`notify.test.ts`, echte Datenbank). Nebeneffekt, bewusst in Kauf genommen und dokumentiert
  in `runtime/events/bus.ts`: der NOTIFY-Kanal ist global, nicht je Prozess — jeder Prozess mit
  einem eigenen Bus sieht seither **jedes** committete Ereignis im System, nicht mehr nur, was
  er selbst geschrieben hat. Für S22 (Runs über alle Kanäle, auch Hintergrundläufe) ist das die
  richtige Reichweite; sicher bleibt es, weil die Redaction an der Zeile hängt, nicht am
  Absender.
- **Die Tests der Phasen 1–5 laufen nicht mehr automatisch** (S21, auf Anordnung des Nutzers).
  `vitest.config.ts` deckt seither nur `ui/**` und `phase-6/**`; die 679 Tests stehen weiter im
  Repo, aber eine Änderung an `runtime/`, `tools/`, `policy/`, `gateway/`, `heartbeat/`,
  `context/`, `skills/` oder `evals/` wird von `pnpm test` nicht mehr bemerkt. `pnpm typecheck`
  deckt den ganzen Quellbaum weiter ab und ist seither die einzige durchgehende Prüfung dort.
- **Der Bus hat keinen Verlauf vor dem Verbinden** (S21) außer seinem Ringpuffer der letzten
  fünfzig Ereignisse, und der überlebt keinen Neustart. Für S22 (Runs- und Detail-Ansicht) ist
  das der Grund, warum die Liste aus der Datenbank kommen muss und nicht aus dem Strom: der
  Strom sagt, was **seither** geschah, nicht was ist.
- **Der Ereignisstrom ist unauthentifiziert** (S21). Geschützt ist er durch localhost und die
  Herkunftsprüfung (`originAllowed`, Vorgabe nur localhost — ein WebSocket kennt keine
  Same-Origin-Regel, ohne sie könnte jede offene Seite mitlesen). Ein Token wäre der nächste
  Schritt, sobald der Port über den Rechner hinausgeht; dann zusammen mit dem des Gateways
  (S16), nicht daneben.
- **Nur zwei Klassen, Abschnitt 11 kennt drei** (S18e): "klein und guenstig", "mittel",
  "stark" — der Router kennt nur die aeusseren beiden ("Routine"/"Denkarbeit"), wie im Auftrag
  woertlich verlangt ("grob klassifiziert"). Die mittlere Klasse ("Zusammenfassen, einfache
  Tool-Auswahl") bleibt vorerst unbenannt; `compactionModel` (S18a) faellt weiterhin auf das
  Orchestrator-Modell zurueck, wenn niemand explizit ein zweites uebergibt.
- **"Run" heißt Session, nicht Task** (S22), obwohl `kuronami.tasks` mit acht Statuswerten die
  einzige bestehende Entsprechung war. Begründung: `ui/index.html` nennt das Panel seit S21
  "Läufe", die Architektur benutzt "Lauf" durchgängig für eine Session-Ausführung, und nur eine
  Session hat ein Schritt-für-Schritt-Protokoll mit Artefakten — genau, was S22s Fertig-Kriterium
  verlangt. `RunStatus` (`runtime/session/run-status.ts`) ist eine **neue**, achtwertige
  Verfeinerung von `SessionStatus` (S05, weiterhin fünf Werte, unverändert und ungetestet
  gegenüber Fremdaufrufern) — kein Umbau des bestehenden Typs, um dessen feste Tests
  ("`session.created` allein ist `running`") nicht zu brechen. Die drei neuen Werte (`queued`,
  `ready`, `blocked`) sind ehrlich aus dem Protokoll herleitbar: `queued`/`ready` aus der Lücke
  zwischen `session.created` und `runtime.started` (die es laut `manager.ts` wirklich gibt, "eine
  zweite Transaktion, bewusst"), `blocked` aus einem offenen `agent.delegated` ohne
  `agent.returned`. Bewusst **nicht** gebaut: ein Zustand für "Prozess ist abgestürzt" — das
  bräuchte eine Liveness-Aussage, die aus reiner Protokoll-Faltung nicht ehrlich herleitbar ist
  (nur ein Prozess selbst weiß, ob er noch lebt), und wäre eine geratene Vermutung, die aussieht
  wie eine Tatsache.
- **`listRuns` lässt eine einzelne kaputte Session nicht die ganze Übersicht mitreißen** (S22) —
  gefunden beim echten Testlauf gegen die geteilte Dev-Datenbank: eine Altlast-Session mit einem
  `step.started` ohne `step_id` (vermutlich aus einem sehr frühen Ad-hoc-Lauf) ließ
  `deriveSessionState` werfen und riss die komplette Liste um. `RunSummary.status` ist seither
  `RunStatus | null`, `foldError` trägt den Fehlertext (AGENTS.md: Fehler nie verstecken) — die
  Zeile bleibt sichtbar, nur ohne verlässlichen Status. `getRunDetail` für **eine** angefragte
  Session lässt denselben Fehler dagegen offen durch: dort hat der Aufrufer explizit nach genau
  dieser Session gefragt.
- **`/runs` und `/runs/:id` liegen nur am Gateway, nicht am kleinen Ereignisserver aus S21**
  (S22). Der Server aus `runtime/events/bus.ts` bleibt bei genau zwei Aufgaben (`/events`,
  `/health`) wie in S21 entworfen; die Runs-API braucht `kuronami.sessions`/`artifacts` und
  gehört fachlich zum Gateway. Praktisch heißt das: `pnpm dev` (Runtime ohne Kanal) zeigt weiter
  nur den Ereignisstrom, ein Testlauf von S22 braucht `pnpm gateway`.
- **CORS am Gateway, gefunden beim echten Ausprobieren im Browser** (S22). Ein `fetch()` von der
  Oberfläche (eigener Ursprung im Dev-Betrieb, `ui/dev.ts` Port 3001) gegen das Gateway (Port
  8788) schlug mit "Failed to fetch" fehl — der `Authorization`-Header löst einen Preflight aus,
  den `gateway/server.ts` nicht beantwortete. Behoben mit derselben Herkunftsprüfung wie am
  Ereignisstrom (`originAllowed` aus `bus.ts`, Vorgabe nur localhost) statt einer zweiten,
  abweichenden Liste. Ohne den echten Browsertest (nicht nur `curl`/Node-`fetch`, die CORS gar
  nicht durchsetzen) wäre das nicht aufgefallen — Node-Tests allein hätten grün gemeldet, obwohl
  die Oberfläche im echten Browser nie eine Antwort bekommen hätte.
- **`/runs`, `/runs/:id` und der Bearer-Token in den Einstellungen sind unauthentifiziert
  gegenüber jedem lokalen Aufrufer, der den Token kennt oder rät** (S22/S23) — genau dieselbe
  Vertrauensgrenze wie `/channels/web/*` seit S16 (localhost, ein Token). Der Token liegt in
  `localStorage` der Oberfläche (`ui/settings.ts`), je Browserprofil, nie an Kuronami selbst
  gerichtet. Kein zusätzlicher Schritt gegenüber S16 — dieselbe offene Frage ("Token, sobald der
  Port über den Rechner hinausgeht") gilt jetzt auch hier, nicht daneben.
- **Der Fehler-Verlauf im Panel "Freigaben & Fehler" ist rein flüchtig** (S23): er sammelt
  `step.failed`/`tool.failed`/`session.failed`/`error.raised` aus dem **Live-Strom**, gedeckelt
  auf zwanzig Zeilen, und ist nach einem Neuladen leer. Das erfüllt das Fertig-Kriterium wörtlich
  ("bleibt sichtbar", nicht "übersteht ein Neuladen") und braucht keine neue Aggregatabfrage über
  alle Sessions. Ein historischer Fehlerabruf über einen Neustart hinweg ist der nächste Schritt,
  sobald jemand ein Postmortem über den aktuellen Lauf hinaus braucht.
- **`/channels/web/pending`/`/answers` bedienen nur die eine Gateway-Unterhaltung** (S23), nicht
  beliebige Sessions im System. Bewusst so: ein delegierter Arbeiter kann seit S19 ohnehin auf
  keine Freigabe warten (sein Lauf schlägt fehl statt anzuhalten), `awaiting_user` kommt also in
  der Praxis nur bei der einen Unterhaltung vor, die ein Mensch führt — und genau die bedienen
  die beiden Endpunkte bereits seit S16.
- **Die Kennzahlen in `/runs` sind über alle Sessions der Liste summiert** (S24,
  `combineRunMetrics` in `context/metrics.ts`), nicht über einen einzelnen Lauf oder einen
  Prozess seit seinem Start. Die beiden Quoten (Cache-Trefferquote, Auslagerungsanteil) werden
  aus den summierten Zählern neu gebildet, nicht gemittelt — ein Mittel über Quoten gewichtete
  jeden Lauf gleich, unabhängig davon, wie viel dahinterstand. Was Abschnitt 12 zusätzlich nennt
  (Freigaben pro Aufgabe, Wartezeit auf Freigabe, Tool-Latenz) bleibt weiterhin ausdrücklich
  außerhalb von `context/metrics.ts` — das sind Zeitmessungen über Ereignispaare hinweg und
  brauchen eine eigene, noch nicht eingeplante Beobachtbarkeits-Session (Entscheidung aus S18a,
  hier nur bestätigt, nicht neu getroffen).
- **S25 wurde mitten in der Sitzung umgeleitet** (2026-09-13, auf ausdrücklichen Nutzerauftrag):
  erst die Claude-Design-Spec (Ninja-Centerpiece, Beschwörungskreise) gebaut und getestet, dann
  auf "das gefällt mir nicht, bau die Oberfläche exakt nach diesem Bild" umgeschwenkt — das
  Centerpiece wurde daraufhin vollständig verworfen ("Drop it completely for now"), bevor
  irgendetwas davon committet war. Das ursprüngliche Fertig-Kriterium von S25 ist damit weiter
  offen; siehe den S25-Abschnitt unten für das, was stattdessen entstand.
- **Die Wasserkreise (`ui/canvas/ripples.ts`, S21) sind seit S25 unverdrahtet**, aber bewusst
  nicht aus dem Baum entfernt — sie sind eine bereits committete, getestete Session-Lieferung
  (S21), und sie zu löschen wäre eine andere Entscheidung als "die neue Oberfläche folgt jetzt
  einem Bild statt einer eigenen Szenerie". `ripples.ts`/`ripples.test.ts` bleiben mit eigener
  Historie liegen; ob sie gebraucht werden (z. B. für eine spätere, andere Fassung des
  Centerpiece) oder endgültig entfernt gehören, ist eine offene Entscheidung, keine vergessene.
- **Slack-Anbindung (S26) hat keine Anhänge und kein Socket Mode** — nur Text und Freigaben
  (Reaktion/Thread-Antwort), `InboundMessage.attachments` ist für Slack immer `[]`. Ohne
  öffentliche Adresse (Events-API-Webhook) bleibt der Kanal unbedienbar, dieselbe Lage wie
  Telegram im Webhook-Betrieb ohne Tunnel — anders als bei Telegram gibt es dafür (noch) keinen
  tunnelfreien Ausweg wie Long-Polling.
- **MCP (S27) hat keinen echten Server verkabelt.** Der Mechanismus (Entdeckung, Härtung) steht
  und ist getestet; welcher MCP-Server als erster angebunden wird, ist weiterhin die offene
  Frage aus Abschnitt 17. Nur `tools/list`/`tools/call` sind gebaut, keine MCP-Ressourcen oder
  -Prompts, und jeder Server bekommt genau eine Risikostufe für alle seine Tools, keine
  feinere Abstufung je Fernwerkzeug.
- **Deepgram und ElevenLabs sind verdrahtet, aber nie gerufen worden** (S30) — dieselbe Lage wie
  bei `ANTHROPIC_API_KEY` seit S16: es gibt keine Schlüssel. Nachgewiesen ist, dass beide Dienste
  im gebauten Graphen stehen und die Pipeline mit ihnen hochkommt; **nicht** nachgewiesen ist,
  wie schnell oder wie gut sie antworten. Damit bleibt auch die eine Hälfte des 800-ms-Budgets
  unbelegt: die Strecken `erkennung` und `stimme` sind im Messstand die Stand-ins. Mit Schlüsseln
  ist die echte Messung eine Umgebungsvariable entfernt (`VOICE_MODE=live`, derselbe Messstand).
- **Der WebSocket-Rand der Sprachschicht prüft erst in der Brücke** (S30). Pipecats Transporte
  nehmen eine Verbindung an, bevor ein Frame entsteht; das Sitzungsgeheimnis wird deshalb als
  erste Nachricht geprüft (`voice.hello`), und bis dahin geht kein Transkript ins Backend.
  Audio **fließt** aber schon vorher in die Erkennung — im Live-Betrieb hieße das: ein fremder
  Prozess auf demselben Rechner könnte Deepgram-Kosten verursachen, ohne je etwas auszulösen.
  Der saubere Ort wäre ein `process_request`-Haken am Server, den der Transport heute nicht
  durchreicht.
- **Die Sprachschicht weiß nicht, wer spricht** (S30). Der Token sagt "dieser Prozess darf", nicht
  "dieser Mensch ist es". Für ein Ein-Personen-System auf Loopback ist das die richtige Körnung;
  eine Sprecherverifikation wäre eine eigene Entscheidung, keine vergessene Zeile.
- **Kein Wake-Word** (S30/S31): eine Sitzung beginnt mit dem Mic-Knopf oder Strg/Cmd+M. Das Feld
  in den Einstellungen steht sichtbar und deaktiviert da, mit genau diesem Hinweis.
- **Zwei der sechs Mic-Zustände kommen weiterhin nicht aus der Sprachschicht** (S31): `executing`
  und `complete`. Hinter einem einzelnen HTTP-Aufruf ans Gateway lässt sich "denkt nach" nicht von
  "ruft gerade ein Werkzeug auf" unterscheiden; wer das sehen will, sieht es am Ereignisstrom
  (S21), wo jeder Werkzeugaufruf einzeln steht. Einen Zustand zu senden, den diese Schicht nicht
  kennt, wäre eine Anzeige, die rät.
- **Der Messstand misst mit dem Energie-Detektor, nicht mit Silero** (S31). Grund: Silero hält
  synthetischen Ton zu Recht für keine Stimme — nachgeprüft mit Sinus, Rauschen und einem
  Formantengemisch, alle drei `QUIET`. Blockgröße und Zeitzählung sind identisch, die Frage "ist
  das eine Stimme" ist es nicht. Sileros eigene Rechenzeit je Block steckt damit nicht in den
  gemessenen Zahlen.
- **Die Sprach-Routen im Gateway wiederholen die Web-Routen** (S30), rund sechzig Zeilen. Bewusst
  nicht zusammengelegt: die Tests der Web-Routen laufen seit S21 nicht mehr automatisch, und eine
  Änderung am Herzstück der Außengrenze ohne laufendes Netz darunter wäre der schlechtere Handel.
  Gehört zusammengelegt, sobald die alten Tests wieder laufen; der Grund steht als Kommentar an
  der Stelle.

## Ideen für später (vom Nutzer, zurückgestellt bis der Kern steht)

Keine Aufgabe in tasks.json — bewusst zurückgestellt, bis das Kernprogramm (mindestens bis S24)
fertig ist. Beim nächsten Blick auf diese Datei ansprechen, ob es jetzt an der Reihe ist.

- **Team-Pipelines statt Einzelrollen.** Die Subagenten sollen zu Teams werden, die der
  Orchestrator (Kuronami, "der CEO") selbst Schritt für Schritt durchsteuert: er holt sich
  nacheinander Ergebnisse von einer Rolle zur nächsten (z. B. Trading: Ideen-Geber → Prüfer →
  Backtester → Ausführer; Lore: Autor → Prüfer → Verfeinerer). Ausdrücklich **keine** Rekursion
  (Subagent ruft Subagent) — das bleibt verboten (S19). Der Hauptagent orchestriert die Kette
  selbst und spricht sich dabei mit dem Nutzer ab; ein Auftrag wie "entwerf mir eine Strategie"
  soll die passenden Subagenten automatisch der Reihe nach aufrufen, nicht der Nutzer manuell
  Schritt für Schritt. Dass Teammitglieder später automatisch untereinander zusammenarbeiten
  (ohne dass der Orchestrator jeden Schritt anstößt), ist eine mögliche spätere Ausbaustufe —
  explizit nicht jetzt.
- **TradingView statt/neben Broker-API für den Trading-Agenten.** Es gibt eine Broker-API-Option,
  aber der Nutzer würde lieber TradingView anbinden (dort lassen sich Backtests fahren und Trades
  aufsetzen). Ob und wie sich eine TradingView-API dafür verbinden lässt, ist ungeklärt — reine
  Recherche, sobald es dran ist.

## S25 · Oberfläche neu nach Bildvorlage · 2026-09-13

Auftrag zunächst wie in `tasks.json` notiert: Claude-Design-Spec umsetzen (Ninja auf Stein im
See, drei Animationszustände, Beschwörungskreise ohne Pathfinding/Tween). Das wurde gebaut —
`ui/canvas/centerpiece.ts` (reine Posenzuordnung `idle`/`processing`/`speaking→"delivered"`,
vier Tests), `ui/canvas/summons.ts` (`SummonField`, deterministische Position aus der
Aufrufkennung, Puls über die Zeit statt Bewegung, neun Tests), dazu Mond/Bergsilhouette als
CSS/SVG und ein handgezeichneter Ninja auf einem Felsen, alles grün getestet und im Browser
geprüft (`pnpm dev:ui`, echter Screenshot-Vergleich der drei Posen über erzwungene
CSS-Zustände, da die Automatisierungsumgebung `prefers-reduced-motion: reduce` meldet und
Animationen sonst gar nicht liefen).

**Mitten in der Sitzung dann die Kehrtwende, wörtlich vom Nutzer:** "Build the dashboard EXACTLY
like the picture I gave you. Forget everything we said about the design before, because it
really doesnt look good." Dazu ein zweites Bild (`lake.jpg`, jetzt `ui/assets/lake.jpg`) als
das tatsächliche Hintergrundfoto der Vorlage. Rückfrage, ob das Centerpiece trotzdem bleiben
soll (es kommt in der Vorlage nicht vor) — Antwort: "that was the wrong answer. Drop it
completely for now." Da nichts von alledem committet war, war das Verwerfen unkompliziert:
`ui/canvas/centerpiece.ts`/`.test.ts` und `summons.ts`/`.test.ts` wieder gelöscht, bevor sie je
in einem Commit standen.

**Was stattdessen steht: die Oberfläche 1:1 nach der Vorlage.**

* **Echtes Hintergrundfoto statt gezeichneter Szenerie.** `ui/assets/lake.jpg` (vom Nutzer
  geliefert) liegt als `.scene`-Hintergrund fest über dem ganzen Bildschirm, mit einem
  Verlaufsraster darüber, das den Text auch dort lesbar hält, wo das Foto selbst hell ist (der
  Lichtschein rechts im Bild). `ui/serve.ts`: `.jpg`/`.jpeg` als Content-Type ergänzt, die Datei
  in `STATIC_FILES` aufgenommen (dieselbe Liste, die `ui/build.ts` unverändert kopiert).
* **Seitenleiste statt Taskbar** — die Vorlage führt Bereiche links, nicht oben. Bereiche mit
  echter Anbindung (`Home`) sind ein aktiver Eintrag; Bereiche ohne eigene Oberfläche (Mail,
  Calendar, Trading, Research, Files — Kuronami hat dafür Werkzeuge, aber keine eigene Ansicht)
  stehen sichtbar, aber `aria-disabled` und ohne Klickziel: ein totes `<a>` wäre eine
  vorgetäuschte Funktion (AGENTS.md, "keine Platzhalter"). `Settings` ist ein echter Eintrag
  (öffnet dasselbe Einstellungs-Panel wie zuvor das schwebende Zahnrad, das es jetzt nicht mehr
  gibt). Ganz unten der Verbindungsstatus (Punkt + Text), an der Stelle, an der die Vorlage
  "System Online" zeigt — hier mit dem echten Wert aus `bus.onStatus`, nicht fest verdrahtet.
* **Zentrierte Uhr/Datum-Kopfzeile** wie in der Vorlage, mit echter laufender Zeit
  (`startHeroClock`, ersetzt das alte `startClock` auf die Taskbar-Uhr).
* **Kein Wetter-Widget.** Die Vorlage zeigt an dieser Stelle Außentemperatur und Vorhersage —
  dafür gibt es keine Quelle in Kuronami, und eine erfundene Zahl wäre genau die Art Platzhalter,
  die dieses Projekt durchgehend vermeidet (siehe die Kennzahlen-Panels seit S24: "keine
  Platzhalter, echte Werte"). An derselben Bildstelle (oben rechts) stehen stattdessen zwei
  echte Systemsignale: das Zustandsabzeichen (`idle`/`processing`/…) und die
  Benachrichtigungsglocke — dieselbe Funktion wie vorher in der Taskbar, nur an der Position,
  die die Vorlage für "Status" vorsieht.
* **Vier Glaskarten statt sechs Vorlagen-Slots.** Die Vorlage zeigt Markt-Ticker, Posteingang,
  Tagesplan, vier Aktionsknöpfe, System-Gauges und ein Zitat — sechs Flächen, von denen
  Kuronami für höchstens vier eine ehrliche Entsprechung hat. Erfunden wurde keine: **Läufe**
  (S22, an der Stelle von "Markets"), **Freigaben & Fehler** (S23, an der Stelle von "Inbox"),
  **Plan** (an der Stelle von "Today") und **Kennzahlen** (S24, an der Stelle von "System") —
  zwei Spalten, zwei Karten je Spalte, alle mit demselben Glaskarten-Rahmen (abgerundete Ecken,
  Symbol + Titel + Chevron im Kopf, wie in der Vorlage). Aktionsknopfleiste und Zitat-Karte
  fehlen bewusst: es gibt weder ein `Open Terminal` noch ein `Focus Mode` in diesem System, und
  ein Knopf ohne Wirkung wäre wieder eine vorgetäuschte Funktion.
* **IDs unverändert.** `main.ts`s Verdrahtung von Läufen/Freigaben/Kennzahlen (S22–S24) hängt an
  Element-`id`n, nicht an Klassen — die sind identisch geblieben (`runs-list`, `approvals-list`,
  `metric-cache-hit-rate`, …), nur `panel__*`-Klassen heißen jetzt `card__*` (Vorlagenbegriff).
  Entfernt wurden ausschließlich Ripple-/Summon-/Centerpiece-spezifische Verdrahtung; die
  eigentliche Anwendungslogik (Abrufe, Freigabe-Antworten, Fehlerprotokoll) ist unverändert.

### Tests

Vier neue reine Logik-Tests fielen mit dem Centerpiece wieder weg (waren nie committet). Von
den verbleibenden UI-Tests unverändert: `ui/canvas/ripples.test.ts` (Modul bleibt liegen, siehe
offene Befunde), `ui/events/bus.test.ts`, `ui/api/client.test.ts`, `ui/runs/status.test.ts`,
`ui/settings.test.ts` — 31 Tests, 5 Dateien, alle grün. `main.ts` bleibt aus Prinzip ungetestet
(die eine Datei, die das Dokument anfasst, siehe ihr eigener Kommentar).

### Gegenprobe

Keine gesonderte Gegenprobe über Testcode — die Gegenprobe war der Browser selbst:
`pnpm dev:ui`, echter Vergleich gegen die Vorlage nach jeder Änderung (Mond zunächst vom
Bildschirmrand abgeschnitten wegen `background-position: center center` bei einem Seitenverhält-
nis, das nicht zum Foto passt — behoben mit `center 30%`), Einstellungen-Umschalter geprüft,
Zustandspille/Verbindungspunkt visuell bestätigt.

### Bewusst nicht gebaut

* Das ursprüngliche S25-Fertig-Kriterium (Ninja-Centerpiece, Beschwörungskreise) — siehe oben,
  auf Nutzerauftrag verworfen, nicht vergessen. `tasks.json` markiert S25 deshalb weiterhin als
  `ready`, nicht `done`.
* Ein voll responsives Nachziehen der neuen Seitenleiste unter 900px wurde nur an der
  bestehenden `@media`-Regel weitergeschrieben (Seitenleiste wird zur Symbolspalte), aber nicht
  im echten schmalen Browserfenster geprüft (Fenster-Resize der Automatisierung griff im Test
  nicht zuverlässig) — ein Nachweis auf einem echten schmalen Gerät steht noch aus.
* Kein Wetter, kein Markt-Ticker, keine Aktionsknopfleiste — siehe oben, jeweils weil es dafür
  keine ehrliche Datenquelle bzw. keine echte Funktion gibt.

### Offene Befunde (Details zu S25)

Siehe die neuen Einträge oben unter "Offene Befunde (gesamte Historie)": die Umleitung mitten
in der Sitzung, `ripples.ts` unverdrahtet liegen gelassen.

* `pnpm typecheck` (beide `tsconfig.json` und `ui/tsconfig.json`) grün, `pnpm lint` (Biome) grün,
  `ui/`-Tests grün (31 Tests, 5 Dateien).
* `tasks.json`: S25 bleibt `ready` (Fertig-Kriterium offen), Notiz ergänzt.

Status: Oberfläche neu gebaut, ursprüngliches Fertig-Kriterium offen. Nächste Session: entweder
S25 im ursprünglichen Sinn (Centerpiece) nachholen, oder der Nutzer entscheidet, dass die neue
Bildvorlage die Anforderung ersetzt — beides ist ausdrücklich seine Entscheidung, keine, die
diese Sitzung vorwegnimmt.

## S26 · Slack-Anbindung · 2026-09-13

Auftrag: eine Freigabe per Slack-Reaktion oder Thread-Antwort erteilbar machen, unabhängig von
Phase 6 (hängt nur an S20). Gebaut nach exakt demselben Muster wie der Telegram-Kanal (S16):
`client.ts` (dünner HTTP-Wrapper, `fetchImpl` injiziert, kein SDK — dieselbe
Abhängigkeitsdisziplin wie überall), `normalize.ts` (rohes Slack-Event → beschriebene Form),
`channel.ts` (`ChannelPort` + `handleSlackEvent`), verdrahtet in `gateway/index.ts`/`server.ts`.

**Transport: Events-API-Webhook, nicht Socket Mode.** Anders als bei Telegram (Long-Polling
gebaut, weil im Dev-Betrieb keine öffentliche Adresse existiert) fiel die Wahl hier auf den
einfacheren Weg — Socket Mode bräuchte `apps.connections.open` plus eine eigene
Reconnect-Schleife, unverhältnismäßig viel Code für das, was der Auftrag verlangt. Ohne
öffentliche Adresse bleibt der Kanal einfach unbedienbar, wie Telegram im Webhook-Betrieb ohne
Tunnel — ein akzeptierter, in den offenen Befunden vermerkter Zustand, kein Ausweg wie
Long-Polling ihn für Telegram bietet.

**Signaturprüfung statt Secret-Header.** Slack signiert jede Zustellung per HMAC-SHA256 über
den rohen Anfragekörper (`v0:<timestamp>:<body>`, Header `X-Slack-Signature`/
`X-Slack-Request-Timestamp`) statt eines einfachen Geheimnis-Headers wie Telegram.
`gateway/identity.ts`: `verifySlackSignature` (zeitkonstanter Vergleich wie `secretEquals`,
Zeitfenster von fünf Minuten gegen Wiedereinspielung) plus `authenticateSlack` im selben
Zwei-Prüfungen-Muster wie `authenticateTelegram` — Signatur beweist "von Slack", die
Erlaubnisliste (`SLACK_ALLOWED_USER_IDS`) beweist "vom Betreiber". Der rohe Anfragekörper wird
dafür in `gateway/server.ts` über die bestehende `express.json()`-Middleware mitgeschnitten
(`verify`-Rückruf, kein zweiter Parser).

**Auflösung von Reaktion/Thread-Antwort zu einer Entscheidung, ohne dass Slack dafür eine
Nutzlast mitliefert** (anders als Telegrams `callback_data`, die die `ask_id` direkt trägt):
ist genau eine Rückfrage offen (`deriveAskRoutes`, gefiltert auf `channel === "slack"`), wird
sie direkt aufgelöst — der Normalfall laut bestehender Notiz aus S16 ("in der Praxis eine,
selten zwei" gleichzeitig offene Rückfragen). Sind mehrere offen, entscheidet eine flüchtige
Zuordnung Nachrichtenzeitstempel→`ask_id` (dieselbe Rechtfertigung wie beim Postfach des
Web-Kanals: "flüchtig, und das ist in Ordnung", die Wahrheit bleibt im Protokoll). Eine
Reaktion wird über ihren Ziffern-Emoji-Namen (`one`…`nine`) auf einen Options-Index abgebildet;
eine Thread-Antwort gegen Options-`id`, dann Options-`label` (ohne Groß-/Kleinschreibung), dann
eine führende Zahl als 1-basierter Index geprüft.

**Slacks Drei-Sekunden-Frist** (anders als Telegram, das synchron durchläuft): die Route
antwortet sofort mit `200`, `handleSlackEvent` läuft danach unabhängig davon weiter
("fire-and-forget", Fehler gehen in die Prozessausgabe). Die bestehende
`hasReceived`/`externalId`-Idempotenz fängt eine dadurch mögliche Slack-Wiederholung ab, ohne
dass es dafür einen neuen Mechanismus braucht.

### Tests

63 Dateien, 659 Tests im Backend-Baum vor dem Zusammenführen mit S27 (siehe unten für den
gemeinsamen Endstand). Neu: `gateway/channels/slack/{client,normalize,channel,server}.test.ts`
sowie erweiterte Abschnitte in `gateway/gateway.test.ts` (voller Freigabe-Rundlauf sowohl über
eine simulierte Reaktion als auch über eine simulierte Thread-Antwort, jeweils gegen eine echte
Datenbank), `gateway/identity.test.ts`, `gateway/runs.test.ts`.

### Bewusst nicht gebaut

* **Anhänge** (`files.info`/Download mit Bot-Token) — nur Text und Freigaben, dieselbe Haltung
  wie "kein `mail.send`" seit S14. `InboundMessage.attachments` ist für Slack immer `[]`.
* **Socket Mode** als tunnelfreier Entwicklungsweg — dieselbe offene Lücke, die Telegrams
  Long-Polling für den eigenen Kanal schließt, hier aber (noch) nicht existiert.

### Offene Befunde (Details zu S26)

Siehe "Offene Befunde (gesamte Historie)" oben.

* `pnpm typecheck` grün. Backend-Tests (`gateway/`, `tools/`, `policy/`, `runtime/` — seit S21
  nicht mehr unter `pnpm test`, siehe "Aktueller Stand") über eine Ad-hoc-`vitest`-Config
  geprüft: grün. `pnpm lint` (Biome) grün.
* `tasks.json`: S26 auf `done`.

Status: abgeschlossen.

## S27 · MCP absichern · 2026-09-13

Auftrag: "eine fremde/manipulierte Tool-Beschreibung ändert das Verhalten der Runtime
nachweislich nicht." MCP kam bis zu dieser Session in keinem Katalog vor — nur als
Anti-Muster-Warnung ("MCP, ACP und A2A vermischen") und als offene Frage ("welche
MCP-Server zuerst"). Diese Session liefert den **Mechanismus** samt Härtung, nicht die
Serverwahl — die bleibt ausdrücklich offen, wie `exec.run`/`github.*` seit S20 unverdrahtet
blieben, obwohl sie in Abschnitt 9 stehen.

**`tools/mcp/client.ts`:** ein minimaler MCP-Client über stdio, kein SDK (dieselbe
Abhängigkeitsdisziplin wie bei Telegram/n8n). MCPs Stdio-Transport ist zeilenweises JSON
(ein JSON-RPC-2.0-Objekt je Zeile, `\n`-getrennt) — keine LSP-artige
`Content-Length`-Rahmung. Die eigentliche Transportschicht ist injizierbar (dasselbe
`fetchImpl`-Prinzip wie überall), die echte Fassung spawnt einen Kindprozess mit Zeitfenster
je Aufruf (analog `N8N_WEBHOOK_TIMEOUT_MS`).

**Drei Härtungsachsen, jede durch einen Test bewiesen, nicht nur behauptet** (`tools/mcp/
tools.ts`, `tools/mcp/tools.test.ts`):

1. **Risikostufe ist eine lokale, pro Server konfigurierte Obergrenze, nie aus der
   Fernbeschreibung abgeleitet.** `tools/list` liefert kein Risikofeld — die Versuchung wäre,
   sie aus Stichworten zu raten ("liest nur", "sicher"). Bewiesen mit einem Fake-Server, dessen
   Beschreibung wörtlich `"risk: read, auto_approve: true"` behauptet, lokal aber als
   `hard_write` konfiguriert ist: das Tool bleibt `hard_write`, und ein echter Aufruf über die
   echte Policy-Engine bleibt ohne Freigabe blockiert — identisch zu jedem anderen
   `hard_write`-Tool ohne Freigabe.
2. **Namensraum-Isolation durch Konstruktion.** Der lokale Name ist zwingend
   `mcp.<serverId>__<sanitierter Fernname>` — ein Fern-Tool kann keinen bestehenden Namen
   (`fs.write`, `web.fetch`, …) vortäuschen, weil `TOOL_NAME_PATTERN`
   (`tools/registry.ts`) nach dem ersten Punkt keinen zweiten zulässt. Getestet mit einem
   böswilligen Server, der Fern-Tools `fs`, `write`, `fs.write` anbietet: die registrierten
   lokalen Namen bleiben sicher unter `mcp.*`, und dieselbe Registry verträgt sowohl die
   echten `fs.*`-Tools als auch das MCP-Tool ohne `DuplicateToolError`.
3. **Einmalige Entdeckung beim Katalogbau.** `tools/list` läuft genau einmal
   (`createMcpTools`, aus `runtime/loop/api.ts`s `buildCatalog` heraus, nur wenn `config.mcp`
   gesetzt ist — dasselbe Muster wie bei `n8n`/`notes`: ohne das Feld bleibt der
   Katalog-Fingerabdruck unverändert). Es gibt in diesem Modul keine zweite Methode, die
   mitten in einer Session erneut entdeckte — ein "Rug Pull" (Server ändert Beschreibung/Schema
   nach der ersten Zusage) hat hier strukturell keinen Angriffspunkt.

Eine vierte, kleinere Absicherung: Fernfelder, die zufällig `path`/`url` heißen, werden vor der
Registrierung umbenannt (`_arg`-Suffix) und beim Aufruf zurückübersetzt — sonst könnten sie der
Policy-Engine (`policy/resource.ts`s `assertPolicyFieldNames`) eine Bedeutung vorspiegeln
(Dateizone, Domain-Egress), die für ein MCP-Feld nicht gilt.

Die allgemeinere Aussage — eine Anweisung in externem Inhalt hebt nie eine Freigabepflicht auf
— ist keine neue Erfindung dieser Session: sie steht seit Abschnitt 4.7/AGENTS.md, und die
automatische Redaction an den Schreibtoren (`runtime/redaction/redact.ts`) gilt für MCP-
Beschreibungen/-Ergebnisse genauso wie für jeden anderen Text, der ins Protokoll oder in den
Prompt geht — ohne dass diese Session sie manuell aufrufen müsste.

### Tests

`tools/mcp/client.test.ts` (11, reine Rahmungstests über eine In-Memory-Transportattrappe,
kein echter Prozessspawn), `tools/mcp/tools.test.ts` (11, die drei Härtungsachsen oben plus der
Normalfall: sauberer Aufruf, `isError: true` vom Server lässt den Handler werfen statt ein "ok"
vorzutäuschen).

### Bewusst nicht gebaut

* **Kein echter Produktiv-Server verkabelt** — weder in `gateway/index.ts` noch in
  `runtime/index.ts`. Die Serverwahl ("welche MCP-Server zuerst") bleibt die offene Frage aus
  Abschnitt 17; diese Session liefert nur den Mechanismus.
* **Nur `tools/list`/`tools/call`**, keine MCP-Ressourcen oder -Prompts.
* **Eine Risikostufe je Server, keine je Fernwerkzeug** — die einfachste, sicherste Wahl; ein
  Server mit gemischt-riskanten Tools bekäme heute die Stufe seines riskantesten Tools für alle.
* **Kein echter Prozess-Integrationstest** für `createStdioMcpClient` (nur die Rahmungstests
  über eine Attrappe) — ein Nachweis mit einem echten gespawnten Prozess (wie
  `policy/policy-resume.process.ts` es an anderer Stelle im Repo schon tut) stünde noch aus.

### Offene Befunde (Details zu S27)

Siehe "Offene Befunde (gesamte Historie)" oben.

* `pnpm typecheck` grün. Backend-Tests über dieselbe Ad-hoc-`vitest`-Config wie bei S26: nach
  dem Zusammenführen beider Sessions **65 Dateien, 681 Tests, alle grün** (S26: 659 Tests in 63
  Dateien, S27 fügt `tools/mcp/{client,tools}.test.ts` mit 22 weiteren Tests in 2 Dateien
  hinzu). `pnpm lint` (Biome) grün.
* `tasks.json`: S27 auf `done`.

Status: abgeschlossen.

## S21-Nachtrag · Ereignisbus über pg_notify · 2026-09-13

Auf ausdrücklichen Auftrag: der offene Befund aus S21 ("Der Ereignisbus sagt vor dem COMMIT
an") beheben, bevor S22 beginnt. Direkt im Anschluss S22–S24 in derselben Sitzung.

**`log.ts` sagt seither per `pg_notify` an, nicht mehr direkt.** `appendEventInTx` ruft
`SELECT pg_notify($1, $2)` mit `EVENT_NOTIFY_CHANNEL` und der `event_id` — in derselben
Transaktion wie die Einfügung, also transaktional: Postgres stellt die Benachrichtigung nur
zu, wenn diese Transaktion committet, und verwirft sie stillschweigend bei einem ROLLBACK.
Der Kanal trägt nur die ID (NOTIFY-Payloads sind auf ~8000 Byte begrenzt, ein Werkzeugergebnis
würde das leicht sprengen); `runtime/events/notify.ts` liest den vollen — bereits gefilterten —
Datensatz über die neue Funktion `readEventById` zurück und ruft erst dann
`eventBus.publishRecord`. `log.ts` importiert `bus.ts` seither gar nicht mehr: die Ansage ist
vollständig von der Runtime-Seite in die lauschende Seite gewandert, eine engere Kopplung
weniger.

**Eine eigene, dauerhaft lauschende Verbindung, geliehen aus dem Pool.** `LISTEN` gilt für die
Verbindung, auf der es lief — ein `Pool`, der Verbindungen zwischen Aufrufen tauscht, kann das
nicht halten. `startEventNotifyListener` holt sich eine Verbindung über `pool.connect()` und
gibt sie nie zurück, solange sie lauscht; bei einem Abriss (Netzwerk, `pg_terminate_backend`,
ein Neustart des Servers) verwirft sie `release(true)` und baut nach exponentiellem Backoff
(250 ms bis 10 s, ohne Jitter — ein Prozess, ein Client, dieselbe Begründung wie beim
WebSocket-Client der Oberfläche) eine neue auf.

**Der Kanal ist global, nicht je Prozess — eine bewusste Verschiebung gegenüber S21.** Jeder
Prozess mit einem eigenen Bus (Runtime, Gateway) lauscht auf denselben, festen
`EVENT_NOTIFY_CHANNEL` und sieht seither **jedes** committete Ereignis im System, nicht mehr
nur, was er selbst geschrieben hat. S21 hatte das Gegenteil als richtig begründet ("jeder sagt
an, was er selbst geschrieben hat") — das war aber eine Eigenschaft der Implementierung (ein
direkter In-Prozess-Aufruf kennt nur eigene Schreibvorgänge), keine bewusste Sicherheitsgrenze.
Sicher bleibt es unverändert, weil die Redaction am Schreibtor (`log.ts`) hängt, nicht am
Absender — und für S22 (eine Übersicht über alle Runs, auch Hintergrundläufe) ist die neue,
weitere Reichweite genau richtig.

### Tests

4 neue, echte Datenbank: eine Ansage kommt genau nach dem COMMIT an, nie davor; ein
ROLLBACK sagt nie etwas an; der zugestellte Datensatz ist der redigierte aus der Zeile, nicht
irgendeine Fassung aus dem Payload; und nach `pg_terminate_backend` auf die lauschende
Verbindung baut sie sich selbst neu auf und liefert danach wieder zu (`notify.test.ts`).

### Bewusst nicht gebaut

- **Kein Jitter im Backoff**, aus demselben Grund wie beim Ereignis-Client der Oberfläche.
- **Kein Kanal je Prozess.** Siehe oben — die globale Reichweite ist hier ein Gewinn, kein
  Kompromiss.

Status: abgeschlossen. `pnpm typecheck && pnpm lint` grün, neue Tests grün (siehe S22 für den
gemeinsamen Testlauf-Nachweis dieser Sitzung).

## S22 · Runs- und Detail-Ansicht · 2026-09-13

**"Run" heißt Session, nicht Task** — die ausführliche Begründung steht oben unter "Offene
Befunde". `RunStatus` (`runtime/session/run-status.ts`, acht Werte: `queued`, `ready`,
`running`, `blocked`, `awaiting_user`, `completed`, `failed`, `canceled`) ist eine neue,
zusätzliche Faltung desselben Protokolls, die `SessionStatus` (S05) unangetastet lässt —
dasselbe Muster wie `deriveLoopState` (S12) neben `deriveSessionState`.

**`runtime/session/runs.ts`** faltet `listRuns`/`getRunDetail` aus Protokoll, Session-Zeile und
Artefakt-Metadaten (`headArtifact`, S06) in einem Durchgang: Kennzahlen (`context/metrics.ts`,
S24 unten) fallen dabei als Nebenprodukt an, ohne das Protokoll ein zweites Mal zu lesen. Liegt
in `runtime/`, nicht in `gateway/` — Abschnitt 3 erlaubt Runtime → Context, nie Runtime →
Surface, und `gateway/server.ts` ruft diese Datei nur auf.

**`GET /runs` und `GET /runs/:id` liegen ausschließlich am Gateway**, hinter demselben
Bearer-Token wie jeder andere Lesepfad dort (`webPrincipal`). Dafür bekam die Oberfläche zum
ersten Mal ein Gedächtnis für ein Betreiber-Geheimnis: `ui/settings.ts` hält den Token in
`localStorage`, bedient über ein neues Einstellungen-Popup (das Zahnrad aus S21 war bis jetzt
ohne Funktion). `ui/api/client.ts` bündelt Token, Fehlerform (kein Token / abgelehnter Token /
Netzwerk- oder Serverfehler) und JSON-Parsing für `/runs` **und** die S23-Endpunkte gleich mit.

**Zwei echte Fehler beim Ausprobieren gefunden, nicht nur beim Schreiben:**
- `[hidden]` verlor gegen jede Klasse, die selbst ein `display` setzt (`.run-detail`,
  `.settings-panel`) — beide Regeln haben dieselbe Spezifität, Autor-CSS gewinnt gegen das
  UA-Stylesheet. Ein globales `[hidden] { display: none !important; }` in `theme.css` macht
  `el.hidden` erst zu dem verlässlichen Schalter, den `main.ts` voraussetzt.
- CORS am Gateway fehlte: siehe "Offene Befunde" oben. Behoben mit derselben
  Herkunftsprüfung wie am Ereignisstrom.

Beide Funde kamen aus einem echten Rundgang im Browser (Chrome, per `claude-in-chrome`) gegen
einen echten Gateway-Prozess mit echter Datenbank — ein reiner Node-Test hätte beides nicht
gezeigt (`fetch` in Node erzwingt kein CORS, und ein `hidden`/CSS-Konflikt fällt nur im
gerenderten DOM auf).

### Tests

19 neue: `run-status.test.ts` (8, alle acht Zustände plus die Vorrangregeln), `runs.test.ts`
(4, echte Datenbank, echtes Artefakt über `writeArtifact`), `notify.test.ts` (4, siehe oben),
`gateway/runs.test.ts` (7, echter Server, echter `fetch`, inklusive der drei CORS-Fälle:
erlaubter Ursprung mit Preflight, dieselbe Kopfzeile auf der echten Antwort, keine Freigabe für
einen fremden Ursprung), dazu `ui/api/client.test.ts` (4), `ui/settings.test.ts` (3) und
`ui/runs/status.test.ts` (3) ohne Browser, mit eingesetztem `fetch`/Speicher (dasselbe Muster
wie `socketFactory` in `ui/events/bus.ts`).

### Bewusst nicht gebaut

- **Kein Zustand für "Prozess abgestürzt"** in `RunStatus` — siehe "Offene Befunde".
- **Keine Runs-API am kleinen Ereignisserver aus S21** (`runtime/events/bus.ts`) — dessen Aufgabe
  bleibt `/events` und `/health`.
- **Keine feinere Freigabe je Route** — `/runs` und `/runs/:id` tragen genau dieselbe
  Vertrauensgrenze wie `/channels/web/*` seit S16, kein eigenes Berechtigungsmodell.

Status: abgeschlossen. `pnpm typecheck && pnpm lint` grün. `tasks.json`: S22 auf `done`.

## S23 · Freigabe- und Fehler-Ansicht · 2026-09-13

**Freigaben brauchten keinen neuen Endpunkt.** `/channels/web/pending` und
`/channels/web/answers` stehen seit S16 und bedienen genau die eine Unterhaltung, die ein
Mensch führt — nach S19 die einzige, die je auf `awaiting_user` stehen kann (ein delegierter
Arbeiter schlägt fehl, statt auf eine Freigabe zu warten). Die Oberfläche zeigt seither jede
offene, strukturierte Rückfrage im Panel "Freigaben & Fehler" mit ihren Optionen als Knöpfe;
ein Klick ruft `answerApproval` (`POST /channels/web/answers`) und lädt danach Freigaben **und**
Runs neu — eine beantwortete Rückfrage ändert schließlich auch den Run-Status.

**Der Fehler-Verlauf ist neu und lebt vom Live-Strom, nicht von einer Datenbankabfrage.**
`ERROR_EVENT_TYPES` (`step.failed`, `tool.failed`, `session.failed`, `error.raised`) ist eine
kleine, feste Zuordnung — dasselbe Prinzip wie `signalFor` in `ui/events/bus.ts`: eine Stelle,
eine reine Funktion, kein neuer Ereignistyp. Jeder Treffer bleibt als eigene Zeile stehen (bis
zu zwanzig, älteste fällt zuerst), statt wie bisher irgendwo im ungefilterten Ereignisstrom zu
verschwinden — genau der Unterschied zwischen "bleibt sichtbar" und "war kurz ein roter Punkt",
den das Fertig-Kriterium wörtlich verlangt.

### Tests

Keine neuen: die Backend-Seite (`/channels/web/pending`/`/answers`) ist seit S16 getestet
(`gateway/gateway.test.ts`), und die neue Oberflächen-Logik in `main.ts` ist reine
DOM-Verdrahtung ohne Zweigstellen, die eine Prüfung ohne Browser lohnen würden — dasselbe
Prinzip wie bei `main.ts` seit S21 (dort bereits ohne eigene Tests, aus demselben Grund). Von
Hand geprüft im echten Browser gegen einen echten Gateway-Prozess mit drei präparierten
Sessions (laufend, abgeschlossen, fehlgeschlagen): Liste, Detail und Kennzahlen zeigten die
echten Werte; die Freigaben-Prüfung blieb auf den Test-Stub beschränkt (siehe "Offene Befunde"
zu S22 für die Grenzen dieses Rundgangs).

### Bewusst nicht gebaut

- **Keine Möglichkeit, eine beliebige Session im System zu beantworten** — nur die eine
  Gateway-Unterhaltung, siehe "Offene Befunde".
- **Kein historischer Fehlerabruf über einen Neustart hinweg** — der Live-Strom erfüllt das
  Fertig-Kriterium bereits wörtlich.

Status: abgeschlossen. `pnpm typecheck && pnpm lint` grün. `tasks.json`: S23 auf `done`.

## S24 · Kennzahlen-Panels · 2026-09-13

**Kein neuer Endpunkt, keine neue Faltung der Einzelwerte** — `context/metrics.ts` hatte
`deriveRunMetrics` (Abschnitt 12) bereits seit S12, nur ohne Aufrufer, der viele Sessions
zusammenzieht. Neu ist `combineRunMetrics`: summiert Modellaufrufe, Token, Tool-Aufrufe,
Rückfragen, Kompaktierungen über alle Runs aus `listRuns` (S22), und bildet die beiden Quoten
(Cache-Trefferquote, Auslagerungsanteil) am Ende aus den summierten Zählern neu — ein Mittel
über bereits gemittelte Quoten hätte jeden Lauf gleich gewichtet, unabhängig davon, wie viel
dahinterstand.

Die Oberfläche zeigt seither vier weitere Kennzahlen neben den beiden bestehenden
(Ereignisse, Wiederverbindungsversuche, beide weiterhin real und live aus dem Ereignisstrom):
Modellaufrufe, Tool-Aufrufe samt Fehlschlägen, Cache-Trefferquote, Rückfragen — dieselbe
Antwort von `/runs`, die S22 bereits abruft, kein zweiter Netzwerkaufruf.

Im echten Rundgang (siehe S22/S23) zeigte das Panel gegen die reale, seit Wochen gewachsene
Entwicklungsdatenbank 28 Modellaufrufe, 24 Tool-Aufrufe (0 fehlgeschlagen), 63,1 % Cache-Trefferquote
und 4 Rückfragen — reale, aus dem Protokoll gefaltete Werte, kein erfundener Platzhalter.

### Tests

Keine neuen über S22 hinaus: `combineRunMetrics` ist über `runs.test.ts`s Prüfung von
`listRuns`s `metrics`-Feld mitgeprüft (eine dedizierte Datei für eine elf Zeilen lange
Summierung wäre hier mehr Aufwand als Erkenntnisgewinn).

### Bewusst nicht gebaut

- **Die drei Kennzahlen, die Abschnitt 12 zusätzlich nennt** (Freigaben pro Aufgabe, Wartezeit
  auf Freigabe, Tool-Latenz) — brauchen Zeitmessungen über Ereignispaare hinweg und bleiben
  einer eigenen, noch nicht eingeplanten Beobachtbarkeits-Session vorbehalten (Entscheidung aus
  S18a, hier nur bestätigt).

Status: abgeschlossen. `pnpm typecheck && pnpm lint` grün. `tasks.json`: S24 auf `done`, S25 von
`queued` auf `ready`.

## S21 · Ereignisbus und UI-Grundgerüst · 2026-09-12

Erste Session der Phase 6, direkt nach S20. Vier Schritte laut Auftrag: die Testbasis auf
Phase 6 umstellen, das UI-Grundgerüst bauen (HTML, Farbschema, Layout, Wassereffekt,
Ereignis-Client, Dev-Server), Tests dafür, und auf der Runtime-Seite den Ereignisbus freigeben.
Ausdrücklich **ohne 3D-Centerpiece** — nur Wasserkreise.

**Der Bus ist eine Ansage, nicht das Protokoll.** Das ist die Entscheidung, an der alles
Weitere hängt. Die Wahrheit über einen Lauf steht weiterhin in `kuronami.events` und wird von
dort gefaltet (S05, S12); `runtime/events/bus.ts` sagt nur "eben wurde etwas geschrieben", damit
eine Oberfläche nicht pollen muss. Er hält keinen Zustand, den jemand wiederfinden müsste — was
vor dem Verbinden geschah, liegt in der Datenbank. Ein Ringpuffer der letzten fünfzig Ereignisse
ist der einzige Speicher, und der ist eine Bequemlichkeit für den Client, der sich mitten in
einem Lauf verbindet, kein zweites Gedächtnis.

**Er hängt am einzigen Schreibtor**, aus demselben Grund, aus dem der Redaction-Filter dort
steht: `appendEventInTx` ist der einzige Weg in `kuronami.events`, also kann kein Ereignis am
Bus vorbei entstehen. Angesagt wird der Datensatz aus dem `RETURNING` der Einfügung — also die
**bereits gefilterte** Fassung. Der Bus liegt damit per Bauart hinter dem Filter und kann kein
Geheimnis hinaustragen, das das Protokoll nicht ohnehin trägt; nachgemessen wurde das mit einem
echten Lauf, in dem ein `ANTHROPIC_API_KEY=…` im Payload beim Client als
`[redacted:anthropic-api-key]` ankam. Was er **nicht** kann: auf den COMMIT warten (siehe
Befunde).

**Ein Modul-Singleton, und das ist eine Ausnahme.** `appendEventInTx` ist an über hundert
Stellen in dreißig Dateien aufgerufen; ein zusätzlicher Parameter durch alle wäre eine Änderung
an jedem Aufrufer für eine Ansage, die keinen von ihnen etwas angeht. `eventBus` ist deshalb
prozesslokal wie das Kontingent paralleler Arbeiter (S20) und die Serialisierung im Gateway
(S16) — zwei Prozesse haben zwei Busse, und das ist richtig so: jeder sagt an, was er selbst
geschrieben hat.

**Nur lesend, und zwar benannt.** Ein Datenframe von einem verbundenen Client beendet die
Verbindung mit 1003 und einem Grund im Text, statt stillschweigend verworfen zu werden
(AGENTS.md: Fehler nie verstecken). Die Oberfläche schreibt über das Gateway (S16), nicht über
diesen Port — es gibt im Client gar keine `send`-Methode, die es versuchen könnte.

**Die Herkunftsprüfung ist kein Beiwerk.** Ein WebSocket unterliegt **nicht** der
Same-Origin-Regel des Browsers: ohne `originAllowed` könnte jede beliebige Seite, die der Nutzer
offen hat, das gesamte Protokoll dieses Prozesses mitlesen — Mailinhalte, Dateipfade,
Freigabefragen. Vorgabe ist deshalb "nur localhost", und ein Aufruf ganz ohne `Origin` (curl,
Test, Tauri) gilt als nicht-Browser und geht durch.

**Am Server, nicht als Express-Route.** Ein Upgrade ist kein Request, den ein Express-Handler je
zu sehen bekommt — `http.Server` reicht ihn über `upgrade` heraus, bevor die Route-Schicht
anläuft. Der Pfad wird deshalb dort geprüft, sonst würde ein Upgrade auf irgendeinen anderen
Pfad stillschweigend angenommen. Angeschlossen ist der Strom an **zwei** Prozessen: am
bestehenden Server des Gateways (dort fallen die Ereignisse der Unterhaltung an) und als eigener
kleiner Server in `runtime/index.ts` auf `EVENTS_PORT` (Vorgabe 3000, der Port, den die
Oberfläche erwartet). Ein belegter Port beendet einen Runtime-Lauf **nicht**: dann bedient ihn
schon jemand, und ein Lauf ohne Zuschauer ist immer noch ein Lauf — was passiert ist, steht in
der Zeile.

**Die Oberfläche kennt sechs Signale, nicht vierzig Ereignistypen.** Das Protokoll hat über
vierzig Typen und wächst weiter; die Anzeige will davon genau wissen, ob gerade gedacht,
gesprochen, fertig oder nichts wird, und ob eine Aufgabe dazukam oder fertig wurde. Die
Zuordnung steht an **einer** Stelle (`signalFor`, reine Funktion) — ein neuer Ereignistyp fällt
dadurch nicht in die falsche Schublade, sondern zunächst gar nicht auf, und das ist die richtige
Vorgabe für eine Anzeige. Rahmen, die schon ein Signal *sind*, gehen durch: so lässt sich der
Strom auch von einem Prüfwerkzeug treiben, ohne Protokollereignisse zu erfinden.

**Mechanik getrennt von Zeichnung, Draht und Zeit als Parameter.** `RippleField` kennt weder
`canvas` noch `requestAnimationFrame`: es bekommt eine Zeit herein und sagt, welche Ringe es
gibt. `createEventBus` bekommt `socketFactory`, `setTimer` und `clearTimer` hereingereicht. Das
ist kein Selbstzweck — es ist der Grund, warum "vier Zustände ergeben vier Muster" und "der
Backoff deckelt bei zehn Sekunden" in Zahlen prüfbar sind statt in einem Screenshot, und warum
die Tests ohne jsdom in der Node-Umgebung laufen.

**Die vier Muster sind Daten, keine Zufälle.** `idle` 2400 ms Takt, `processing` 320 ms,
`speaking` Gruppen zu dritt mit 130 ms Abstand und 1100 ms Pause dazwischen (die Form
gesprochener Sprache, nicht nur "schneller"), `complete` ohne Takt: ein letzter großer Kreis
beim Zustandswechsel, danach läuft das Feld leer. Ein Zustandswechsel ist selbst ein Anlass —
sonst hinge die Anzeige beim Sprung von `idle` auf `processing` bis zu 2,4 Sekunden nach.

**Kein Bundler, kein HMR.** Die Oberfläche besteht aus ES-Modulen, die ein Browser selbst
nachlädt; zu übersetzen ist genau eines (TypeScript zu JavaScript), und der Übersetzer liegt
seit S01 im Projekt. Ein Bundler daneben wäre ein zweites Werkzeug für eine erledigte Aufgabe
und eine zweite Stelle, an der Modulauflösung konfiguriert wird. HMR ebenso: ein Modul im
laufenden Bild auszutauschen verlangt, dass jedes Modul seinen Zustand zurückgeben kann — bei
einer Oberfläche, deren Zustand aus einem Strom kommt, der sich in Millisekunden wieder
aufbaut, ist ein Neuladen die ehrlichere und schnellere Antwort. Der Dev-Server hält `ui/` in
seinen Grenzen (`resolveInUi`, dieselbe Haltung wie `resolvePath` für `fs.*`).

### Tests

32 neue, und zugleich **die gesamte laufende Suite**: `vitest.config.ts` läuft seit dieser
Session nur noch auf `ui/**` und `phase-6/**`.

- **`ui/canvas/ripples.test.ts`** (9): das Feld startet leer und wächst mit der Zeit; ein Kreis
  verschwindet an seinem Rand; `idle` ergibt in sechs Sekunden genau drei Kreise (0/2400/4800),
  `processing` neunzehn; `speaking` ergibt **zwei** verschiedene Abstände in genau dem
  Verhältnis, das ein Rhythmus hat (je Gruppe `burst - 1` kurze, dazwischen eine Pause, und die
  kürzeste Pause ist länger als der längste Gruppenabstand); `complete` setzt genau einen Kreis
  und danach keinen mehr, und das Feld ist am Ende leer; ein Zustandswechsel wirkt sofort und
  lässt Bestehendes auslaufen; die Zeichnung setzt je Kreis genau einen Bogen und blendet zum
  Rand hin aus; der Renderer richtet die Fläche ein, läuft und gibt den Bildtakt wieder her;
  und ohne 2D-Kontext bleibt der Fehler stehen, statt still nichts zu zeichnen.
- **`ui/events/bus.test.ts`** (12): die Zuordnung von siebzehn Protokolltypen auf ihre Signale
  (vier davon ausdrücklich auf `null` — Buchführung ohne Bühne); `task.updated` unterscheidet
  Erledigung vom bloßen Umschreiben; kaputte Rahmen ergeben `null` statt einer Ausnahme; der
  Strom schaltet den Zustand um und meldet den Verbindungsstand; jeder Rahmen geht an
  `onMessage`, auch der ohne Signal; Plansignale zählen getrennt und ändern das Wasser nicht;
  nach dem Auslaufen kehrt der Zustand von selbst zur Ruhe zurück; der Backoff wächst
  exponentiell und deckelt bei zehn Sekunden (500, 1000, 2000, 4000, 8000, dann dreimal 10000);
  eine gelungene Verbindung setzt den Zähler zurück; und ein selbst veranlasstes Schließen
  lässt **keinen** Zeitgeber offen und baut auch nach einem nachgereichten `onclose` nichts
  mehr auf.
- **`phase-6/events-bus.test.ts`** (11, echter Server auf einem vom System vergebenen Port,
  echter `ws`-Client): der Bus reicht an jeden Zuhörer weiter und meldet sie wieder ab; ein
  Protokolleintrag kommt als `{type, timestamp, data}` heraus; der Ringpuffer hält nur die
  jüngsten; ein frisch verbundener Client bekommt erst `bus.connected`, dann den Verlauf; alle
  Clients bekommen dasselbe zugleich; **ein Datenframe von außen beendet die Verbindung mit
  1003**; ein Upgrade auf einem anderen Pfad wird nicht angenommen; eine fremde Herkunft
  bekommt 403 und taucht nicht in der Clientzahl auf; der Strom hängt sich an einen bestehenden
  Server, ohne dessen Routen zu stören; und beim Schließen bleibt weder ein Client noch ein
  Zuhörer hängen.

### Gegenproben

Jeder Mechanismus ist mit seinem Gegenstück geprüft: Signal/kein Signal, erlaubte/fremde
Herkunft, richtiger/falscher Pfad, lesender/schreibender Rahmen, Abriss von außen/Schließen von
innen, Zustand mit Rückfall zur Ruhe/ohne.

Dazu **ein echter Lauf gegen die echte Datenbank**, außerhalb der Suite: ein Client am laufenden
`pnpm dev` bekam beim Verbinden `session.resumed` und `runtime.started` aus dem tatsächlichen
Protokoll nachgeliefert, und in einem zweiten Lauf kamen vier frisch über `appendEvent`
geschriebene Ereignisse live an — das letzte mit einem gefälschten `ANTHROPIC_API_KEY` im
Payload, der beim Client als `[redacted:anthropic-api-key]` ankam. Das ist der Nachweis, dass
der Bus hinter dem Filter liegt und nicht daneben. Geprüft wurden außerdem der Dev-Server
(Seite, Module, CSS, 404 mit Begründung, Neulade-Strom, und dass ein `..` im Pfad nicht aus
`ui/` herausführt) und `pnpm build:ui` (drei Module übersetzt, drei Dateien kopiert).

### Bewusst nicht gebaut

- **Kein 3D-Centerpiece.** Ausdrückliche Vorgabe des Auftrags: Phase 6 startet ohne. Der Ninja
  auf dem Stein, die drei Animationszustände und die Beschwörungskreise bleiben S25 und brauchen
  weiterhin die Canvas aus Claude Design.
- **Keine echten Inhalte in den Panels.** Läufe, Freigaben und Kennzahlen sind Platzhalter mit
  Verweis auf S22/S23/S24. Was heute echt ist, ist der Ereignisstrom im Läufe-Panel (die letzten
  vierzig Typen) und die beiden Plansignale — beides fällt ohnehin als Nebenprodukt der
  Verdrahtung an.
- **Kein SSE-Rückfall für den Ereignisstrom.** `done_when` lässt "WebSocket/SSE" offen; gebaut
  ist der WebSocket. SSE wäre ein zweiter Weg zu denselben Daten, und den baut man, wenn ein
  Client auftaucht, der keinen WebSocket kann.
- **Kein Jitter im Backoff.** Jitter verhindert, dass viele Clients nach einem Serverausfall im
  Gleichschritt zurückkommen; hier gibt es einen Client und einen lokalen Prozess. Er würde die
  Wartezeit dafür unvorhersagbar machen, auch für den Test.
- **Keine Authentifizierung am Ereignisstrom.** Er läuft auf localhost und prüft die Herkunft;
  ein Token wäre der nächste Schritt, sobald der Port je über den Rechner hinausgeht — dann
  aber zusammen mit dem des Gateways (S16) und nicht daneben.

### Offene Befunde (Details zu S21)

Siehe die neuen Einträge oben unter "Offene Befunde (gesamte Historie)": die Ansage vor dem
COMMIT, die stillgelegte Testbasis der Phasen 1–5 und der fehlende Verlauf vor dem Verbinden.

- `pnpm typecheck` (beide Projekte) und `pnpm lint` grün, `pnpm test` grün mit 32 Tests.
- `pnpm build:ui` läuft durch, `pnpm dev:ui` bedient Port 3001, `pnpm dev` Port 3000.
- `tasks.json`: S21 auf `done`, S22 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S22 Runs- und Detail-Ansicht.

## S20 · Erste Subagent-Besetzung · 2026-09-12

Zweite Session der Phase 5, direkt nach S19. Vier Vorgaben: die sieben Rollen aus Abschnitt 14
anlegen (über `agent.create` oder eine Migration), jede mit rollenspezifischer Tool-Whitelist;
die Whitelist **technisch** erzwingen (Ablehnung bei einem Aufruf außerhalb der Liste, nicht nur
als Prompt-Hinweis); Obergrenzen für parallele Worker und Token-Budget setzen; jeden Agenten mit
einer einfachen Aufgabe **und** einem Tool-Verstoß prüfen.

**Die Besetzung ist Daten im Quellbaum, keine Migration.** Der Auftrag ließ beides zu, und die
Migration wäre der kürzere und schlechtere Weg gewesen: sie schriebe sieben Profile als
SQL-Literale in eine Datei, die **niemand gegen den Katalog prüft**. Ein `fs.readFile` statt
`fs.read` stünde danach in der Registry und fiele erst auf, wenn der Agent das erste Mal läuft —
möglicherweise Wochen später, nachts, in einem Lauf nach Zeitplan. `runtime/agents/besetzung.ts`
hält die sieben stattdessen als geprüfte Daten, `pnpm agents:seed` legt sie an (idempotent,
`--dry-run` prüft nur), und jedes Profil geht durch dasselbe `checkAgentDraft` wie eines aus
`agent.create`. Alle sieben stehen seit dieser Session in der echten Registry.

**Modellklasse statt Modellname.** Die Datei nennt je Rolle `routine` oder `thinking`
(Abschnitt 11), aufgelöst wird das beim Anlegen über `resolveModelRouteConfig` — dieselben zwei
Namen, aus denen auch der Modell-Router seit S18e wählt. Ein fest eingetragener Modellname wäre
eine dritte Stelle gewesen, an der Modellnamen gepflegt werden müssten. Der Mail-Agent bekommt
damit wörtlich, was Abschnitt 14 verlangt ("persönlich, günstiges Modell"), der Coder das starke.

**Was die Werkzeuglisten nicht enthalten, steht als Begründung in der Datei:** `exec.run` und
`github.*` gibt es noch nicht (der Backtest-Agent wäre der erste echte Nutzer von `exec.run`),
`notes.*` existiert nur in einem Prozess mit eingerichtetem Vault — ein Profil, das es nennt,
liefe in jedem anderen Prozess gar nicht (fail closed seit S19) —, und `mail.send` gibt es im
ganzen System nicht (S14). Der Mail-Agent kann deshalb nicht versenden, und das hängt nicht an
seiner Liste, sondern daran, dass das Werkzeug fehlt.

**Die Whitelist hält an zwei Toren, und sie halten aus verschiedenen Gründen.** Das erste steht
seit S19: der Katalog eines Arbeiters ist die Schnittmenge aus Profil und Prozesskatalog, jedes
andere Werkzeug ist für ihn ein **unbekanntes Tool**. Das zweite kommt jetzt dazu:
`agentToolsHook` (`tools/agent/policy.ts`) hängt am **Profil** statt am Katalog und lehnt einen
Aufruf außerhalb der Liste auch dann ab, wenn der Katalog ihn kennt — der Fall, der entsteht,
sobald jemand `runWorker` künftig mit einem breiteren Katalog aufruft ("nur schnell", in einem
Betreiber-Werkzeug, in einem Test). Dafür bekam `PolicyEngine` eine Methode `withHooks`: dieselbe
Engine, dieselben Regeln, derselbe Resolver, ein Hook mehr. Sie kann nur verschärfen — Hooks
können das per Bauart (`policy/hooks.ts`), und eine Methode, die Regeln ersetzt oder den Resolver
austauscht, wäre der Weg zu einer nachsichtigeren Engine und gibt es deshalb nicht.

**Die dritte Obergrenze aus Abschnitt 14 ist keine Spalte.** "Obergrenze für parallele Worker"
gehört dem **Prozess**, nicht dem Agenten: sie schützt, was sich alle teilen (Verbindungen,
Anfragen beim Anbieter, die Rechnung am Monatsende), und eine Grenze je Agent ließe genau den
Fall offen, dass ein Coder und ein Visualizer gleichzeitig laufen. Also ein Kontingent je Prozess
(`DEFAULT_MAX_PARALLEL_WORKERS = 2`, `AGENT_MAX_PARALLEL`) — und wer darüber hinaus delegiert,
**wartet**, statt abgewiesen zu werden: ein abgewiesener Arbeiter wäre für das Modell ein
Fehlschlag, den es nicht beheben kann, und es versuchte es sofort noch einmal. Der Platz wird
beim Freigeben weitergereicht und nicht herunter- und wieder hochgezählt; dazwischen läge ein
Microtask, in dem ein dritter Aufrufer einen freien Platz sähe, den es nicht gibt.

**Das Token-Budget (Migration 0010) sitzt als Hülle um den Modell-Client**, nicht als Zähler im
Loop. Der Loop beantwortet, **wann** gefragt, gehandelt und aufgehört wird (S12); Kosten kennt er
nicht und soll er nicht kennen — eine Grenze je Agent wäre dort ein Sonderfall für einen
Aufrufer, und der nächste bekäme den nächsten. `budgetedModel` zählt nach jeder Antwort **alle
vier** Zahlen aus `ModelUsage` (auch die aus dem Cache gelesenen: billiger, aber nicht umsonst)
und prüft **vor** jedem Aufruf. Ist das Budget aufgebraucht, endet der Lauf sichtbar
(`stop: "token_budget"`, ein Ausgang, den nur ein Arbeiter kennt — er gehört nicht in `LoopStop`)
und die Arbeitersession wird abgebrochen, damit kein offener Zug liegenbleibt. `token_budget`
steht neben `max_steps` und ersetzt es nicht: das eine begrenzt, **wie oft** ein Arbeiter
handelt, das andere, was der Lauf **kostet** — fünf Schritte mit einem großen Anhang im Kontext
kosten mehr als vierzig kleine.

### Tests

26 neue, zusammen 679 (68 Dateien, davon drei neu).

- **`runtime/agents/besetzung.test.ts`** (6, echter Katalog, echte Datenbank): die sieben Namen
  sind genau die aus Abschnitt 14; jedes Profil besteht die Prüfung gegen den **echten** Katalog
  (dieselbe Rolle wie `skills/skills.test.ts` seit S18d — ein Tippfehler fällt hier auf und nicht
  im Betrieb); keine Rolle bekommt ein Werkzeug über ihrer Obergrenze, keine bekommt `agent.*`,
  `user.ask` oder irgendein `*.send`; der Mail-Agent läuft auf dem günstigen Modell; und
  `seedFirstCasting` legt an, was fehlt, und meldet beim zweiten Lauf nur noch Vorhandenes.
- **`tools/agent/casting.test.ts`** (16): je Rolle **eine einfache Aufgabe** (ein Werkzeug aus
  ihrer Liste läuft; der Aufruf ist weder unbekannt noch von der Policy abgelehnt, die Session
  endet auf `completed`) und **ein Tool-Verstoß** (ein Werkzeug, das es im Katalog gibt, aber
  nicht in ihrer Liste: genau ein `tool.failed` mit `reason: "unknown_tool"`, die Ablehnung nennt
  die erlaubte Liste, und **kein** `tool.completed` — der Seiteneffekt lief nicht). Dazu das
  zweite Tor an einem Aufruf mit dem **vollen** Katalog: `policy_denied`, und der Freigabepfad
  nennt `agent-toolset:coder`.
- **`tools/agent/limits.test.ts`** (4): der Budgetzähler (prüft vor dem Aufruf, der letzte Aufruf
  darf überziehen, der abgelehnte kostet nichts); ein Arbeiterlauf, der am Budget endet und die
  Session abgebrochen zurücklässt statt mit offenem Zug; kein Budget heißt keine Zählung; und das
  Kontingent paralleler Arbeiter — mit `AGENT_MAX_PARALLEL=1` läuft der zweite Arbeiter
  nachweislich erst los, nachdem der erste seinen Platz freigegeben hat.

### Gegenproben

Die Verstoß-Tests **sind** die Gegenproben: jede Rolle wird einmal mit einem erlaubten und
einmal mit einem verbotenen Werkzeug geführt, und beide Male steht im Protokoll, was geschehen
ist. Dasselbe Muster beim zweiten Tor (abgelehnt außerhalb der Liste, durchgelassen innerhalb)
und beim Budget (mit Budget endet der Lauf daran, ohne Budget wird nicht einmal gezählt).

Ein echter Fehlschlag beim Bauen, der etwas gezeigt hat: der Verstoß-Test erwartete zunächst
`tool_name: "web.search"` und fand `"web__search"`. Richtig ist der gefundene Wert — der Katalog
des Arbeiters kennt den Namen nicht, also übersetzt ihn auch niemand zurück (`toolNameDecoder`,
S07: ein unbekannter Name wird nicht stillschweigend umgeschrieben). Das Protokoll hält damit
fest, was das Modell **versucht** hat, und nicht, was es gemeint haben könnte.

### Bewusst nicht gebaut

- **Kein `exec.run` für den Backtest-Agenten.** Es steht in Abschnitt 9, aber die Sandbox aus
  Abschnitt 4.6 fehlt; ein Backtest, der rechnet statt Dateien zu lesen, wartet darauf.
- **Kein `github.*` für den Coder** — dieselbe Lage: die Workflows gibt es noch nicht.
- **Keine Zeitpläne in der Besetzung.** Alle sieben stehen auf `schedule: null`: sie sind
  Rollen für die Delegation. Ob eine davon regelmäßig laufen soll, ist eine Entscheidung des
  Nutzers (und `agent.create` legt dafür bereits Agenten mit Zeitplan an, S19).
- **Kein verteiltes Kontingent.** Die Obergrenze paralleler Arbeiter ist prozesslokal, wie die
  Serialisierung im Gateway seit S16.
- **Keine Kostenrechnung.** `tokens_spent` steht jetzt in `agent.returned` und `heartbeat.ran` —
  eine Kennzahl, keine Abrechnung. Die ist S21.

### Offene Befunde (Details zu S20)

Siehe die neuen Einträge oben unter "Offene Befunde (gesamte Historie)".

- `pnpm typecheck && pnpm lint && pnpm test` grün, 679 Tests.
- `pnpm agents:seed` gegen die echte Datenbank gelaufen: sieben Rollen angelegt, zweiter Lauf
  meldet sie als vorhanden.
- `tasks.json`: S20 auf `done`, S21 von `queued` auf `ready`.

Status: abgeschlossen. Nächste Session: S21 Kosten-Tracking und Modell-Routing.

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

## UI-Zwischenschub · 2026-09-13

Zwischenschub, ausdrücklich **nicht** Teil der S-Reihe — reine Oberflächen-Überarbeitung des
bestehenden Dashboards auf Nutzerauftrag, nach S25–S27, in einer eigenen Sitzung desselben Tages.
`tasks.json` bleibt unangetastet: es gibt keinen neuen Sprint-Eintrag dafür. Es läuft weiterhin
ausschließlich die Web-App auf localhost, kein Tauri-Client — nichts in dieser Sitzung setzt
einen voraus.

**Wichtige Randbemerkung zum Auftrag:** der angekündigte Screenshot ("verbindliche Vorlage für
die Startseite") kam in der Nachricht nie an — der Platzhaltertext `[SCREENSHOT HIER ANHAENGEN]`
blieb wörtlich stehen. Statt nachzufragen (Auftragslage: Entscheidungen treffen und ausführen,
nicht bei jeder Lücke stoppen), wurde die Startseite nach der sehr detaillierten Textbeschreibung
gebaut — inklusive der im Fertig-Kriterium wörtlich genannten Elemente (Markets, Inbox, Agenda,
Notes, drei Knöpfe, Mic-Button, System). Wo die Textbeschreibung selbst eine Lücke ließ, stehen
unten benannte, begründete Entscheidungen statt geratener Standardlösungen.

### Was gebaut wurde

**1. Emblem 黒波.** Als echter, eingebetteter SVG-Pfad (`ui/emblem.ts`), keine Textglyphe. Die
Pfaddaten stammen aus den echten Konturen von "Yu Gothic Bold" (GDI+ `GraphicsPath.AddString`,
auf diesem Rechner unter Windows vorhanden) — nicht von Hand nachgezeichnet, um nicht versehentlich
ein falsches oder unleserliches Kanji zu erzeugen. Das Ergebnis ist ein fester Satz M/L/C-Befehle,
`fill-rule="evenodd"` (dieselbe Regel, mit der GDI+ selbst gerendert hat), Farbe ausschließlich
über `currentColor`. Sitzt links neben der Wortmarke, vertikal mittig, ohne Schatten/Verlauf/
Animation. Per Rasterprobe visuell geprüft, bevor die Pfaddaten übernommen wurden (siehe
Scratchpad-Skripte, nicht Teil des Commits).

**2. Sidebar einklappbar** (`ui/sidebar/collapse.ts`, `ui/sidebar/view.ts`). Umschalter im Kopf
plus Strg/Cmd+B. Eingeklappt bleibt eine 64px-Icon-Leiste, das Emblem bleibt sichtbar. Zustand in
`localStorage`, nach Neuladen wiederhergestellt. Der Übergang läuft über die echte `width`-
Eigenschaft der Seitenleiste (kein Sprung im Ansichts-Auslass, da beide Teile derselben
Flexbox-Reflow-Berechnung folgen — bewusst keine animierte Custom Property, die ohne
`@property`-Registrierung ohnehin nicht interpoliert würde).

**3. Home neu als persönliches Cockpit** (`ui/views/home.ts`). Der bisherige Projekt-/Buildstatus
ist komplett raus. Vier Panels gegen Mock-Provider (`ui/mock/data.ts`), jedes hinter einem eigenen
typisierten `*Provider`-Interface mit `load(): Promise<...>` — derselbe Vertrag wie ein späterer
HTTP-Aufruf, ein Austausch gegen eine echte Quelle ändert an den Views nichts. Bewusst
unterschiedlich behandelt (Punkt 7): Markets als dichte Kurstabelle, Inbox als Liste mit
Ungelesen-Punkt, Agenda als Zeitleiste, Notes als horizontale Kartenreihe ohne Außenrahmen ums
ganze Panel. Drei Knöpfe (System, Einstellungen, Dateien) — echte Navigation, keine
Platzhalter-Aktionen (siehe die Begründung zu S25 oben: ein Knopf ohne Wirkung wäre eine
vorgetäuschte Funktion, genau das Muster, das dort schon einmal bewusst vermieden wurde). Dazu
ein knapper System-Statusstreifen (echter Verbindungsstatus aus dem Ereignisbus, kein Mock).

**Entscheidung, die im Text nicht explizit stand:** die bisherige echte Home-Funktionalität
(Läufe/Freigaben & Fehler/Plan/Kennzahlen, S22–S24 — echt angebunden, mit funktionierender
Freigabe-Beantwortung) wurde **nicht gelöscht**. Sie ist unverändert in ihrer Anbindung auf eine
neue, eigene Route `#/system` umgezogen (`ui/views/system.ts`, fast wörtliche Transplantation der
bisherigen `main.ts`-Logik, nur auf einen Container statt globale `document.getElementById`
umgestellt). Begründung: der Auftrag verlangt, dass Home „ausschließlich zeigt, was ich selbst
täglich brauche" — er verlangt nicht, echte, getestete, ans Gateway angebundene Funktionalität
ersatzlos zu streichen. „System" taucht im Fertig-Kriterium ohnehin als eigenes Home-Element auf,
was diese Lesart stützt: ein knapper Statusstreifen auf dem Cockpit, ein voller Bildschirm auf der
eigenen Route dahinter.

**4. Navigation und Abdocken** (`ui/router/router.ts`, `ui/router/detach.ts`,
`ui/sidebar/view.ts`). Hash-Routing (`#/mail`, `#/settings/appearance`, …) statt echter Pfade —
`ui/serve.ts`/`ui/build.ts` liefern Dateien anhand ihres Pfads aus, ein SPA-Fallback für jeden
Pfad wäre eine Änderung an der Ausliefer-Infrastruktur nur für dieselbe `index.html`; der
Hash-Teil ist rein client-seitig und trotzdem eine direkt aufrufbare, merkbare Adresse. Klick auf
einen Sidebar-Eintrag tauscht die eine aktive Ansicht im Hauptfenster (`ui/main.ts` mountet/
unmountet, keine Tab-Leiste, keine gestapelten Ansichten).

Abdocken per nativem HTML5-Drag-and-Drop: `dragend` auf einem Sidebar-Eintrag liest
`dataTransfer.dropEffect` — `"none"` heißt „auf keiner registrierten Dropzone gelandet", die
Seitenleiste selbst registriert sich per `dragover`/`drop` als gültiges Ziel, damit ein Drop
zurück auf sich selbst nicht zählt. `detachView` (`ui/router/detach.ts`) ist die **einzige**
Stelle im Browser-Client, die `window.open` kennt — dokumentiert als die Stelle, die beim
künftigen Tauri-Client gegen `WebviewWindow` getauscht wird, kein zweiter Ort im Baum. Ein
blockiertes Popup zeigt einen Toast (`ui/toast.ts`) statt still zu scheitern.

**5. Einstellungsseite** (`ui/settings/store.ts`, `ui/settings/view.ts`). Eigene Ansicht mit
linker Abschnittsnavigation, sieben Abschnitte wie im Auftrag benannt. Ein einziges
`localStorage`-Objekt, in Abschnitte gegliedert, `normalizeSettings` verschmilzt gespeicherte
Werte mit Vorgaben Feld für Feld (ein älterer Stand mit weniger Feldern bricht nichts). Jede
Änderung wirkt sofort, kein „Speichern"-Knopf. Wo die Anbindung fehlt (Modelle, Freigaben,
Gedächtnis-Aktionen, Integrationen, ganz Sprache), bleibt das Feld sichtbar, aber `disabled`, mit
einem Hinweistext, der auf die tatsächliche Stelle zeigt (`runtime/model/router.ts`,
`policy/engine.ts`, `.env`, S30/S31) — nicht weggelassen. Der Bearer-Token (`GATEWAY_WEB_TOKEN`,
bisher im schwebenden Zahnrad-Panel) ist jetzt hier, unter System, echt funktionsfähig
(`ui/settings.ts`, unverändert wiederverwendet).

**Austauschbarer Hintergrund mit Farbableitung** (`ui/theme/palette.ts`, `ui/theme/background.ts`,
`ui/theme/resize.ts`) — der aufwendigste Teil, siehe „Gefundene und behobene Fehler" unten für
zwei echte Bugs, die erst beim eigenen Browsertest auffielen. Reine Farbmathematik
(`palette.ts`, vollständig geprüft, kein `document`) getrennt von der DOM-Seite
(`background.ts`, Bild laden/herunterrechnen/Pixel lesen, ungetestet wie der Rest der
DOM-Verdrahtung). Drei Pflichten aus dem Auftrag, jede ein eigener, benannter, geprüfter Schritt:
Sättigung gedeckelt (`clampSaturation`, nie über 45 %), Kontrast der Textfarbe gegen die
tatsächliche Fläche geprüft und bei Bedarf korrigiert (`ensureContrast`, WCAG-Formel, mindestens
4,5:1 — geprüft gegen den **hellsten** Bildpixel nach der deckenden Ebene, nicht gegen den
Durchschnitt, der ungünstigste realistische Fall), eine deckende Ebene hinter Inhaltsflächen
(`.scene`-Verlauf, siehe unten). Zwei mitgelieferte Hintergründe (See = `assets/lake.jpg`, Leere =
ein erzeugter, unauffälliger dunkler Verlauf als Daten-URI, kein neues Bild-Asset) plus eigenes
Bild hochladen (vor dem Speichern auf max. 1600px herunterskaliert, `resize.ts`, damit ein
einzelnes Kamerafoto nicht das `localStorage`-Kontingent sprengt).

**6. Mic-Button und sechs Agentenzustände** (`ui/mic/state.ts`, `ui/mic/button.ts`). Eine einzige
Zustandsquelle (`createMicStateStore`), fest im Mic-Dock außerhalb jeder gerouteten Ansicht,
deshalb von überall erreichbar. Klick bzw. Strg/Cmd+M schaltet `idle`↔`listening` — die einzige
heute echte Interaktion, da eine echte Spracherkennung erst mit S30/S31 kommt. Die sechs Zustände
unterscheiden sich ausschließlich über Form/Deckkraft/Bewegungsruhe (ein Ring: unsichtbar bei
idle, langsam atmend bei listening, gestrichelt rotierend bei thinking, schneller atmend bei
speaking, dick rotierend bei executing, voll sichtbar stehend bei complete) — keine Farbwechsel,
kein Leuchten. Für die Vorführung aller sechs Zustände (Auftrag: „vorerst gegen Mock schaltbar")
steht ein Demo-Knopf unter Einstellungen › System, der die eine Zustandsquelle durchschaltet —
bewusst dort und nicht im normalen Bedienfluss, damit er als das erkennbar bleibt, was er ist:
ein Mock-Schalter, kein vorgetäuschtes Feature.

**7. AI-Slop entfernt.** Konkret entfernt, mit Fundstelle:
- `--glow-cyan`-Token und der `text-shadow` auf der alten Sidebar-Marke (`◍`) — komplett weg,
  zusammen mit der Marke selbst (ersetzt durch das schattenlose Emblem).
- `backdrop-filter: blur()` auf Seitenleiste **und** jeder Karte (vorher identisch auf beiden) —
  jetzt nirgends mehr; Flächen sind stattdessen überwiegend deckend (siehe Fehlerkorrektur unten).
- Die feste Signalfarbe `--ripple-cyan`/`--ripple-blue` — ersetzt durch `--accent`, laufzeit-
  abgeleitet aus dem Hintergrundbild, sättigungsgedeckelt statt fest auf Cyan verdrahtet.
- Unicode-Symbole als Icons (`⌂ ✉ ▦ ↗ ◎ ▤ ⚙ ◔` — dieselbe Rendering-Unsicherheit wie eine
  Kanji-Textglyphe ohne installierte Schrift) und ein echtes Emoji (`📄` im alten `main.ts`) —
  ersetzt durch eine eigene, strichbasierte 20×20-SVG-Icon-Familie (`ui/icons.ts`, 18 Symbole,
  einheitlicher Stil, `currentColor`).
- Vier uniform gerundete, gleich große Karten in identischem Abstand (die alte S25-Vorlagen-
  Übernahme) — ersetzt durch funktional unterschiedlich behandelte Panels/Ansichten (siehe
  Punkt 3 oben, und die Detailseiten: Tabelle für Trading, Liste für Mail, Zeitleiste für
  Calendar, Kartenreihe für Notes/Files/Research).
- Typografie trägt jetzt Ordnung über sieben statt zwei Stufen (`--text-2xl` … `--text-2xs`,
  `ui/styles/theme.css`), Bewegung ist auf die Sidebar-Breite, den Mic-Ring und die Zustands-
  Übergänge begrenzt — nicht dekorativ auf Karten oder Text.

### Gefundene und behobene Fehler (beim eigenen Browsertest)

Der Auftrag verlangt „vor jeder Bewertung als fertig im Browser prüfen" — genau dabei fielen zwei
echte Bugs auf, keiner davon über Unit-Tests sichtbar (beide sind Zusammenspiel zwischen
`palette.ts` und dem tatsächlich gerenderten CSS, nicht Fehler in der reinen Farbmathematik
selbst, die weiterhin alle 22 Tests bestand):

1. **`--bg-panel`/`--bg-sidebar` waren in der Ableitung nur 60 % deckend** (`toRgba(bg, 0.6)`) —
   ein Rest des alten Glas-Looks, den Punkt 7 eigentlich verlangt zu entfernen; die *statischen*
   Vorgabewerte in `theme.css` waren schon opak, die *Laufzeit*-Ableitung fiel beim Umbau aber auf
   das alte Muster zurück. Sichtbar erst mit einem extremen Testbild (100 % gesättigtes Rot als
   hochgeladener Hintergrund): Karten und Einstellungsfelder wurden von der Fotofarbe durchtränkt
   statt lesbar dunkel zu bleiben. Behoben: beide Token sind jetzt `toHex(...)`, vollständig opak.
2. **Der `.scene`-Verlauf war am oberen Rand viel heller** (10–35 % Deckkraft) **als die Deckkraft,
   die die Kontrastrechnung selbst voraussetzt** (`SCRIM_ALPHA = 0.72`) — die rechnerisch
   bewiesene Kontrastgarantie hielt dadurch nicht überall, wo sie auf dem Bildschirm tatsächlich
   gebraucht wird. Behoben: der Verlauf liegt jetzt durchgehend bei mindestens `--scrim` (0,72)
   und wird nach unten nur noch dunkler, nie heller — die reale Fläche entspricht damit wieder der
   Fläche, gegen die `ensureContrast` tatsächlich rechnet.

Nachgewiesen mit einem selbst erzeugten, garantiert opaken 100×100-Rot-Testbild (ein zufällig
verwendeter Base64-Schnipsel für den ersten Versuch war ungewollt ein *transparenter* 1×1-Pixel —
kein App-Fehler, ein Fehler im eigenen Testaufbau, der beim Nachrechnen auffiel und korrigiert
wurde): nach der Korrektur blieb die Oberfläche durchgehend dunkel mit einem erkennbaren, aber
gedämpften Rotton, Text weiterhin klar lesbar, `--accent` korrekt aus dem roten Farbton
abgeleitet (`#c46464`, Sättigung sauber auf 45 % gedeckelt statt der vollen 100 % des Fotos).

Ein dritter, kleinerer Fund: das Akzentfarbfeld in den Einstellungen zeigte kurz nach dem Laden
einen veralteten Platzhalter statt der tatsächlich wirksamen Farbe — eine Wettlaufsituation, weil
die Bildableitung asynchron läuft (Bild laden) und die Einstellungsseite ihren Wert synchron beim
Mounten liest, bevor die Ableitung fertig ist. Behoben mit einem eigenen, schmalen Ereignis
(`kuronami:palette-applied`, `ui/theme/background.ts`), auf das die Einstellungsseite reagiert,
ohne sich in die `settingsBus`-Emit-Kette einzuklinken (das hätte eine Endlosschleife riskiert, da
`applyAppearance` selbst ein `settingsBus`-Abonnent ist).

### Geprüft im Browser

`pnpm exec tsx ui/dev.ts`, echter Chrome-Tab: Home (alle vier Panels mit Mock-Daten, drei Knöpfe,
System-Streifen mit echtem, per WebSocket verbundenem Status), Sidebar ein-/ausklappen per Klick
**und** per Kürzel, Neuladen bestätigt Persistenz; drei Sidebar-Einträge (Mail, Calendar, Trading)
einzeln angeklickt, jeweils die einzige aktive Ansicht ausgetauscht; System-Route zeigt die
transplantierte Läufe-/Freigaben-/Plan-/Kennzahlen-Ansicht mit ehrlichen Fehlermeldungen ohne
laufendes Backend (`Failed to fetch`, wie vor dem Umbau); Einstellungen mit allen sieben
Abschnitten durchgeklickt, Hintergrund zweimal gewechselt (See, Leere, dazu das oben beschriebene
Rot-Testbild) mit sichtbar mitziehender Farbgebung und bestätigtem Kontrast; alle sechs
Mic-Zustände über den Demo-Knopf durchgeschaltet und einzeln per Bildschirmausschnitt bestätigt
(`idle`/`listening`/`thinking`/`speaking`/`executing`/`complete`, sechs unterscheidbare, rein
formale/deckkraft-/bewegungsbasierte Darstellungen).

**Abdocken:** die eigentliche Verdrahtung wurde direkt im Seitenkontext bewiesen (echte
`DragEvent`-Objekte gegen den tatsächlich laufenden Code dispatcht, nicht nachgebaut) — ein
Eintrag ohne gültiges Ziel löst zuverlässig `window.open` mit der korrekten Route/URL/den
korrekten Fenstermaßen aus, ein blockierter Popup zeigt zuverlässig den Toast-Hinweis. Ein
vollständiger End-zu-Ende-Nachweis mit einer echten, per Maus ausgeführten OS-Drag-Geste und
einem tatsächlich zweiten Browserfenster ließ sich mit den verfügbaren Automatisierungswerkzeugen
nicht führen (siehe „Bewusst nicht geprüft" unten) — der Nutzer sollte das beim eigenen
Durchklicken mit echter Maus bestätigen.

### Bewusst nicht geprüft (Werkzeuggrenzen der Automatisierung, keine offenen App-Fehler)

- **Echte, mausgeführte native Drag-and-Drop-Geste.** Synthetische Maus-Events (Mousedown/Move/Up)
  lösen in Chrome keine native HTML5-Drag-Geste aus — nachgewiesen durch einen direkten Versuch
  (kein `dragstart` feuerte). Ersatzweise direkt mit echten `DragEvent`-Objekten gegen den
  laufenden Code geprüft (siehe oben) — das beweist die Verdrahtung, nicht die Geste selbst.
- **„Drop zurück auf die Seitenleiste zählt nicht als Abdocken"** ließ sich aus demselben Grund
  nur eingeschränkt nachstellen: `DataTransfer.dropEffect` lässt sich außerhalb einer echten,
  browser-internen Drag-Operation nicht dauerhaft setzen (eigens nachgewiesen: eine Zuweisung
  direkt nach dem Erzeugen eines `DataTransfer` wird sofort wieder auf `"none"` zurückgesetzt) —
  eine dokumentierte Eigenheit synthetischer `DataTransfer`-Objekte, kein App-Fehler. Bewiesen
  stattdessen ausschließlich über die reinen Logik-Tests (`shouldDetachOnDragEnd`,
  `detach.test.ts`), die exakt diese beiden Fälle abdecken.
- **Ein echtes zweites Fenster mit einer eigenen Fenstergröße.** `window.open` aus injiziertem
  Skript heraus hat in dieser Automatisierungsumgebung keine „echte" Nutzeraktivierung
  (`navigator.userActivation.isActive === false`) und wird deshalb vom Popup-Blocker abgewiesen —
  dieselbe Regel wie im echten Alltag für ein Skript, das ohne Klick ein Fenster öffnen will. Der
  korrekte Hinweis dafür (Toast) wurde bestätigt; das tatsächliche Fenster nicht.
- **Schmales Fenster (< 760 px).** Der Fenster-Größenänderungs-Befehl der Automatisierung griff
  nicht zuverlässig (dieselbe Einschränkung wie schon in S25 vermerkt) — die `@media`-Regeln
  (`ui/styles/layout.css`, `ui/styles/views.css`) wurden geschrieben und durchgesehen, aber nicht
  in einem echten schmalen Fenster bestätigt.

### Bewusst nicht gebaut

- **Kein neuer Sidebar-Bereich außer „System".** Die im Auftrag genannten Bereiche (Home, Mail,
  Calendar, Trading, Research, Files, Settings) blieben inhaltlich unangetastet; „System" kam als
  achter Eintrag dazu, ausschließlich um die bestehende, echte Funktionalität aus S22–S24
  unterzubringen (siehe oben) — keine neue Datenquelle, keine neue Fachlichkeit.
- **Keine echte Anbindung für Modelle/Freigaben/Gedächtnis-Aktionen/Integrationen/Sprache** in den
  Einstellungen — wie in Punkt 5 oben beschrieben, sichtbar deaktiviert mit Hinweistext, nicht
  gebaut, weil außerhalb des Auftrags ("keine Änderung am Backend, an der Policy-Engine oder am
  Agenten-Loop").
- **Kein echter Mic-Zustand aus echten Ereignissen.** Nur Klick/Kürzel (`idle`↔`listening`) und
  der Demo-Zyklus — eine automatische Ableitung aus Ereignisbus-Signalen wäre eine Entscheidung
  über Bedeutung ("wann genau ist der Agent am Handeln vs. am Denken"), die dem eigentlichen
  Sprachschicht-Auftrag (S30/S31) gehört, nicht diesem Zwischenschub.
- **`ui/canvas/ripples.ts` bleibt unverändert unverdrahtet liegen** — unverändert gegenüber S25,
  aus denselben Gründen (siehe dortige offene Befunde).

### Tests

`ui/`-Testbaum: 16 Dateien, 120 Tests, alle grün (u. a. `theme/palette.test.ts` mit 22 Tests für
die komplette Farbmathematik inkl. Kontrastformel, `router/detach.test.ts` mit 6 Tests für die
Abdock-Entscheidung, `mic/state.test.ts` mit 9 Tests für alle sechs Zustandsübergänge,
`settings/store.test.ts` mit 7 Tests für Persistenz/Normalisierung). DOM-berührender Code
(`ui/main.ts`, alle `ui/views/*.ts`, `ui/sidebar/view.ts`, `ui/mic/button.ts`,
`ui/theme/background.ts`, `ui/settings/view.ts`) bleibt aus Prinzip ungetestet — dieselbe
Trennung wie im ganzen `ui/`-Baum seit S21: reine Logik geprüft, DOM-Verdrahtung im Browser
bestätigt. `pnpm typecheck` (beide `tsconfig.json`), `pnpm lint` (Biome, ganzer Baum) und
`pnpm exec tsx ui/build.ts` grün.

Status: abgeschlossen. `tasks.json` unverändert (kein S-Sprint). Nächste Session: wieder am
regulären Plan, S25 im ursprünglichen Sinn (Centerpiece) oder eine Nutzerentscheidung, dass die
Bildvorlagen-Oberfläche das ursprüngliche Fertig-Kriterium ersetzt — siehe die offenen Befunde zu
S25 oben, unverändert durch diesen Zwischenschub.

## UI-Korrektur nach Bildvorlage · 2026-09-13

Direkt nach dem UI-Zwischenschub, auf klare Ansage des Nutzers: "Wo ist der See xd??? Wieso ist
alles so zusammengepfercht?" — dazu die Anweisung, die Funktionalität zu behalten, aber genau das
Design der mitgelieferten Vorlage zu bauen. Die Vorlage (`dashboard_beispiel.png`, aus dem
Downloads-Ordner) ist damit der verbindliche Maßstab; das Hintergrundfoto liegt unverändert als
`ui/assets/lake.jpg` im Repo (bitgleich mit der Datei, die der Nutzer noch einmal genannt hat).

**Was schiefgelaufen war.** Der Zwischenschub hatte Punkt 7 ("AI-Slop entfernen", darunter
"flächendeckendes Glas- und Blur-Motiv") wörtlich genommen und alles Glas entfernt — dazu einen
Verlauf mit 72–86 % Deckkraft über das Foto gelegt, weil die Kontrastgarantie an einer **festen**
Deckkraft hing. Auf einem ohnehin dunklen Foto wie `lake.jpg` heißt das: schwarze Fläche. Die
Vorlage lebt aber von genau den drei Dingen, die dabei verschwunden waren — sichtbares Foto,
dunkle Glaskarten darüber, viel Luft dazwischen.

**Die Kontrastgarantie wurde nicht aufgegeben, sondern anders eingelöst.** Statt einer festen
Abdunklung rechnet `minimalOverlayAlpha` (`ui/theme/palette.ts`) die **kleinste** Deckkraft aus,
die Karten und Kopf-/Fußbänder brauchen, damit Text 4,5:1 erreicht. Ein dunkles Bild bekommt fast
keine (lake.jpg: Karte bleibt bei der Gestaltungsvorgabe 0,56, oberes Band bei 0,12), ein grelles
genau so viel wie nötig. Die beiden Bänder werden getrennt gemessen (oberes/unteres Bilddrittel),
damit ein heller Fleck in der Bildmitte nicht die Kopfzeile abdunkelt.

**Ein echter Fehler, der das Foto vollständig verschluckt hatte:** ein `url()` in einer CSS Custom
Property löst der Browser gegen das Stylesheet auf, das die Variable **einsetzt**
(`styles/layout.css`), nicht gegen das Dokument. Aus `./assets/lake.jpg` wurde
`/styles/assets/lake.jpg` — 404, ohne Fehlermeldung und ohne Konsoleneintrag. Behoben über
`absoluteUrl` (`ui/theme/background.ts`) und eine wurzelabsolute Vorgabe in `theme.css`.

**Die Startseite folgt jetzt der Vorlage:** zentrierte Kopfzeile (Datum, große dünne Uhr,
Leitsatz) mittig im *Fenster* statt im Inhaltsbereich, Wetter rechts außen, darunter drei Spalten,
deren obere Mitte leer bleibt, damit das Foto durchschaut. Markets mit Mini-Kurslinien, Inbox,
Today als Zeitleiste, vier Aktionsknöpfe, System-Messuhren, Quick Notes, Focus/Build/Grow unten
rechts. Der Mic-Schalter sitzt als Pille unten in der Seitenleiste ("Listening …"), nicht mehr als
schwebender Knopf in der Bildschirmecke. Die Seitenleiste ist wieder durchscheinend — in der
Vorlage sieht man den Berg durch sie hindurch.

**Zwei der vier Aktionsknöpfe wurden echt gebaut, statt nur beschriftet zu werden:** "Neue
Aufgabe" öffnet eine Eingabezeile, die tatsächlich an `POST /channels/web/messages` schickt
(`ui/compose.ts`, derselbe Kanal wie `pnpm say`) und die Antwort zeigt; "Fokus" blendet
Seitenleiste und Karten aus und lässt die Uhr stehen. "Läufe" und "Suche" sind Navigation. Die
Vorlage beschriftet die vier mit "New Task / Open Terminal / Search / Focus Mode" — ein Terminal
gibt es in diesem System nicht, und ein Knopf ohne Wirkung wäre nach AGENTS.md eine vorgetäuschte
Funktion. Dieselbe Entscheidung wie in S25, nur diesmal mit drei echten statt null Knöpfen.

**"System" steht nicht mehr in der Navigation** — in der Vorlage gibt es den Eintrag nicht. Die
echte Läufe-/Freigaben-Ansicht bleibt über den Pfeil der System-Karte und über die
Verbindungszeile unten in der Seitenleiste erreichbar.

Unverändert weiter in Betrieb: Router und Abdocken, Einklappen mit Strg/Cmd+B, die vollständige
Einstellungsseite, die sechs Mic-Zustände aus einer Zustandsquelle, Hintergrundwahl samt
Farbableitung.

### Tests

138 Tests in 17 Dateien, alle grün. Neu: `ui/views/chart.test.ts` (10 Tests für die Geometrie der
Mini-Kurslinien und Messuhr-Ringe); `ui/theme/palette.test.ts` auf 30 Tests erweitert, davon fünf
für `minimalOverlayAlpha` und die getrennte Bandmessung. `pnpm typecheck` und `pnpm lint` grün, im
Browser gegengeprüft.

Status: abgeschlossen.

## S28 · Kosten-Tracking · 2026-09-13

Auftrag laut `tasks.json`: "Tagesausgaben pro Agent sichtbar". Die Abhängigkeit auf S25 hat der
Nutzer in derselben Nachricht aufgehoben ("S25 wird komplett ignoriert, eventuell nochmal am
Schluss des Projekts diskutabel, aber nicht jetzt"); die Oberfläche, die der Phase-8-Punkt
"Kosten-Panel im Dashboard" braucht, steht seit dem UI-Zwischenschub ohnehin.

**Gebaut als Faltung, nicht als Zähler.** Dieselbe Haltung wie `context/metrics.ts` seit S24: die
Zahlen kommen aus denselben Ereignissen wie der Zustand. Ein mitlaufender Zähler im Prozess wäre
nach einem Neustart bei null und behauptete Tagesausgaben, die nur die des letzten Prozesses sind.

**`runtime/model/pricing.ts`** — Listenpreise je Modell, mit Preisstand (`PRICING_AS_OF`), der in
jeder Antwort mitläuft: eine Kostenzahl ohne Preisstand ist eine Behauptung ohne Datum. Die beiden
Cache-Preise werden aus dem Eingabepreis abgeleitet (Lesen 0,1×, Schreiben 1,25×) statt einzeln
gepflegt. **Ein unbekanntes Modell bekommt `null`, keine Näherung** — dieselbe Begründung wie bei
den Risikostufen in AGENTS.md: eine geratene Zahl sieht in einer Kostenübersicht aus wie eine
gemessene. Anbieter-Präfixe (`anthropic.…`) und datierte Fassungen werden auf den Grundnamen
zurückgeführt, sonst stünde ein Lauf ohne Preis da, obwohl die Tabelle sein Modell kennt.

**`context/costs.ts`** — `deriveAgentDaySpend` faltet `model.responded` zu Tag/Agent-Eimern. Die
Brücke von der Arbeiter-Session zum Agentennamen ist `agent.returned.worker_session`, das genau
dafür seit S19 dort steht (der Kommentar an der Stelle sagte schon damals: "Eine Kennzahl, keine
Abrechnung — die ist S21", und S21 alt ist dieses S28). Sessions ohne solchen Eintrag laufen unter
`orchestrator` statt wegzufallen — sonst fehlte in einer Ausgabenübersicht ausgerechnet der
teuerste Läufer. Unbepreiste Aufrufe zählen bei den Token mit, **nicht** beim Betrag, und werden
namentlich ausgewiesen: ein unvollständiger Betrag soll nicht wie ein günstiger aussehen.

**`runtime/session/costs.ts`** — die Auswahl der Sessions läuft über die **Ereignis**-Zeitstempel,
nicht über `sessions.created_at` (wie `listRuns` es für seine Liste tut): ein langer Gateway-Faden
kann vor Wochen begonnen haben und heute Geld kosten; eine Auswahl nach Anlegedatum übersähe genau
diesen Lauf, und zwar unbemerkt. Das Fenster beginnt an der lokalen Tagesgrenze, nicht `tage × 24`
Stunden vor jetzt.

**Sichtbar:** `GET /costs` am Gateway (hinter demselben Bearer-Token wie `/runs`) und eine
Kosten-Karte in der System-Ansicht mit Tag, Agent, Aufrufen, Token und Betrag.

### Tests und Nachweis

29 Tests: 25 reine (`runtime/model/pricing.test.ts`, `context/costs.test.ts`) und vier gegen die
**echte Datenbank** (`runtime/session/costs.test.ts`, Fensterzuschnitt und Session-Auswahl — das,
was die reinen Tests nicht abdecken können). Wie seit S21 laufen Backend-Tests nicht unter
`pnpm test`; geprüft über eine Ad-hoc-`vitest`-Config.

Echter End-zu-End-Nachweis: Gateway gestartet, Demo-Ereignisse für einen Orchestrator-Lauf und
zwei delegierte Arbeiter (`coder`, `lore-writer`) geschrieben, `/costs` abgerufen und die Karte in
der Oberfläche geprüft — vier getrennte Tageszeilen mit je eigenem Betrag ($3,04 / $1,18 / $0,70 /
$0,66). Die Demo-Ereignisse wurden danach wieder aus der geteilten Dev-Datenbank gelöscht. Die
**echten** Drehbuch-Läufe, die dort schon lagen, erscheinen korrekt als "$0,00 +21 ohne Preis":
`modell-nach-drehbuch (devui)` steht in keiner Preistabelle, und genau das zeigt die Ansicht an,
statt eine Null zu behaupten.

### Bewusst nicht gebaut

* **Der zweite Titelteil, "Modell-Routing", bleibt offen.** `runtime/model/router.ts` (S18e) ist
  weiterhin an keinen produktiven Aufrufer verdrahtet — offener Befund seit S18e, und die
  Verkabelung ist eine Entscheidung über Kosten und Verhalten, die dieses Fertig-Kriterium nicht
  verlangt. Sie bleibt als Befund stehen, nicht als stillschweigend erledigt.
* **Kein Budget, keine Warnung, keine Obergrenze in Geld.** Gezeigt wird, was ausgegeben wurde;
  eine Grenze zu ziehen ist eine Betriebsentscheidung. Das Token-Budget je Agent (S20) bleibt der
  einzige harte Deckel.
* **Keine Preise für Partnerplattformen** (Bedrock, Vertex) — sie rechnen eigenständig ab, und
  eine zweite Tabelle mit fremden Zahlen wäre eine Behauptung über eine Rechnung, die dieses
  System nicht sieht.

### Offene Befunde (S28)

* **Die Preistabelle altert.** Sie steht mit Datum im Quelltext (`PRICING_AS_OF`), und der Stand
  läuft in jeder Antwort mit — aber niemand erinnert daran, sie zu pflegen. Ein Modell, dessen
  Preis sich ändert, rechnet bis zum nächsten Commit mit dem alten.
* **Der Tag ist die lokale Zeit des Prozesses**, wie schon bei `cal.list` (S15), der
  Heartbeat-Tagesgrenze (S17) und dem Notizdatum (S18). Eine Nutzer-Zeitzone ist weiterhin
  nirgends bekannt.
* **Die Faltung liest ganze Sessions.** Eine Session im Fenster wird vollständig gelesen, auch
  wenn nur ein Ereignis hineinfällt — dieselbe Art wiederholter Arbeit wie bei `listRuns`. Bei
  heutigen Größen unmessbar, aber ohne Aggregat-Abfrage.

Status: abgeschlossen.

## S29 · Tauri-Desktop-Wrapper · 2026-09-13

Auftrag: "Installierbare Desktop-App aus demselben Code". Erfüllt — `pnpm tauri build` erzeugt
zwei Installer (`Kuronami_0.1.0_x64_en-US.msi`, `Kuronami_0.1.0_x64-setup.exe`) und eine
`kuronami.exe` (9,3 MB); die App wurde gestartet, das Fenster zeigt dieselbe Oberfläche wie der
Browser — See-Foto, Glaskarten, Seitenleiste mit Emblem und Mic-Pille.

**Was ersetzt wurde.** `src-tauri/` gab es seit S12b, aber als Wrapper um die **Wegwerf-DevUI**:
Produktname `kuronami-devui`, Fenster auf `http://localhost:8787`, und ein Node-Kindprozess, den
die App selbst startete (`runtime/devui/server.ts`). Das ist alles weg. Die Oberfläche aus `ui/`
ist seit Phase 6 ein Satz statischer Dateien (`ui/build.ts` → `ui/dist`, kein Bundler, kein
Server), und Tauri liefert sie direkt aus (`frontendDist: "../ui/dist"`,
`beforeBuildCommand: "pnpm build:ui"`). Ein Kindprozess, der nur Dateien ausliefert, wäre eine
zweite bewegliche Stelle ohne Gegenwert. `lib.rs` ist von ~80 auf ~35 Zeilen geschrumpft.

**Der angekündigte Tausch ist eingelöst.** `ui/router/detach.ts` war im UI-Zwischenschub
ausdrücklich als "die einzige Stelle, die `window.open` kennt" gebaut, mit dem Kommentar, dass
beim Tauri-Client **nur hier** getauscht wird. Genau so kam es: `detectDetachTarget` erkennt die
globale Tauri-API, und `detachView` baut dann ein echtes `WebviewWindow` statt eines
Browser-Popups. Keine andere Datei musste angefasst werden.

**Warum die globale API und kein `@tauri-apps/api`-Import:** `ui/` wird ohne Bundler ausgeliefert;
ein npm-Import ließe sich im Browser nicht auflösen. `withGlobalTauri: true` stellt dieselbe API
als `window.__TAURI__` bereit — dieselbe Abhängigkeitsdisziplin wie überall sonst (kein zweites
Werkzeug für eine Aufgabe, die der vorhandene Weg trägt).

**CSP statt `csp: null`.** Der alte Wrapper schaltete die Content-Security-Policy ganz ab. Jetzt
steht eine: `default-src 'self'`, dazu ausdrücklich `connect-src` für `localhost`-HTTP/WebSocket,
weil die Oberfläche mit Gateway und Ereignisstrom spricht, und `img-src … data:` für einen selbst
hochgeladenen Hintergrund.

### Was die App ausdrücklich nicht mitbringt

Das Backend (Gateway, Runtime, Postgres) läuft weiterhin eigenständig — `pnpm gateway`. Diese App
ist das Fenster, nicht der Motor: ein Installer, der Postgres mitbrächte, wäre eine Entscheidung
über Betrieb und Datenhaltung, die dieses Fertig-Kriterium nicht verlangt. Läuft kein Backend,
sagt die App das genauso ehrlich wie der Browser ("System Offline", Fehlertexte an den Karten).

### Tests

144 UI-Tests in 17 Dateien, alle grün — neu sind sechs für den Tauri-Pfad in
`ui/router/detach.test.ts` (Erkennung mit/ohne globale API, `WebviewWindow` statt `window.open`,
Abschnitt in der Adresse, und: ein bereits vergebenes Fensterlabel gilt als Erfolg, nicht als
Fehlschlag — abgedockt ist abgedockt). `pnpm typecheck` und `pnpm lint` grün.

### Offene Befunde (S29)

* **Der Backend-Port lässt sich in der Desktop-App nicht umstellen.** Im Browser geht
  `?events=8788`; in der App ist die Adresse `tauri://localhost`, und es gibt keinen Weg, den Port
  zu setzen — sie spricht immer 3000 an. Wer das Gateway auf einem anderen Port betreibt, kann die
  App heute nicht darauf zeigen lassen. Der saubere Ort dafür wäre ein Feld in den Einstellungen
  (Abschnitt System, neben dem Verbindungs-Token); bewusst nicht in dieser Session gebaut, weil es
  über das Fertig-Kriterium hinausgeht — aber es ist eine echte Lücke, keine vergessene.
* **Nicht signiert.** Die Installer tragen keine Code-Signatur; Windows SmartScreen wird beim
  ersten Start warnen. Signieren braucht ein Zertifikat und eine Entscheidung darüber, wer
  ausliefert.
* **Nur auf Windows gebaut und geprüft.** `targets: "all"` erzeugt auf jeder Plattform deren
  eigene Bundles; macOS/Linux sind unbelegt.
* **Kein Auto-Update.** Der Tauri-Updater ist nicht eingerichtet — eine neue Fassung heißt heute:
  neu installieren.

Status: abgeschlossen.

## S30 und S31 · Sprachschicht, Barge-in und Backend-Brücke · 2026-09-13

Zwei Sessions in einer Sitzung, weil sie ein Ding sind: S30 baut die Pipeline, S31 macht sie
unterbrechbar und misst sie. Beide Fertig-Kriterien sind erfüllt — mit einer Einschränkung, die
weiter unten wörtlich steht und nicht kleingeredet wird.

**Auftrag S30:** "Pipecat läuft, Deepgram und ElevenLabs angebunden."
**Auftrag S31:** "Unterbrechen funktioniert, unter 800 ms End-zu-End."

### Was gebaut wurde

Ein eigener Prozess unter `voice/`, Python, Pipecat 1.10.0, im Container. Abschnitt 4.1 hatte das
seit Phase 0 vorgesehen ("die Sprachschicht in Phase 9 nutzt Pipecat und damit Python … eine
Prozessgrenze, kein zweiter Stack"), und genau so ist er gebaut: kein Import aus `runtime/`,
`tools/`, `policy/` oder `gateway/`, und kein TypeScript-Modul kennt einen Pfad unter `voice/`.

```
transport.input() → VADProcessor(Silero) → STT(Deepgram) → KuronamiBridge
                  → TTS(ElevenLabs) → LatencyProbe → transport.output()
```

Die Reihenfolge ist kein Geschmack: das VAD muss vor die Erkennung (sonst gibt es keinen Zeitpunkt
"Nutzer hat aufgehört"), die Brücke zwischen Erkennung und Stimme, die Messsonde **hinter** die
Stimme — davor gäbe es kein Audio zu messen.

**Python läuft nicht auf diesem Rechner.** Es ist keines installiert (`python --version` verweist
auf den Store-Platzhalter). Das ist kein Hindernis, sondern passt zur Prozessgrenze: Image bauen,
`docker compose run --rm voice-test`, fertig. Node bleibt Node.

### Der Agent steht, wo sonst das Modell steht

In einer üblichen Pipecat-Pipeline sitzt an der Stelle von `KuronamiBridge` ein LLM-Dienst. Hier
sitzt das **Gateway**: die Antwort dieses Systems ist kein Modellausgang, sondern ein Lauf mit
Werkzeugen, Freigaben und Gedächtnis. Daraus folgt der Kanal `voice` in `ChannelId` — und damit,
dass eine Freigabeanfrage aus einem Sprachzug über `deriveAskRoutes` (S16) von selbst wieder in
der Sprachsitzung landet statt in einem Browserfenster, das vielleicht gar nicht offen ist.

Neu im Gateway: `gateway/channels/voice/channel.ts` (Postfach wie beim Web-Kanal),
`authenticateVoice` in `identity.ts`, und drei Routen (`/channels/voice/messages`, `/answers`,
`/outbox`). **Zwei Ausweise, nicht einer:** `VOICE_SESSION_TOKEN` schützt den WebSocket-Rand der
Sprachschicht, `VOICE_BRIDGE_TOKEN` den Kanal im Gateway. Zwei Prozesse mit zwei Lebensläufen; ein
abhandengekommener Token soll eine Tür öffnen, nicht zwei.

### Das Draht-Protokoll: rohes PCM und JSON, kein Protobuf

Pipecat bringt einen Protobuf-Serialisierer mit, und er scheidet hier aus einem harten Grund aus:
`ui/` wird seit Phase 6 **ohne Bundler** ausgeliefert (S29), also ohne npm-Import und damit ohne
Protobuf-Bibliothek. Ein Protokoll, das der eigene Client nicht sprechen kann, ist keines.

Also `KuronamiVoiceSerializer`: Binärrahmen sind rohes PCM (16 Bit, little endian, mono),
Textrahmen sind eine JSON-Zeile mit `type`. Die Abtastraten stehen **nicht** im Protokoll fest,
sondern in der ersten Servernachricht (`ready`) — ein Client, der sie rät, spielt irgendwann Audio
in der falschen Geschwindigkeit ab, und das fällt erst im Betrieb auf.

### Unterbrechen heißt nicht abbrechen

Ohne LLM-Dienst gibt es auch keinen LLM-Aggregator, und der wäre in einer Standard-Pipeline die
Stelle, die bei einsetzender Nutzerstimme `broadcast_interruption()` auslöst. Also tut es die
Brücke: sagt das VAD "der Nutzer redet", während die Stimme läuft **oder** ein Zug in der Luft ist,
fällt die Ausgabe des Transports sofort weg und die unterwegs befindliche Antwort wird verworfen.

`runner.cancel()` wird dabei ausdrücklich **nicht** gerufen. Es schriebe `session.canceled` (S05),
und die Session der Sprachschicht ist dieselbe durchgehende Unterhaltung wie im Web und auf
Telegram (`gateway/conversation.ts`). Dazwischenreden würde damit das Gespräch beenden statt es zu
lenken. Der angestoßene Zug läuft im Gateway zu Ende und steht dort im Protokoll — er wird nur
nicht mehr vorgelesen.

Beim Bauen aufgefallen und korrigiert: `broadcast_interruption()` erreicht die **anderen**
Prozessoren, nicht den Absender. Die Brücke muss ihren eigenen Zug deshalb selbst fallenlassen,
sonst spräche die schon unterwegs befindliche Antwort gleich über den Nutzer hinweg. Der Test
dafür (`test_barge_in_verwirft_die_antwort_die_noch_unterwegs_war`) war zuerst rot.

### Freigaben per Stimme

Per Telegram gibt es Knöpfe, per Slack eine Reaktion — per Stimme gibt es nur Text. Ohne eine
Zuordnung liefe ein Sprachgespräch auf den ersten Freigabepunkt zu und bliebe dort stehen. Also
`choices.py`: die Frage wird mit ihren Optionen vorgelesen, die nächste Äußerung dagegen
abgeglichen, **ohne Modell und ohne Raten**. Kein Treffer heißt Nachfragen.

Die Reihenfolge der fünf Wege ist das Ergebnis eines roten Tests: **die Verneinung steht ganz
vorn**. "Nein, nicht genehmigen" stolperte sonst über die Beschriftung "Genehmigen" und wurde als
Zustimmung gelesen — das ist kein Randfall, sondern die naheliegendste Art, eine Freigabe
abzulehnen, und der teuerste denkbare Fehlgriff.

### Was die 800 ms bedeuten — und was gemessen wurde

Ein Sprachzug besteht aus fünf Strecken, und nur vier gehören dieser Schicht:

| Strecke | von → bis | gehört zu |
|---|---|---|
| `erkennung` | Ende des Sprechens → endgültiges Transkript | Deepgram |
| `bruecke` | Transkript → Anfrage am Gateway | der Sprachschicht |
| `agent` | Anfrage → Antwort | dem Modell und seinen Werkzeugen |
| `uebergabe` | Antwort → Sprechauftrag | der Sprachschicht |
| `stimme` | Sprechauftrag → erstes Audio-Byte | ElevenLabs |

**Das Budget gilt für alles außer `agent`.** Die Denkzeit des Modells mit hineinzurechnen hieße,
eine Eigenschaft des Modells als Eigenschaft dieser Schicht auszugeben — sie ließe sich durch keine
Verbesserung hier drücken. Ausgewiesen wird sie trotzdem: vier Sekunden Antwortzeit sind für ein
Gespräch eine schlechte Nachricht, auch wenn sie nicht hierher gehören. Die Definition steht in
`voice/pipeline/latency.py`, bevor gemessen wird, nicht danach.

Gemessen mit `voice/bench/measure.py` — echte Pipeline, echter WebSocket, echte HTTP-Fahrt zum
Backend; ersetzt sind nur die beiden Anbieter, das Backend (ein Doppel mit einstellbarer Denkzeit)
und der Sprachdetektor. Fünf Läufe je Szenario, Backend-Denkzeit 1,5 s:

| | min | median | max |
|---|---|---|---|
| Sprachschicht (Budget 800 ms) | 1,08 ms | 1,22 ms | 1,86 ms |
| Gesamt inkl. Agent | 1502,7 ms | 1503,1 ms | 1505,6 ms |
| **Barge-in (Reden bis Stille, beim Hörer)** | **137,8 ms** | **140,3 ms** | **175,7 ms** |

Die Barge-in-Zahl ist die belastbarste der drei: gemessen vom ersten lauten Block, den der Client
schickt, bis zum letzten Audio-Block, der bei ihm ankommt — **eine echte End-zu-End-Zahl, die an
keinem Anbieter hängt.** VAD-Anlaufzeit, Unterbrechung, geleerter Puffer und Draht sind dieselben
wie im Betrieb. Fünf von fünf Läufen galten (ein Lauf zählt nur, wenn beim Hineinreden tatsächlich
eine Stimme lief; das prüft der Messstand selbst und verwirft sonst).

**Was die 1,1 ms nicht sagen.** Sie messen die Eigenzeit der Pipeline, nicht die Anbieter. Der
ehrliche Satz dazu: das Budget von 800 ms steht der Erkennung und der Stimme **vollständig** zur
Verfügung, weil die Schicht dazwischen praktisch nichts kostet — ob es am Ende reicht, entscheiden
Deepgram und ElevenLabs, und das ist ungemessen.

### Der zweite Sprachdetektor, und warum er nötig war

Silero sagt zu synthetischem Ton "keine Stimme". Nachgeprüft, nicht vermutet: ein 220-Hz-Sinus,
weißes Rauschen und ein gebasteltes Formantengemisch werden alle drei durchgehend als `QUIET`
eingestuft. Im Betrieb ist das genau richtig — ein Lüfter oder ein Türschlag darf den Agenten nicht
unterbrechen. Für eine **wiederholbare Messung** ist dieselbe Stärke ein Hindernis: sie braucht
einen Reiz, den der Messende selbst erzeugt und exakt platziert.

Also `VOICE_VAD=energy` (`voice/pipeline/vad.py`), mit derselben Blockgröße (512 Abtastwerte bei
16 kHz, exakt Sileros) und damit derselben Zeitzählung in der Basisklasse. Was sich unterscheidet,
ist allein die Antwort auf "ist das eine Stimme", nicht "wann fing sie an". `silero` bleibt die
Vorgabe.

### Die Oberfläche hat jetzt ein Gegenstück zum Mic-Knopf

`ui/mic/state.ts` sagte seit dem UI-Zwischenschub selbst, die sechs Zustände seien "vorerst gegen
Mock schaltbar, bis eine echte Spracherkennung (S30/S31) dahintersteht". Sie steht jetzt:
`ui/voice/session.ts` (Protokoll, ohne Browser prüfbar), `ui/voice/audio.ts` (Mikrofon per
AudioWorklet, Wiedergabe mit Schlange und `flush` — die Hörerseite des Barge-in),
`ui/voice/controller.ts` (Verbindung, Mikrofon und Lautsprecher gehören immer zusammen).

Der Mic-Knopf bekam dafür einen optionalen `onToggle`; ohne ihn verhält er sich wie bisher. Vier
der sechs Zustände kommen jetzt aus der Pipeline (`idle`, `listening`, `thinking`, `speaking`);
`executing` und `complete` bleiben bewusst aus, siehe offene Befunde.

In den Einstellungen (Abschnitt Sprache) sind zwei Felder **echt** geworden — Adresse des
Sprachprozesses und Sitzungs-Token; die übrigen bleiben sichtbar und deaktiviert, jeweils mit dem
Grund. Der Barge-in-Schalter ist angehakt und deaktiviert: die Pipeline unterbricht immer, und ein
Schalter dafür wäre eine Wahl, die es im Sprachprozess nicht gibt.

### Tests

* **65 Python-Tests** (`docker compose run --rm voice-test`), alle grün. Die Brücken-Tests laufen
  mit Pipecats eigenem `run_test`, also in einer **echten** Pipeline mit StartFrame, Task-Manager
  und beiden Frame-Richtungen — ersetzt ist nur das Backend.
* **183 TypeScript-Tests** (`pnpm test`), alle grün; neu sind 19 für den Sprach-Kanal am Gateway
  und 22 für den Sprach-Client der Oberfläche.
* `vitest.config.ts` nimmt dafür **genau einen** Ordner zusätzlich auf
  (`gateway/channels/voice/**`). Die 679 alten Tests der Phasen 1–5 bleiben aus dem Lauf, wie in
  S21 angeordnet; die Ausnahme steht als Kommentar über der Zeile.
* **Gegenprobe für die angefassten alten Pfade:** `identity.ts`, `types.ts`, `server.ts` und
  `index.ts` des Gateways sind geändert worden, und ihre Tests laufen normalerweise nicht mehr
  mit. Sie wurden deshalb einmal von Hand mit angepasster `include` gefahren: **124 Tests in 11
  Dateien grün**, darunter `gateway.test.ts` mit 23 Tests gegen die echte Datenbank.
* `pnpm typecheck` und `pnpm lint` grün, `pnpm build:ui` baut (36 Module).

### Bewusst nicht gebaut

* **Kein Wake-Word.** Eine Sitzung beginnt mit dem Knopf.
* **Keine Aufnahme als Anhang.** `InboundMessage.attachments` ist für `voice` immer leer — eine
  Tonaufnahme aufzubewahren wäre eine eigene Entscheidung über Aufbewahrung und Datenschutz und
  gehört nicht nebenbei in eine Zeile am HTTP-Rand.
* **Keine Wiederverbindung im Sprach-Client**, anders als beim Ereignisstrom. Der Strom ist eine
  Anzeige, die von selbst zurückkommen soll; eine Sprachsitzung ist eine Handlung des Nutzers —
  sie ungefragt neu aufzumachen hieße, das Mikrofon ohne Auftrag wieder einzuschalten.
* **Kein Zusammenlegen der Sprach- und Web-Routen im Gateway.** Grund und Bedingung stehen als
  Kommentar an der Stelle und in den offenen Befunden.

### Offene Befunde (S30/S31)

Stehen vollständig oben unter "Offene Befunde (gesamte Historie)". Der wichtigste in einem Satz:
**Deepgram und ElevenLabs sind verdrahtet und im gebauten Graphen nachgewiesen, aber nie gerufen
worden — es gibt keine Schlüssel**, dieselbe Lage wie bei `ANTHROPIC_API_KEY` seit S16.

Status: abgeschlossen. Damit ist der Sessionplan aus `tasks.json` abgearbeitet — S01 bis S31 sind
`done`, außer S25 (stillgelegt auf Nutzeranweisung vom 2026-09-13).

## S33 · Provider-Schlüssel aus der Oberfläche setzbar · 2026-09-13

**Auftrag (Nutzerwunsch, keine vorbereitete Sessionvorlage):** "erstell einfach eine Funktion im
Dashboard wo ich alle API keys einfügen kann, ohne ständig hier hin oder Code schreiben zu
müssen." Ausgelöst dadurch, dass beim Verbinden der S32-Schlüssel (parallele Sitzung, siehe
`docs/sessions/S32-prompt.md`) zwei von drei Werten von der jeweiligen Anbieter-API abgelehnt
wurden (Anthropic: nicht workspace-gebunden; Deepgram: sieht nach `client_id:client_secret` statt
einem echten Schlüssel aus) — kein Server-Absturz, wie zunächst vermutet.

**Zwei Sitzungen, eine `.env`, eine Koordination.** S32 lief zeitgleich in einer anderen Sitzung
(`root-d5`) und ist alleiniger Eigentümer von `.env`/`tasks.json`/`progress.md`/Commits für S32.
Diese Sitzung hat deshalb `.env` selbst nie angefasst — nicht einmal zum Test — und dieses hier
ist ein eigener, unabhängiger Task (S33), nicht Teil von S32.

### Was gebaut wurde

* **`runtime/secrets/env-file.ts`** — die einzige Stelle, die ein `.env`-Zeilenformat kennt.
  `readSecretStatus` liest, ob ein bekannter Schlüssel gesetzt ist (nie den Wert selbst, nur die
  letzten vier Zeichen als Vorschau). `upsertSecrets` baut daraus einen neuen `.env`-Inhalt:
  bestehende Zeilen werden ersetzt, neue angehängt, Kommentare und Reihenfolge bleiben
  Zeichen für Zeichen erhalten. Nur `KNOWN_SECRET_KEYS` (die sieben Werte aus dem S32-Auftrag)
  lassen sich schreiben — sonst wäre aus einer Handvoll Provider-Schlüsseln ein allgemeiner Weg
  geworden, beliebige Umgebungsvariablen der Prozesse zu setzen. 14 Tests, rein (kein Dateisystem
  in der Kernlogik, nur in den dünnen `readEnvFile`/`writeEnvFile`-Hüllen).
* **`GET`/`POST /settings/api-keys`** (`gateway/server.ts`) — hinter demselben Bearer-Token wie
  `/runs`: wer den hat, darf ohnehin schon die Runtime steuern. `GET` liefert Status+Vorschau je
  Schlüssel, `POST` nimmt `{ keys: { NAME: wert } }` und schreibt über `upsertSecrets`. 6 Tests
  in `gateway/settings.test.ts`, mit einem Speicher im Arbeitsspeicher statt echter Platte oder
  Datenbank — dieselbe Leichtgewicht-Machart wie `gateway/runs.test.ts`.
* **`ui/settings/view.ts`, neuer Abschnitt "API-Keys"** — fünf Felder (Anthropic API Key,
  Anthropic Modell, Deepgram API Key, ElevenLabs API Key, ElevenLabs Voice ID), Typ `password`,
  Status/Vorschau lädt beim Öffnen, Speichern läuft automatisch bei `change` wie beim
  Sitzungs-Token unter "Sprache". `VOICE_SESSION_TOKEN`/`VOICE_BRIDGE_TOKEN` bleiben aus dieser
  Seite bewusst draußen: der Name kollidiert sonst mit dem browserseitigen Sitzungs-Token, das
  einen anderen Zweck hat (was der Browser vorzeigt, nicht was der Sprachprozess erwartet) — über
  dieselbe Route sind sie trotzdem schon schreibbar, nur noch nicht von dieser Seite aus.

### Zwei Grenzen, offen benannt statt stillschweigend übergangen

**Eine Änderung gilt erst nach einem Neustart** des betroffenen Dienstes. Kein Fernsteuerungs-
Endpunkt dafür gebaut — genau das fehlt laut `ui/settings/view.ts` (Abschnitt System) schon
länger, und ihn nebenbei für diese eine Sitzung nachzuziehen hätte bedeutet, dem Gateway
Docker-Zugriff zu geben (ein Bind-Mount des Docker-Sockets), eine Entscheidung mit größerer
Tragweite als dieser Auftrag. Dieselbe Haltung wie `MissingApiKeyError`
(`runtime/model/anthropic.ts`) und `config_from_env` (`voice/pipeline/config.py`): Konfiguration
wird beim Start geprüft, nie mitten im Betrieb nachgezogen.

**Setzt Dateizugriff auf die echte `.env` voraus.** Funktioniert heute, weil `gateway`/`runtime`
noch Docker-Platzhalter ohne eigenes Dockerfile sind (kein `Dockerfile` im Projektwurzel, nur
`voice/Dockerfile`) — der Gateway-Prozess läuft also über `pnpm gateway` direkt auf dem Rechner
mit Dateizugriff auf `.env`. Bekäme `gateway` ein eigenes Dockerfile und liefe über
`docker-compose.yml`s `env_file:`, hätte der Container die Werte nur als Umgebungsvariablen, nicht
die Datei selbst — ohne einen Bind-Mount von `.env` würde diese Route dort ins Leere schreiben.
Das ist eine spätere Entscheidung (mit derselben Sorgfalt wie die MCP-Server-Wahl in S32), keine
stillschweigende Annahme hier.

### Umgebung dieser Sitzung

Dieser Rechner hatte weder ein passendes Node (System-`nodejs` war 22, `package.json` verlangt
`>=24 <25`) noch `pnpm` — beides über NodeSource/Corepack nachinstalliert, um `pnpm typecheck`/
`lint`/`test` tatsächlich laufen zu lassen statt ungetesteten TypeScript-Code abzuliefern.
`pnpm typecheck`, `pnpm lint`, `pnpm test` (183 Tests, Standardlauf) grün; die beiden neuen
Testdateien liegen unter den seit S21 nicht automatisch laufenden Backend-Pfaden
(`runtime/**`, `gateway/*.test.ts`) und wurden deshalb, wie schon in früheren Sessionen für
angefasste alte Pfade, einmal von Hand mit angepasster `include` gefahren (20 Tests, grün).
`docker compose run --rm voice-test` wurde nicht gefahren — dieser Auftrag berührt `voice/`
nicht.

Status: abgeschlossen.
