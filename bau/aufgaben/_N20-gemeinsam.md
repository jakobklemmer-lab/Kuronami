<!-- Wird von jeder N20-Aufgabe gelesen. -->
## Für jede N20-Aufgabe (Endspurt)

**Was Endspurt ist.** Ein Teil im Raum Studium von Kuro OS, gebaut nach dem Vorbild von Lumivara
(ichbinsocooked.com): Prüfung anlegen → ganzen Stoff ablegen → Probeklausur mit Schwierigkeitsgrad
(Multiple Choice, offene Fragen, Falllösung) → Ergebnis je Kapitel → Lernplan bis zum Prüfungstag,
Lücken zuerst → Lernen im Originaltext, vorgelesen bis 2×, nach jedem kurzen Abschnitt eine Übung
oder ein Zuordnen-Spiel → „Geschafft. 14 min, 22 % Wissen“ → Stärken, Schwächen und
„sicher · unsicher · veraltet“ je Frage. Lumivaras Aussehen wird **nicht** kopiert; Endspurt sieht
aus wie Kuro OS.

**Aufbau (Jakobs Entscheidung, 04.10.):** Der Ablauf ist **Code** — Ablage, Gliederung, Auswertung
von Multiple Choice und Zuordnen, Lernplan, Fortschritt, Vorlesen. Zwischen zwei Klicks läuft kein
Agent. Was Urteil braucht — Fragen schreiben, Zusammenfassen, offene Antworten und Falllösungen
bewerten — macht **Shao-Min Cook**, eine neue Bedienstete (Sonnet). Der Code ruft sie über
`schreibeEinmal` (`gateway/einmal.ts`, ohne Werkzeuge); Kuro kann sie über `beauftrage` rufen
(„Was kann ich in … noch nicht?“). Ihr Name steht so in der Oberfläche: „Shao-Min Cook“, kurz
„Shao-Min“; Kennung im Code `shaomin`.

**Wo was liegt** (verbindlich, damit die vier Aufgaben zusammenpassen):
- Stoff, lesbar für Jakob und Kuro: `workspace/brain/Studium/<Name>/` (Markdown wie abgelegt,
  Bilder daneben, PDFs unter `Dateien/`, ihr Text als `<pdfname>.md`). Verzeichnisseite
  `brain/Studium/<Name>.md` und `brain/Studium/<Name>/Stand.md` schreibt Endspurt selbst
  (Frontmatter `erzeugt: true`). Pfade ins Brain immer über `brainPfad`/`sichererPfad`
  (`gateway/brain.ts`, `gateway/brain-routen.ts`) — nie selbst zusammensetzen.
- Maschinenstand, nicht im Brain: `workspace/studium/<id>/` — `pruefung.json`, `gliederung.json`,
  `fragen/<kapitelSchluessel>.json`, `verlauf.json`, `ton/`. `<id>` = Kleinbuchstaben-Slug des Namens.
- Gateway: `gateway/endspurt*.ts`, Routen unter `/integrations/endspurt…` mit `webPrincipal` wie
  `gateway/wissen.ts`; eingehängt in `gateway/server.ts` neben `wissenRouten`.
- Oberfläche: `ui/views/endspurt*.ts`, Stil in `ui/os/endspurt.css` (in `ui/os/index.html` nach
  `kuro-raum.css` einhängen).

**Regeln:**
- Zuerst `git log --oneline -15` und den Status in `bau/PLAN.md`: was eine frühere N20-Aufgabe
  schon gebaut hat, nutzen, nicht doppelt bauen. Die Schnittstellen oben gelten; ändert eine
  Aufgabe sie, steht das im Bericht.
- Du bist Opus 5.5. Jakob hat diese Nacht freigegeben (Schluss 08:00). Qualität vor Umfang über
  deine Aufgabe hinaus.
- **Ausgabeformat von Shao-Min: Markierungen, kein JSON** (so wie der Lehrgang, `gateway/lehrgang.ts`,
  `leseNotiz`). Parser tolerant: eine kaputte Frage wird verworfen und gezählt, nicht der ganze Lauf.
- **Nur Stoff, nichts erfinden:** Shao-Mins Prompts verlangen, dass Fragen, Musterlösungen und
  Erklärungen nur aus dem mitgegebenen Text kommen, mit Fundstelle (Abschnittstitel). Normen,
  Paragraphen, Fälle, Fristen nur, wenn sie im Text stehen.
- Ein Endspurt-Modellaufruf zur Zeit (Speicher: der Server hat 3,7 GB). Wer Jakob warten lässt
  (Bewerten, Übung), geht vor dem Vorbereiten im Hintergrund; ein laufender Aufruf wird nicht
  abgebrochen. Verbrauch wird gebucht (`wer: "shaomin"`, `wofuer` je Arbeit).
- Keine erfundenen Daten in der Oberfläche, keine Attrappen-Knöpfe. Testdaten sind erfundener
  Beispielstoff (zwei, drei kurze Kapitel, z. B. „Grundbegriffe des Vertragsrechts“ selbst
  geschrieben) — nie Jakobs Stoff, nie Fächer oder Prüfungen von Jakob ins Repo.
- Oberfläche nach `bau/kuro-os-konzept.md` (Material, Schrift, Farbe, Bewegung) und Jakobs Regel:
  „Besser schnell erkennbar zum Durchklicken als alles auf einmal.“ Je Bildschirm eine
  Hauptaktion; Zugeklapptes statt Wand. Akzentfarbe von Endspurt = Shao-Mins Farbe
  (`agentColor("shaomin")` aus `ui/vendor/kuronami-orb.mjs`), sparsam.
- Ansehen ist Pflicht (`bau/auftrag.md`): Dev-Server im Worktree auf 3101,
  `UI_URL=http://localhost:3101 node /opt/kuronami/bau/ansehen.mjs "/os/#/studium/endspurt"`,
  Bilder lesen, verbessern, wieder ansehen. Für Zustände hinter Klicks darfst du dir ein
  Wegwerf-Playwright-Skript unter `/tmp` schreiben (Muster: `bau/ansehen.mjs`).
- Kleine grüne Commits (`pnpm test`, `pnpm typecheck`, `npx biome check --write <Dateien>`).
- Bericht `bau/berichte/<Datum>.md`, Abschnitt `## N20x · …`: was Jakob jetzt sieht, wie man es
  bedient, Entscheidungen, was offen ist.
- **Stopp:** Wird es zu viel, einen in sich fertigen, grünen Teil bauen, committen, Status
  `in Arbeit (Stand …)`, im Bericht genau sagen, was fehlt.
- **Nicht anfassen:** Lehrgang, Brain-Pflege (`gateway/brain-pflege.ts`) außer wo eine Aufgabe es
  nennt, andere Ansichten, `desktop/`, `voice/`.
