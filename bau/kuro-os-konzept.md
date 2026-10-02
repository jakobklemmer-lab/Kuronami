# Kuro OS, dritter Wurf — das Konzept

Verbindlich für alle Aufgaben N19a–N19f. Wer baut, liest das zuerst und hält sich daran; kleine
Entscheidungen im Rahmen dieses Konzepts trifft er selbst und nennt sie im Bericht.

## Jakobs Auftrag (02.10. abends, gekürzt)

Die Desktop-App neu gestalten und in die vorhandene Anwendung einbauen — eine funktionierende
Umsetzung, kein Entwurf. Kuro ist der Butler und das Zentrum. **Der animierte Orb und die
Agenten-Orbs (Satelliten) bleiben** — sie sind Kuronamis Identität. Der zweite Wurf (Statusleiste,
Fenster, Dock unten) wirkt „wie ein Mac-Desktop von 2010" und wird neu gedacht. Die Präsenz-Seite
(Zimmerstimmung, Kuro, Aktivität, Status) gibt Stimmung und Marke vor, nicht das Layout. Märkte,
Analysen, Strategien funktionieren und bleiben fachlich unverändert; Gruppierung und Navigation
dürfen neu sein. Für das Studium zählen Mail, Recherche, Kalender, Obsidian (Brain). Während
Agenten arbeiten, soll man sehen, **wer woran arbeitet und in welchem Zustand** — lange Phasen
dürfen sich nicht leer anfühlen. Übersichtlich bleiben, auch mit vielen Bereichen.

Gestaltung: hochwertig, eigenständig, persönlich, ruhig, einladend, lebendig — durch Hierarchie,
Typografie, Abstände, Materialität und gezielte Bewegung. **Nicht:** macOS/Windows nachbilden, ein
dauerhaftes App-Dock, Jarvis-Futurismus, austauschbare KI-Dashboard-Optik. Bewegung erklärt
Zustände und Interaktionen und überdeckt nie die Arbeit. Kuro soll in der Desktop-App **optional
außerhalb des Hauptfensters** als beweglicher Begleiter präsent sein — erreichbar, zurücknehmbar,
nie über wichtigen Inhalten. Eine 3D-Figur ist eine spätere Möglichkeit, kein Ersatz für den Orb.
Keine erfundenen Daten, kein Framework-Wechsel.

## Die Idee: Kuros Arbeitszimmer

Ein Haus mit **drei Räumen** und Kuro, der in jedem Raum seinen Platz hat.

| Raum | Was drin ist | Bestehende Ansichten |
|---|---|---|
| **Kuro** (Empfang) | Gespräch, „Heute", „Im Haus" | `welle/faden.ts`, `praesenz/sphaere.ts`, Daten wie unten |
| **Handel** | Märkte · Strategien · Analysen | `views/trading.ts`, `views/strategien.ts`, `views/analysen.ts` |
| **Studium** | Brain · Post · Recherche · Kalender | `os/brain.ts` (Obsidian, Graph), `views/mail.ts`, `views/research.ts`, `views/calendar.ts` |

**System** und **Einstellungen** sind keine Räume. Sie öffnen als **Blatt von rechts** über dem
aktuellen Raum (Haus-Menü oben rechts, ⌘, für Einstellungen, ⌘K-Starter) und schließen mit Esc.

