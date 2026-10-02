# Bauplan des Nachtbaus

Jakob hat den Plan am 27.09.2026 abends freigegeben: „du kannst dafür einen Loop bauen, damit das
jede Nacht außerhalb meiner Nutzerzeiten automatisch nach Plan fertig gebaut wird." Der Nachtbau
(`bau/nachtbau.sh`) nimmt jede Nacht die erste Aufgabe mit Status `offen`, `in Arbeit` oder
`wartet`, deren „Braucht" erledigt ist, und arbeitet sie in einem eigenen Lauf ab. Die
Arbeitsregeln stehen in `bau/auftrag.md`, die Berichte unter `bau/berichte/`.

**Modell:** die Zeile „Modell:" je Aufgabe — `sonnet` (Vorgabe) baut mit **Sonnet 5.5**, `opus` mit
**Opus 5.5**, Opus nur für den Bau von Kuro OS.

**Anweisungen:** Jede Aufgabe läuft nur mit einer genauen Anweisung unter `bau/aufgaben/<ID>.md`
(sonst überspringt der Läufer sie). Claude schreibt sie tagsüber: Suchanker, wörtlicher Code,
Prüfbefehle mit erwarteter Ausgabe, Stopp-Regeln — und spielt sie vorher in einer Wegwerf-Kopie
durch. Der Plan hier ist nur die Übersicht.

**Status-Werte:** `offen` · `in Arbeit (Stand …)` · `wartet (worauf)` · `erledigt (Datum, Commit)` ·
`blockiert (Grund)`. Eine zu große Aufgabe darf in Teilaufgaben (N7a, N7b …) zerlegt werden. **Die Reihenfolge im
Plan ist die Reihenfolge der Arbeit**, nicht die Nummer: das Wochenbudget reicht nur für wenige
Aufgaben, deshalb stehen Jakobs Archiv (N2) und die Kalibrierung (N9) vorn.

Hintergrund in einem Satz: Am 27.09. hat der Handelstisch 22 selbst erfundene Regeln verworfen,
aber nie die Strategien gerechnet, mit denen Jakob gelernt hat — die Agenten ersetzten fehlende
Bausteine durch eigene Regeln und meldeten dann das Original als widerlegt. Jakob vermutet, dass
die Agenten fehlerhaft sind und durch die TradingLab-Videos besser werden. Beides soll dieser Plan
**messbar** machen.

---

