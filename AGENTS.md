# AGENTS.md

Dauerhafte Konventionen und Arbeitsregeln. Vollständiger Kontext steht in
`docs/ARCHITEKTUR.md`. Diese Datei ist die verdichtete Fassung für den Alltag beim
Codeschreiben.

## Tool-Namenskonvention

`namensraum.aktion`, kleingeschrieben, Punkt als Trenner, Aktion englisch.
Erlaubte Namensräume: `fs`, `web`, `exec`, `task`, `user`, `agent`, `mail`, `cal`,
`notes`, `notion`, `github`, `server`. Ein neuer Namensraum braucht eine Begründung
in `docs/`.

## Einheitliche Rückgabehülle

Jedes Tool liefert genau diese Form zurück:

```json
{
  "status": "ok",
  "summary": "kurze Zusammenfassung",
  "structured": {},
  "artifact_refs": [],
  "preview": []
}
```

`status` ist `ok` oder `error`.

## Fehler nie verstecken oder glätten

Fehlgeschlagene Aktionen, Stacktraces und Ablehnungsgründe bleiben im Verlauf und im
Fehlertext erhalten. Kein Abfangen, das den Fehler in eine freundliche Zusammenfassung
verwandelt.

## Checkpoint vor und nach jedem Seiteneffekt

Jeder externe Seiteneffekt läuft in einer Ausführungshülle mit `step_id` als
Idempotenzschlüssel. Ohne Checkpoint vor und nach dem Seiteneffekt ist Wiederaufnahme
nicht sicher und ein Replay kann die Aktion doppelt ausführen.

## Schema-Änderungen nur über Migrationen

Nummerierte SQL-Dateien in `runtime/db/migrations/`, kein ORM. Keine manuellen
Schemaänderungen an der laufenden Datenbank.

## Ereignistypen nie umbenennen

Namensform `namensraum.vergangenheitsform`. Neue Ereignistypen kommen dazu, bestehende
werden nie umbenannt und nie in ihrer Bedeutung verändert.

## Artefakte sind unveränderlich

Ein bestehender Artefaktname wird nie überschrieben, bei Kollision hängt der Speicher
`-2`, `-3` an.

## Testbefehl

```
pnpm install && pnpm typecheck && pnpm lint && pnpm test
```

## Codestil

TypeScript, strict, ESM, NodeNext, Node 24 LTS. Biome für Lint und Format, kein ESLint,
kein Prettier. Kein ORM. pnpm als Paketmanager, vitest als Testrunner.