## Aufbau des Hauptfensters

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 黒波  Handel  Kuro  Studium         Märkte  Strategien  Analysen    ⌘K  ⚙  │  Kopf (52 px)
├───────────────────────────────────────────────────────────┬───────────────┤
│                                                           │  ◉  Orb 120px │
│   Der Raum: hier Märkte (Chart, Liste, Überblick)         │  Kuro denkt…  │  Kuros Platz
│                                                           │  ── Im Haus ──│  (340 px,
│                                                           │  ● Börse  4:12│  einklappbar
│                                                           │    prüft DAX… │  auf 64 px)
│                                                           │  ── Gespräch ─│
│                                                           │  letzte Zeilen│
│                                                           │  [Kuro fragen]│
└───────────────────────────────────────────────────────────┴───────────────┘
```

- **Raumwechsel = die Überschrift.** Oben links stehen die drei Räume als Wörter in Shippori
  Mincho: der aktuelle groß (≈ 26 px) in Mond, die anderen klein (≈ 15 px) in Nebel daneben.
  ⌘1 / ⌘2 / ⌘3. Keine Seitenleiste, kein Dock.
- **Teile eines Raums** (Märkte · Strategien · Analysen; Brain · Post · Recherche · Kalender)
  stehen in derselben Kopfzeile rechts daneben, Figtree 14 px, der gewählte mit kurzem
  Laternen-Strich darunter (wie im ersten Wurf). Der zuletzt gewählte Teil je Raum bleibt
  gemerkt (localStorage).
- **Kuros Platz** rechts in jedem Raum außer „Kuro": Orb mit Satelliten (echtes
  `mountSphaere`, ≈ 120 px), Zustandssatz, „Im Haus" (laufende Aufträge), die letzten
  Gesprächszeilen (`mountFaden` mit `nurLetzte`) und die Eingabe. Einklappbar (⌘J) auf einen
  64-px-Streifen mit kleinem Orb und Zahl laufender Aufträge; Zustand gemerkt.
- **Raum „Kuro"**: der Empfang. Links groß der Orb vor dem Fenster des Zimmers (Bildausschnitt aus
  `ui/assets/night.jpg`, weich, nicht als Tapete über allem), darunter „Heute"; rechts das ganze
  Gespräch mit Eingabe. „Im Haus" steht hier ausführlich.
- **⌘K-Starter** bleibt (Räume, Teile, Brain-Notizen, Befehle, „Kuro fragen: …").
- **Drag-and-drop** ins Brain bleibt.
- Das alte **Fenster-System mit Dock** fliegt raus (`ui/os/fenster-logik.ts` samt Test, Dock,
  Menüleiste, Insel). Die Brain-App, der Graph, der Starter und die Eingabe-Bausteine bleiben.

## „Heute" und „Im Haus" — nur echte Daten

- **Heute** (Raum Kuro): Termine von heute (`GET /integrations/calendar`; ohne Zugang ein Satz
  „Kalender noch nicht verbunden" mit Hinweis, wo), ungelesene Post (`GET /integrations/mail`,
  `unreadCount`, Klick fragt Kuro), Nachtbau (`GET /integrations/nachtbau`), Abo (`GET
  /integrations/abo`). Je ein Satz, je ein Ziel beim Klick.
- **Im Haus**: aus `gespraech.arbeit` (wer, seit, stand, auftrag), den Signalen `bediensteter`
  (beginnt/stand/fertig) und `gespraech.chronik`. Je laufender Auftrag eine Zeile: Farbpunkt in
  der Farbe seines Satelliten (`agentColor(werName(wer))` aus `ui/vendor/kuronami-orb.mjs`), Name,
  Auftrag (eine Zeile), letzter Stand, laufende Zeit (mm:ss, tickt jede Sekunde), darunter eine
  feine, langsam wandernde Linie in seiner Farbe, solange er arbeitet — das ist die Rückmeldung in
  langen Phasen, kein Fortschrittsbalken mit erfundener Prozentzahl. Fertig: Zeile wird ruhig,
  „fertig nach 3:12", wandert nach 20 s in „Zuletzt" (höchstens fünf). Kuros eigener Zustand
  (`gespraech.zustand`/`detail`, z. B. „nutzt die Kurse") steht als oberste Zeile, wenn er nicht
  ruht. Nichts davon wird erfunden; fehlt eine Angabe, fehlt die Zeile.

## Material, Schrift, Farbe

- Farben aus `welle.css` (`--tusche`, `--see`, `--mond`, `--nebel`, `--dunst`, `--laterne`,
  `--kuro`, `--steigt`, `--faellt`); **Laterne = Jakobs Licht** (seine Wahl, sein Senden, sein
  Tippen), **Kuros Licht = Zustandsfarbe** (`ZUSTAND_FARBE`).
- **Material: matt, warm, ruhig.** Grund ein dunkles, leicht warmes Tusche-Braun-Grün
  (Verlauf von `#0b1215` nach `#0e1412`), Flächen als matte Tafeln (`rgba(232,239,241,0.035)`,
  1-px-Haarlinie `rgba(232,239,241,0.07)`, Radius 14 px), **kein** Glas mit Unschärfe überall,
  keine Schatten-Orgien. Die Zimmerstimmung kommt aus dem Fensterbild im Raum Kuro, dem warmen
  Laternenlicht an gewählten Dingen und Kuros kühlem Licht.
- Schrift: Shippori Mincho für Räume, Grüße, Notiztitel; Figtree für alles, was man bedient.
  Keine Versalien-Etiketten, keine Mittelpunkt-Ketten als Schmuck, keine Monospace-Etiketten.
