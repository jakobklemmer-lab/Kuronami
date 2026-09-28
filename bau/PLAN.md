# Bauplan des Nachtbaus

Jakob hat den Plan am 27.09.2026 abends freigegeben: „du kannst dafür einen Loop bauen, damit das
jede Nacht außerhalb meiner Nutzerzeiten automatisch nach Plan fertig gebaut wird." Der Nachtbau
(`bau/nachtbau.sh`) nimmt jede Nacht die erste Aufgabe mit Status `offen`, `in Arbeit` oder
`wartet`, deren „Braucht" erledigt ist, und arbeitet sie in einem eigenen Lauf ab. Die
Arbeitsregeln stehen in `bau/auftrag.md`, die Berichte unter `bau/berichte/`.

**Modell:** seit 28.09. baut der Nachtbau jede Aufgabe mit **Opus 5.5**, in einem eigenen Lauf je
Aufgabe (Jakob: „ich ertrage Sonnet als Codingmaschine nicht mehr"). Die Zeilen „Modell:" unten sind
nur noch Beschreibung; der Läufer setzt das Modell fest.

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

## N4 · Das Abo-Limit reißt den Faden nicht mehr
- Status: offen
- Modell: opus

Am 27.09. um 13:49 stand in Kuros Antwort zweimal „You've hit your session limit · resets
5:20pm (UTC)"; der fertige Bericht der boerse lag da und kam erst, als Jakob um 17:28 „mach
weiter" schrieb.
- `gateway/agent.ts` erkennt die Grenze (Fehlertext und `SDKRateLimitInfo`) und antwortet selbst,
  ohne Modellaufruf, auf Deutsch in Kuros Ton mit Wiener Uhrzeit: wann es weitergeht.
- Berichte, die in dieser Zeit eintreffen (`#trageNach`), werden geparkt und nach dem Reset von
  selbst vorgetragen (Zeitpunkt aus der Grenzmeldung, sonst Abo-Stand aus `gateway/abo.ts`).
- Die SDK-Floskeln „Continue from where you left off." / „No response requested." dürfen nicht
  in Jakobs Verlauf oder die Sprachausgabe.
- Ein Bediensteter, der an die Grenze läuft, meldet „unterbrochen durch Abo-Limit bis HH:MM",
  nicht den englischen Rohtext.

Fertig, wenn: Tests mit nachgestellter Grenzmeldung decken Antwort, Parken und Nachtragen ab.

## N5 · Kleine Reparaturen an Kuro
- Status: offen
- Modell: opus

Alle aus dem Verlauf vom 27.09. belegt:
1. Bricht Kuro selbst einen Auftrag ab (`abbrechen`), kommt **kein** „Bericht eingetroffen"
   zurück (`gateway/haus.ts`, „auf Zuruf abgebrochen"). 13:35 führte das zu einem dritten Auftrag.
2. `ToolSearch` in `NICHT_FUER_EINEN_BUTLER` (`gateway/agent.ts`): Kuro suchte dreimal nach
   `beauftrage`, das längst im Katalog stand.
3. Berichte ohne englischen Vorspann („I have enough now for a solid… Let me compile…") — der
   Bericht beginnt bei der ersten Überschrift oder dem ersten deutschen Absatz.
4. Persona (`context/persona.ts` bzw. `workspace/CLAUDE.md`): alle drei Postfächer gehören Jakob;
   Kuro spricht nie in der dritten Person über sich („Kuro hat sich verhört, äh —"); ein Ziel mit
   Zahlen spiegelt er in einem Satz zurück, bevor er beauftragt (13:27–13:34: drei
   Missverständnisse, ein Auftrag mit falschen Zahlen).
5. ~~Eine Zeile in `workspace/CLAUDE.md`: „Was nachts gebaut wurde, steht in `notizen/nachtbau.md`."~~
   Erledigt am 28.09. von Hand, zusammen mit den Wegweisern auf `wissen/tradinglab/` (boerse,
   stratege; Kuro nur „frag die boerse") — Kuro fand morgens weder Transkripte noch Kalibrierung.

## N6 · Postfach-Suche für die Korrespondenz
- Status: offen
- Modell: opus

`liste` zeigt nur die 50 neuesten Mails; deshalb blieb der TradingLab-Newsletter unauffindbar.
Neues Werkzeug `suche` in `gateway/postfach-werkzeuge.ts` über IMAP-SEARCH; bei Gmail mit
`X-GM-RAW` (Gmails eigene Syntax: `from:tradinglab older_than:2y`), sonst Absender/Betreff/Text/
Zeitraum. Dazu `vor` (Blättern) in `liste`. Nur lesen, wie bisher.

Fertig, wenn: Tests mit nachgestelltem IMAP; im Bericht ein echter Suchlauf über
konto1 nach `from:tradinglab` mit der Zahl der Treffer (nur Zahl und Betreffzeilen, keine
Inhalte ins Git).

## N7 · Kapitalplan statt Wochenziel
- Status: offen
- Modell: opus

Jakob am 27.09. um 13:34: Start [Kapital], **[Einzahlung] Einzahlung je Monat**, Ziel **~[Ziel] nach 12
Monaten**. Die boerse hat gerechnet: 3,84 % (Einzahlung Monatsanfang) bis 4,17 % (Monatsende) je
Monat, ohne Handel ~5.100 €. `gateway/wochenziel.ts` rechnet noch gegen 100 €/Woche.
- Neue Stellschrauben `KURO_EINZAHLUNG_MONAT` (300), `KURO_ZIEL_EURO` (7000),
  `KURO_ZIEL_START` (2026-09-27), `KURO_ZIEL_MONATE` (12); die alte Wochenziel-Zahl entfällt.
- Backtest-Zeile: „Beitrag zum Kapitalplan: … % je Monat (nötig: 3,8–4,2 %)", gerechnet.
- Akte: Stand gegen den Plan (Soll-Pfad je Monat mit Einzahlungen).
- Prompts von boerse und stratege: Kapitalplan statt Wochenziel; Ein-Prozent-Regel bleibt, bis
  Jakob sie selbst ändert.

## N10 · Versuchsbuch und Mehrfachtest
- Status: offen
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
- Status: offen
- Modell: opus
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
- Status: offen
- Modell: opus
- Braucht: N9

Als Code, ohne Blick in die Zukunft, je mit Test: Swing-Hochs/-Tiefs (Swing-Tief der letzten N
Kerzen und Williams-Fraktale gibt es seit N9), Unterstützungszone aus einem früheren Abprall und
Divergenz Kurs/Indikator (beide aus N9, nicht prüfbar ohne sie), Struktur (BOS/CHoCH),
Fair Value Gaps (offen/gefüllt), Order Blocks mit „unmitigated", Liquidity Sweep, Fibonacci-Zone
zum letzten Swing, Vortages- und Sitzungs-Hoch/-Tief, höheres Intervall als Filter, Teilgewinne.
Zerlegen in N12a–c. Danach die Setup-Karten (N11) 1:1 rechnen (Skript, wie N9).

## N13 · Längere Intraday-Historie für Forex und Indizes
- Status: offen
- Modell: opus

Yahoo hat EUR/USD 1h nur ~2 Jahre. Dukascopy (kostenlos, ohne Konto) als Quelle `dukascopy:`
prüfen und anbinden, in den Kerzenspeicher (`gateway/kerzenspeicher.ts`). Fallen messen, nicht
der Doku glauben (siehe `kuronami-kerzen-datenquellen`: CFD-Volumen, Zeitzonen, Lücken).

## N14 · Das Urteil im Bar-Replay prüfen
- Status: offen
- Modell: opus
- Braucht: N11

Was sich nicht mechanisieren lässt, spielt die boerse blind im Replay mit dem Lehrbuch durch
(zufällige Tage/Märkte, Zukunft nicht geladen), höchstens 30 Setups je Runde; der Code benotet wie
im Prognosebuch. Gebaut wird die Runde als Auftrag, den **Jakob** Kuro gibt — der Nachtbau baut
nur das Werkzeug und beschreibt im Bericht den Satz, den Jakob sagen kann.

## N15 · Neue Videos von selbst
- Status: offen
- Modell: opus

Wöchentlich das Inventar auffrischen (`werkzeuge/bin/yt-dlp --flat-playlist`, vom Server aus
möglich), neue Videos hinten anhängen, Kalibrierungs-Reihenfolge nicht verändern.

