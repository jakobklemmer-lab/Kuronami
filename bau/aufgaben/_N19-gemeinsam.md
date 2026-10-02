<!-- Wird von jeder N19-Aufgabe gelesen. -->
## Für jede N19-Aufgabe

- **Zuerst** `bau/kuro-os-konzept.md` ganz lesen — der **Nachtrag vom 02.10., 21:45** gilt vor allem anderen (fünf Räume, Desktop-Hintergrund, Figur). Es ist verbindlich; kleine Entscheidungen in
  seinem Rahmen triffst du selbst und nennst sie im Bericht.
- Dann `git log --oneline -15` und den Status in `bau/PLAN.md`: Was hat ein früherer Lauf (oder
  Claude am Tag) von deiner Aufgabe schon gebaut? Darauf aufbauen, nichts doppelt.
- Modell: Du bist Opus 5.5. Jakob hat diese Nacht alle Grenzen aufgehoben; Schluss ist um 08:00.
  Nutze die Zeit für Qualität, nicht für Umfang über deine Aufgabe hinaus.
- Erhalte alle Fachfunktionen: Märkte (Chart, Zeichnungen, Alarme, Watchlist), Strategien,
  Analysen, Post, Kalender, Recherche, System, Einstellungen, Brain (Graph, Bearbeiten).
  Ihre Ansichten (`ui/views/*`, `ui/settings/view.ts`, `ui/os/brain.ts`) mountest du, du
  schreibst sie nicht um — höchstens CSS, damit sie im neuen Rahmen gut aussehen.
- Keine erfundenen Daten, keine Attrappen-Knöpfe: was da steht, funktioniert.
- In kleinen, grünen Schritten committen (`pnpm test`, `pnpm typecheck`, `npx biome check
  --write <Dateien>`). Rot am Ende heißt: die ganze Nacht-Arbeit dieser Aufgabe wird verworfen.
- Ansehen ist Pflicht und Arbeitsweise (siehe `bau/auftrag.md`, „Oberfläche: ansehen …"):
  Dev-Server im Worktree auf Port 3101, `UI_URL=http://localhost:3101 node
  /opt/kuronami/bau/ansehen.mjs "/os/"` nach **jedem** sichtbaren Schritt, Bilder ansehen,
  verbessern, wieder ansehen. Die Figur: `/os/begleiter/?vorschau`. Den
  Dev-Server darfst du dafür starten und musst ihn am Ende beenden (`kill %1`); andere Dienste nicht.
- Bericht `bau/berichte/<Datum>.md`, Abschnitt `## N19x · …`: was Jakob jetzt sieht, wie man es
  bedient, welche Entscheidungen du getroffen hast, was offen ist. Keine Bilder ins Repo.
- **Stopp:** Wird es für einen Lauf zu viel, baue einen in sich fertigen, grünen Teil, committe,
  setze den Status auf `in Arbeit (Stand …)` und beschreibe im Bericht genau, was fehlt.