## N1 · Quelltreue: Ersatzregeln widerlegen kein Original
- Status: erledigt (2026-09-27, „Nachtbau N1: Quelltreue …")
- Modell: opus

Die boerse und der stratege (`context/bedienstete.ts`, Handelstisch) bekommen eine Regel im
Prompt, mit Beispiel richtig/falsch (der Ton steht in Beispielen, nicht in Adjektiven):
- Kommt eine Regel aus einer Quelle (Video, Buch, Jakob), wird sie **wörtlich** umgesetzt.
- Fehlt dafür ein Baustein im Backtest, heißt das Ergebnis „**nicht prüfbar — Baustein fehlt:
  X**", nie „verworfen". Eine Näherung darf gerechnet werden, heißt dann aber im Bericht und im
  Archiv „Ersatzregel für …" und sagt nichts über das Original.
- Der fehlende Baustein wird im Bericht als Bauwunsch genannt (Jakob gibt ihn an den Nachtbau).

Fertig, wenn: Prompttexte stehen, ein Test prüft, dass die Sätze im Prompt der beiden stehen.

## N2 · Archiv für Strategien und Analysen
- Status: erledigt (2026-09-28, „Nachtbau N2: Archiv für Strategien und Analysen")
- Modell: opus

Jakob: „wir brauchen Archive für Strategien und Analysen, sonst müllt mir das die Website zu."
- Strategien (`gateway/strategien.ts`, `ui/views/strategien.ts`) und Analysen
  (`gateway/analysen.ts`, `ui/views/analysen.ts`) bekommen ein Feld `archiviert` (Zeitpunkt oder
  leer) und die Routen zum Archivieren/Zurückholen.
- Die Ansicht zeigt standardmäßig nur Nicht-Archiviertes. Ein ruhiger Schalter „Archiv (n)" zeigt
  das Archiv; dort je Eintrag „zurückholen". Stil wie S50 (`kuronami-bereiche-ruhig`): nichts
  Lautes, Klarnamen.
- Automatisch ins Archiv: Strategien mit Status `verworfen` und Analysen mit Status `verworfen`,
  sobald sie älter als 3 Tage sind (einmal beim Start und dann täglich). `kandidat` und alles im
  Papierhandel nie automatisch.
- Die schon verworfenen Einträge vom 21.–27.09. landen damit gleich im Archiv.

Fertig, wenn: Tests für Ablage und Routen, Typecheck grün, und die Ansicht zeigt mit echten
Daten (read-only aus `/opt/kuronami/workspace`) weniger Einträge als vorher — Zahl im Bericht.

## N3 · Strategie-Ablage kennt Intervall und Quelle
- Status: erledigt (2026-09-28, „Nachtbau N3: Strategie-Ablage kennt Intervall und Quelle")
- Modell: opus

`strategie_ablegen` (`gateway/labor.ts`) rechnet fest mit `"1d"` und Yahoo. Es bekommt
`intervall` und die Quelle (wie `backtest`: `binance:`-Symbole, Zeitfenster), damit Intraday-Tests
abgelegt werden können. Der Eintrag `1acb4e880448` im Live-Archiv
(`/opt/kuronami/workspace/strategien/`) bekommt nur eine Notiz: „falsch beschriftet: lief als
1d-Test, gemeint war ein 1h-Test (27.09.)" — nichts löschen, nichts sonst ändern.

## N9 · Kalibrierung: stimmt das Werkzeug mit TradingLab überein?
- Status: erledigt (2026-09-28, „Nachtbau N9: Kalibrierung an TradingLab — Regeln und Rechenskript")
- Modell: opus
- Braucht: N1, N3

Jakobs Vermutung (27.09.): „meine Agenten sind fehlerhaft und müssen optimiert werden". Prüfen
an den drei ältesten Videos, mit denen er gelernt hat: `rf_EQvubKlk` (BEST MACD, „86 % Win
Rate"), `pCmJ8wsAS_w` (Bollinger + RSI), `bKPs2aOsvsk` (EASY Scalping).
1. Regeln **wörtlich** aus den Transkripten (`/opt/kuronami/workspace/wissen/tradinglab/roh/<id>.json`, liegen seit 27.09. abends vor), mit Zeitmarke je Regel. Was im Transkript
   uneindeutig ist, als Annahme kennzeichnen.
2. Fehlende Bausteine **bauen, nicht ersetzen**. Sicher nötig: Stop am letzten Swing-Tief/-Hoch
   (Lookback N), Stop an einem Indikatorwert (z. B. EMA 200), Ziel als Vielfaches des so
   entstandenen Risikos. Alles ohne Blick in die Zukunft, mit Tests.
3. Rechnen per Skript direkt über `gateway/backtest.ts` (Code, kein Agent; Kuro bekommt keine
   Aufträge vom Nachtbau), auf Markt und Zeitrahmen, die TradingLab nennt, plus die
   Übertragbarkeit wie üblich.
4. Vergleich in drei Spalten: TradingLabs eigene Angabe · das Original bei uns gerechnet · was
   Kuros Agenten am 21.09. als „MACD-Kreuzung"/„Bollinger-Dip" gerechnet hatten
   (`/opt/kuronami/workspace/strategien/`). Wo wichen die Agenten ab, und macht das den
   Unterschied?
5. Bericht für Jakob in den Analysen (so, dass er ihn in der Oberfläche findet) und als
   `wissen/tradinglab/kalibrierung.md`. Das Original bekommt einen Archiv-Eintrag mit echtem
   Status.

Wartet, solange die drei Transkripte fehlen (`wartet (Transkripte)`).

## N8 · Lehrgang: jedes Video wird durchgearbeitet
- Status: erledigt (2026-09-28, „Nachtbau N8: Lehrgang — jedes Video wird nachts durchgearbeitet")
- Modell: opus

Die Transkripte kommen von Jakobs PC (`werkzeuge/pc/tradinglab_transkripte.py`) nach
`/opt/kuronami/workspace/wissen/tradinglab/roh/<id>.json` (`gateway/wissen.ts`). Neu im Gateway
(`gateway/lehrgang.ts`, Takt wie `gateway/gespraeche.ts`, in Kuros Zugschlange):
- Nachts 01:00–06:00 Wien, nur wenn das Abo-Sitzungsfenster unter 70 % steht; höchstens 15
  Videos je Nacht; Kalibrierungsvideos (`kalibrierung: true` im Inventar) zuerst.
- Je Video ein Einmal-Lauf **ohne Werkzeuge** (Sonnet), Ausgabe in **Markierungen, nicht JSON**
  (Lehre aus dem Übergabe-Absturz): `<begriffe>`, `<regeln>` (je Regel Parameter und „mechanisch
  prüfbar: ja/teils/nein"), `<beispiele>` mit Zeitmarke, `<warnungen>`, `<behauptungen>` (Zahlen
  wie „86 % Trefferquote" — als Behauptung, nicht als Beleg), `<fehlt>` (was nur im Bild zu sehen
  war).
- Ablage `wissen/tradinglab/notizen/<id>.md`, Kopf mit Titel, Link, Zeitmarken-Links.
- Verbrauch ins Verbrauchsbuch (`unter: "lehrgang"`); Abschalten `KURO_LEHRGANG=aus`.
- Oberfläche: der Stand (`GET /integrations/wissen/tradinglab`) als ruhige Karte auf der
  System-Seite: Videos, Transkripte, durchgearbeitet.

Fertig, wenn: Tests (Parser der Markierungen, Takt, Grenze), und ein echter Lauf über **ein**
Kalibrierungsvideo, falls dessen Transkript schon da ist — sonst Status `erledigt` mit Hinweis.

## N16 · Slack-Kanal ausbauen
- Status: erledigt (2026-10-02, von Hand — der Probelauf war der Bau)
- Modell: sonnet
- Anweisung: `bau/aufgaben/N16.md`

Der nie eingerichtete Slack-Kanal fliegt raus; Telegram bleibt.

## N4 · Das Abo-Limit reißt den Faden nicht mehr
- Status: erledigt (2026-10-02, von Hand — der Probelauf war der Bau)
- Modell: sonnet
- Anweisung: `bau/aufgaben/N4.md`

Deutscher Satz statt englischem Grenztext, Berichte warten auf das Ende der Sperre, keine SDK-Floskeln.

## N18 · Kuro archiviert bei vollem Kontext
- Status: erledigt (2026-10-02, von Hand)
- Modell: sonnet

**Warum:** Kuros Kontext wächst an einem regen Tag von 18.000 auf über 100.000 Token (gemessen
27.09.: 93.238 → 101.423 bis 18:38); jeder Zug liest das ganze Gespräch mit, das zehrt am Abo.
Archiviert wird bisher nur nachts (`gateway/gespraeche.ts`, `ARCHIV_FENSTER` 3–6 Uhr).

**Bauen:**
1. `gateway/gespraeche.ts`: neue reine Funktion `istKontextVoll(kontext: number | null, grenze:
   number): boolean` und Konstante `KONTEXT_GRENZE = 80_000` (überschreibbar mit
   `KURO_KONTEXT_GRENZE` in der Umgebung, wie `ausUmgebung` im Lehrgang liest).
2. Wo der nächtliche Takt `archiviereGespraech` aufruft (in `gateway/index.ts`, Suche nach
   `istArchivZeit`): zusätzlich tagsüber archivieren, wenn `agent.kontext` (Getter in
   `gateway/agent.ts`) über der Grenze liegt **und** seit dem letzten Zug von Jakob mindestens
   10 Minuten vergangen sind (Zeitpunkt aus dem Verbrauchsbuch wie `jakob_aktiv` in
   `bau/nachtbau.sh`, oder einem neuen Getter `letzterZug` am Agent — einfacher, bevorzugt).
   Anlass `"Kontext voll"`. `archiviereGespraech` verschiebt ohnehin, solange eine Rückfrage offen
   ist oder ein Bediensteter arbeitet.
3. Die System-Seite zeigt den Anlass schon über das Archiv; nichts in der Oberfläche ändern.

**Testen:** `istKontextVoll` (null → false, Grenze genau → true) und die Zeitbedingung als reine
Funktion `darfJetztArchivieren(kontext, letzterZug, jetzt, grenze)`.

**Fertig, wenn:** Tests grün; im Bericht, bei welcher Grenze und warum 80.000 (Übergabe kostet
gemessen 7–8k Token, lohnt also ab etwa dem Zehnfachen).

## N19 · Kuro OS, dritter Wurf: das Arbeitszimmer
- Status: in Teilaufgaben (N19a–N19f)
- Modell: opus

Jakob am 02.10. abends: Die Desktop-App neu gestalten — Kuro im Zentrum, Orb und Agenten-Orbs
bleiben, keine Mac-Nachbildung, kein Dock, Kuro optional als Begleiter auf dem Desktop. Konzept:
`bau/kuro-os-konzept.md`. Er gab die Nacht vom 02. auf den 03.10. frei, ohne Grenzen, Schluss 08:00.

## N19a · Grundgerüst: drei Räume, Kopf, Kuros Platz, Blatt für System
- Status: offen
- Modell: opus

## N19b · Der Raum „Kuro": Empfang mit Fenster, Orb und „Heute"
- Status: offen
- Modell: opus
- Braucht: N19a

## N19c · „Im Haus": wer woran arbeitet
- Status: offen
- Modell: opus
- Braucht: N19a

## N19d · Handel, Brain, Post, Studium: die Teile im neuen Rahmen, Hintergrund je Raum
- Status: offen
- Modell: opus
- Braucht: N19a

## N19e · Kuro auf dem Desktop: der Begleiter (Electron)
- Status: offen
- Modell: opus
- Braucht: N19a

## N19f · Schliff und Aufräumen
- Status: offen
- Modell: opus
- Braucht: N19a

## N17 · Kommentare kürzen
- Status: in Teilaufgaben (N17a–N17h)
- Modell: sonnet

Jakob am 02.10.: „zu viele Notizen im Code". 8.909 Kommentarzeilen in 189 Dateien, in acht Paketen
zu je ~1.150 Zeilen. Der Wächter `bau/nur-kommentare.ts` lässt keine Code-Änderung durch.

## N17a · Kommentare kürzen, Paket 1 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17a.md`

19 Dateien von `context/bedienstete.ts` bis `gateway/channels/telegram/normalize.ts`.

## N17b · Kommentare kürzen, Paket 2 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17b.md`

22 Dateien von `gateway/channels/voice/channel.test.ts` bis `gateway/indikatoren.ts`.

## N17c · Kommentare kürzen, Paket 3 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17c.md`

26 Dateien von `gateway/integrations/binance.test.ts` bis `gateway/nachtbudget.ts`.

## N17d · Kommentare kürzen, Paket 4 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17d.md`

20 Dateien von `gateway/papierhandel.test.ts` bis `gateway/server.ts`.

## N17e · Kommentare kürzen, Paket 5 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17e.md`

24 Dateien von `gateway/sperre.ts` bis `runtime/redaction/patterns.ts`.

## N17f · Kommentare kürzen, Paket 6 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17f.md`

24 Dateien von `runtime/redaction/redact.test.ts` bis `ui/main.ts`.

## N17g · Kommentare kürzen, Paket 7 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17g.md`

33 Dateien von `ui/markets/alarm-melden.ts` bis `ui/views/trading.ts`.

## N17h · Kommentare kürzen, Paket 8 von 8
- Status: offen
- Modell: sonnet
- Anweisung: `bau/aufgaben/N17h.md`

21 Dateien von `ui/views/types.ts` bis `ui/welle/zustand.ts`.

## N5 · Kleine Reparaturen an Kuro
- Status: erledigt (2026-10-02, von Hand)
- Modell: sonnet

Vier unabhängige Stellen, jede ein eigener Commit. Alle aus dem Verlauf vom 27.09. belegt.

1. **Abgebrochener Auftrag meldet sich nicht als „Bericht".** `gateway/haus.ts`, im Werkzeug
   `beauftrage` (~Zeile 211): `void lauf.then((ergebnis) => deps.onNachgereicht?.(wer, ergebnis))`
   ruft den Nachtrag auch dann, wenn Kuro den Auftrag selbst mit `abbrechen` beendet hat — Kuro las
   „Bericht eingetroffen: … auf Zuruf abgebrochen" und gab um 13:35 einen dritten Auftrag. Ändern:
   kein `onNachgereicht`, wenn `abbruch.signal.aborted`. Test in einer neuen
   `gateway/haus.test.ts` nur, wenn es ohne SDK geht (die Bedingung in eine kleine exportierte
   Funktion ziehen, z. B. `sollNachtragen(abgebrochen: boolean): boolean`, und die testen) — sonst
   im Bericht begründen.
2. *(Gebaut anders: Kuros eigene Werkzeuge waren „deferred“ — ohne ToolSearch hätte er `beauftrage`
   gar nicht mehr laden können. Stattdessen `ENABLE_TOOL_SEARCH=false` und ein fester Katalog
   (`tools`) für Kuro und das Personal: Grundlast gemessen 13.500–21.300 → 3.100 Token.)*
   **`ToolSearch` gehört nicht in Kuros Katalog.** `gateway/agent.ts`, Liste
   `NICHT_FUER_EINEN_BUTLER` (~Zeile 105): `"ToolSearch"` ergänzen. Kuro suchte dreimal nach
   `beauftrage`, das längst im Katalog stand.
3. **Berichte ohne englischen Vorspann.** `gateway/haus.ts` ~Zeile 507: der Bericht ist der letzte
   Textblock. Beginnt er mit einem englischen Arbeitssatz („I have enough now for a solid… Let me
   compile…"), wird alles vor der ersten Markdown-Überschrift (`#`) bzw. vor dem ersten Absatz, der
   kein englischer Arbeitssatz ist, abgeschnitten. Als reine Funktion `ohneVorspann(text: string):
   string` in `haus.ts` exportieren, Tests: englischer Vorspann + `## Bericht` → ab `## Bericht`;
   rein deutscher Text bleibt unverändert; nur englischer Text ohne Überschrift bleibt unverändert
   (lieber zu viel als nichts).
4. **Persona.** `context/persona.ts` (der Kuro-Prompt; Größe vorher/nachher in Zeichen im Bericht):
   - Alle Postfächer gehören Jakob (die Konten aus `konten()` in `gateway/postfach.ts`; ihre Namen stehen
     nur in der `.env`, nie im Prompt-Text selbst).
   - Kuro spricht nie in der dritten Person über sich.
   - Nennt Jakob ein Ziel mit Zahlen, wiederholt Kuro es in einem Satz, bevor er beauftragt.
   Je höchstens zwei Zeilen; im Stil der vorhandenen Regeln (richtig/falsch-Beispiel, wenn die Datei
   das an der Stelle so macht).

**Nicht anfassen:** Bedienstete-Prompts in `context/bedienstete.ts`, die Oberfläche.

**Fertig, wenn:** vier Commits, Tests für 1 (falls ohne SDK möglich) und 3, `pnpm test` +
`pnpm typecheck` grün, Prompt-Größe vorher/nachher im Bericht.

## N6 · Postfach-Suche für die Korrespondenz
- Status: erledigt (2026-10-02, von Hand)
- Modell: sonnet

**Warum:** `liste` zeigt höchstens die 50 neuesten Mails; der TradingLab-Newsletter blieb deshalb
unauffindbar.

**Bauen:**
1. `gateway/postfach.ts`: neue Funktion `suche(alle: Konto[], opts: { konto?: string; abfrage:
   string; anzahl?: number }): Promise<Kopf[]>` neben `liste` (~Zeile 176), gleicher Rückgabetyp
   `Kopf`, gleiches Verbinden/Schließen wie `liste`. Bei Gmail-Konten (`imap.gmail.com`)
   IMAP-SEARCH mit `{ gmraw: abfrage }` (imapflow heißt das Feld `gmraw`, nicht `gmailRaw`), sonst
   `{ or: [{ from: abfrage }, { subject: abfrage }] }`. Treffer absteigend nach Datum, höchstens
   `anzahl` (Vorgabe 20, Höchstwert 50), dann die Köpfe per `client.fetch(uids, { envelope: true,
   flags: true }, { uid: true })`.
2. `gateway/postfach-werkzeuge.ts`, in `createLesePostfach`: Werkzeug `suche` (Felder `konto`,
   `abfrage` mit Beschreibung „Gmail-Syntax, z. B. from:tradinglab older_than:2y", `anzahl`), Ausgabe
   im selben Zeilenformat wie `liste`, `readOnlyHint: true`. Nur lesen — kein Verschieben, kein
   Markieren (`fetch` mit `markAsSeen: false` bzw. `BODY.PEEK`, wie `liste` es macht).
3. `liste` bekommt `vor?: number` (UID): nur Nachrichten mit kleinerer UID — zum Blättern.
4. Prompt der korrespondenz in `context/bedienstete.ts`: ein Satz, wann `suche` statt `liste`.

**Testen:** neue `gateway/postfach.test.ts`. Die Wahl des Suchkriteriums als reine Funktion
exportieren — `suchKriterium(konto: Konto, abfrage: string)` → `{ gmailRaw }` für Gmail-Konten (Host
aus `Konto`, wie `konten()` ihn setzt: Vorgabe `imap.gmail.com`), sonst `{ or: [{ from }, { subject }] }`
— und die testen, dazu die Begrenzung von `anzahl` (1–50). Kein echtes IMAP im Test.

**Echter Lauf:** einmal `suche` über das erste Konto mit `from:tradinglab` (Skript mit `npx tsx`, liest
die `.env` nur über den Code, der das ohnehin tut). Im Bericht **nur** die Zahl der Treffer — keine Betreffzeilen, keine Absender, keine Inhalte.

**Fertig, wenn:** Tests grün, Typecheck grün, Trefferzahl im Bericht.

## N7 · Kapitalplan statt Wochenziel
- Status: blockiert (wird für Sonnet genau beschrieben, Stand 02.10.)
- Modell: sonnet

Jakobs Kapitalplan (Start, Einzahlung je Monat, Ziel nach 12 Monaten) — die Zahlen stehen nur in
der `.env`, nie im Repo. `gateway/wochenziel.ts` rechnet noch gegen ein Wochenziel.
- Neue Stellschrauben `KURO_EINZAHLUNG_MONAT`, `KURO_ZIEL_EURO`, `KURO_ZIEL_START`,
  `KURO_ZIEL_MONATE` (Werte in der `.env`); die alte Wochenziel-Zahl entfällt.
- Backtest-Zeile: „Beitrag zum Kapitalplan: … % je Monat (nötig: … %)", gerechnet aus der `.env`.
- Akte: Stand gegen den Plan (Soll-Pfad je Monat mit Einzahlungen).
- Prompts von boerse und stratege: Kapitalplan statt Wochenziel; Ein-Prozent-Regel bleibt, bis
  Jakob sie selbst ändert.

## N10 · Versuchsbuch und Mehrfachtest
- Status: erledigt (2026-09-28, 4007b11 „Prüfung ehrlicher: Versuchsbuch, Sperrfrist, Schlussprobe“, von Hand; die Anzeige je Suche kommt mit Kuro OS)
- Modell: opus

„Nichts zählt die Zahl der probierten Varianten" ist seit S44 offen; am 27.09. waren es 22 an
einem Nachmittag, viele nirgends abgelegt. Bei 22 Versuchen mit 95-%-Intervall ist ein
Zufallstreffer zu erwarten.
- Jeder `backtest`/`universum`-Aufruf wird gebucht (Regel, Markt, Intervall, Kennzahlen) — je
  „Suche" (eine Suche = ein Auftrag der boerse; Kennung durchreichen).
- `kandidat` verlangt ab dann ein Intervall, das mit der Zahl der Versuche der Suche strenger wird
  (z. B. Bonferroni auf das Bootstrap-Intervall); die Schwelle steht im Bericht.
- Regeln, die vorher aus einer Quelle schriftlich festgelegt wurden (Setup-Karten, N11), bilden
  eine eigene Familie.
- Strategie-Ansicht: je Suche „n Versuche, k Kandidaten" (Versuche selbst im Archiv, N2).

## N11 · Lehrbuch und Setup-Karten
- Status: blockiert (wird für Sonnet genau beschrieben, Stand 02.10.)
- Modell: sonnet
- Braucht: N8

Wenn mindestens 30 Videos durchgearbeitet sind: `wissen/tradinglab/LEHRBUCH.md` nach Kapiteln
(Struktur, Liquidität, Order Blocks, FVG, Fibonacci, Volume Profile, Orderflow, Sessions, Risiko,
Psychologie), jede Aussage mit Video und Zeitmarke, Widersprüche markiert; je konkreter Strategie
eine Setup-Karte im Wortlaut (`wissen/tradinglab/karten/`). Werkzeug `im_lehrbuch_suchen` für die
boerse und den stratege (wie `im_archiv_suchen`) — **nicht für Kuro**, das Wissen gehört an den
Handelstisch (Jakob, 28.09.), und die Analyse-Reihenfolge (Struktur → Zonen → Auslöser)
kurz im Prompt der boerse. Grundlast messen und im Bericht nennen. Die festen Pfade (Inventar,
Notizen, Transkripte, Kalibrierung) stehen seit 28.09. im Prompt von boerse und stratege; Kuro
weiß nur, dass es die boerse fragt — `im_lehrbuch_suchen` ersetzt die Pfade, doppelt soll es nicht stehen.

## N12 · Smart-Money-Bausteine im Backtest
- Status: blockiert (wird für Sonnet genau beschrieben, Stand 02.10.)
- Modell: sonnet
- Braucht: N9

Als Code, ohne Blick in die Zukunft, je mit Test: Swing-Hochs/-Tiefs (Swing-Tief der letzten N
Kerzen und Williams-Fraktale gibt es seit N9), Unterstützungszone aus einem früheren Abprall und
Divergenz Kurs/Indikator (beide aus N9, nicht prüfbar ohne sie), Struktur (BOS/CHoCH),
Fair Value Gaps (offen/gefüllt), Order Blocks mit „unmitigated", Liquidity Sweep, Fibonacci-Zone
zum letzten Swing, Vortages- und Sitzungs-Hoch/-Tief, höheres Intervall als Filter, Teilgewinne.
Zerlegen in N12a–c. Danach die Setup-Karten (N11) 1:1 rechnen (Skript, wie N9).

## N13 · Längere Intraday-Historie für Forex und Indizes
- Status: blockiert (wird für Sonnet genau beschrieben, Stand 02.10.)
- Modell: sonnet

Yahoo hat EUR/USD 1h nur ~2 Jahre. Dukascopy (kostenlos, ohne Konto) als Quelle `dukascopy:`
prüfen und anbinden, in den Kerzenspeicher (`gateway/kerzenspeicher.ts`). Fallen messen, nicht
der Doku glauben (siehe `kuronami-kerzen-datenquellen`: CFD-Volumen, Zeitzonen, Lücken).

## N14 · Das Urteil im Bar-Replay prüfen
- Status: blockiert (wird für Sonnet genau beschrieben, Stand 02.10.)
- Modell: sonnet
- Braucht: N11

Was sich nicht mechanisieren lässt, spielt die boerse blind im Replay mit dem Lehrbuch durch
(zufällige Tage/Märkte, Zukunft nicht geladen), höchstens 30 Setups je Runde; der Code benotet wie
im Prognosebuch. Gebaut wird die Runde als Auftrag, den **Jakob** Kuro gibt — der Nachtbau baut
nur das Werkzeug und beschreibt im Bericht den Satz, den Jakob sagen kann.

## N15 · Neue Videos von selbst
- Status: blockiert (wird für Sonnet genau beschrieben, Stand 02.10.)
- Modell: sonnet

Wöchentlich das Inventar auffrischen (`werkzeuge/bin/yt-dlp --flat-playlist`, vom Server aus
möglich), neue Videos hinten anhängen, Kalibrierungs-Reihenfolge nicht verändern.