- Linksbündig. Höchstbreiten für Lesetext (≈ 72 Zeichen); der Chart darf breit.

## Bewegung

- Raumwechsel: Inhalt blendet in 180 ms über, mit 12 px Versatz in Richtung des Raums (links/
  rechts nach Reihenfolge) — dieselbe Leichtigkeit wie die Fahrt der Welle, nur klein.
- Kuros Platz klappt in 220 ms (Breite), Inhalte blenden mit.
- „Im Haus": neue Zeile wächst in der Höhe herein (160 ms), die Arbeitslinie wandert langsam
  (2,4 s je Durchgang), sonst steht alles still. Im Stand bewegt sich nur der Orb.
- `prefers-reduced-motion`: alles ohne Animation, die Arbeitslinie als ruhige Linie.

## Kuro auf dem Desktop (Electron)

- Das bisherige Insel-Fenster oben in der Mitte (`desktop/insel.html`) wird ersetzt durch den
  **Begleiter**: ein kleines, randloses, durchsichtiges Fenster (≈ 168 × 168 px), immer oben, auf
  allen Schreibtischen, das die Seite `/os/begleiter/` vom Server lädt — also den **echten Orb**
  (`mountSphaere`) mit Satelliten, im selben Speicher angemeldet wie das Hauptfenster.
- Ziehen verschiebt ihn (Position gemerkt in `kuro-os.json`); er rastet nicht ein, bleibt aber auf
  dem Schirm. Klick öffnet daneben eine kleine Sprechblase (letzte Antwort, Eingabe, „Kuro OS
  öffnen"); ein zweiter Klick oder Esc schließt sie. Doppelklick holt das Hauptfenster.
- **Zurücknehmen:** an den Bildschirmrand gezogen, schiebt er sich halb hinaus und zeigt nur eine
  Kante mit Licht; Tray-Schalter „Kuro auf dem Desktop" blendet ihn ganz aus. Vorgabe: er zeigt
  sich, wenn das Hauptfenster nicht vorn ist; ist es vorn, ist Kuro dort und der Begleiter weg.
- Durchklickbar außerhalb des Orbs (`setIgnoreMouseEvents(true, { forward: true })`, im Orb an).
- Sprechtaste (uiohook) bleibt; während sie gedrückt ist, leuchtet der Begleiter im Zuhör-Zustand.
- Mitteilungen, Tray, Autostart, ⌥⌘K bleiben.

## Was bleibt, was geht

Bleibt: `ui/os/brain.ts`, `graph.ts`, `graph-sim.ts`, `weg.ts`, `start.ts` (Brücke zur App), der
Starter und die Eingabe aus `os.ts`, alle `ui/views/*`, `ui/welle/*`-Bausteine, Gateway-Routen,
`desktop/main.cjs` (Sprechtaste, Tray, Rechte, Einrichtung), `desktop/preload.cjs`.
Geht: Fenster-System, Dock, Menüleiste mit Insel (`ui/os/fenster-logik.ts`, die Dock-/Fenster-
Teile in `os.ts`/`os.css`), `desktop/insel.html`, `desktop/insel-preload.cjs`.

## Prüfen

- `pnpm test`, `pnpm typecheck`, `npx biome check` grün vor jedem Commit.
- Oberfläche ansehen: im Worktree `UI_PORT=3101 npx tsx ui/dev.ts &` starten (spricht mit dem
  laufenden Gateway auf Port 3000), mit Playwright
  (`/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`, Chromium mit
  `--use-gl=swiftshader --enable-unsafe-swiftshader`) bei 1512×945 und 3440×1440 Bilder nach
  `/tmp/nachtbau-bilder/` machen, ansehen, verbessern; den Server am Ende beenden. Anmeldung:
  `localStorage["kuronami.webToken"]` = Wert von `GATEWAY_WEB_TOKEN` aus `/opt/kuronami/.env`
  (nur lesen, nie ins Repo). WebGL fehlt in dieser VM: der Orb zeigt dort seine Fehlermeldung —
  das ist kein Fehler der Gestaltung.
- Electron: `xvfb-run -a /opt/kuronami/desktop/node_modules/electron/dist/electron --no-sandbox <Probe>`
  (Muster: Probe-Skript, das `app.setPath("userData", …)` setzt und `desktop/main.cjs` lädt).
