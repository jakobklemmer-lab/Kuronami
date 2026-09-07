# AGENTS.md

Dauerhafte Konventionen und Arbeitsregeln. Vollständiger Kontext steht in
`docs/ARCHITEKTUR.md`. Diese Datei ist die verdichtete Fassung für den Alltag beim
Codeschreiben.

## Tool-Namenskonvention

`namensraum.aktion`, kleingeschrieben, Punkt als Trenner, Aktion englisch.
Erlaubte Namensräume: `fs`, `web`, `exec`, `task`, `user`, `agent`, `mail`, `cal`,
`notes`, `github`, `server`, `dev`. Ein neuer Namensraum braucht eine Begründung
in `docs/`. `dev.*` sind Prüf-Tools des Harness und gehören in keinen produktiven
Tool-Katalog.

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

## Secrets laufen durch den Redaction-Filter

Jeder Schreibpfad, der Text auf die Platte oder in den Modellkontext bringt, läuft durch
`redact` aus `runtime/redaction/`. Heute sind das drei: Ereignisprotokoll, Artefaktmetadaten,
Prompt-Aufbau. Kommt ein vierter dazu, wird er dort angeschlossen — nicht mit einer eigenen
Prüfung an der Aufrufstelle.

Der Filter ist **nicht abschaltbar**, und er bekommt kein Flag. Die Reichweite ändert man
über die Musterliste in `runtime/redaction/patterns.ts`, also durch eine sichtbare Änderung
an einer versionierten Datei.

## Fehler nie verstecken oder glätten

Fehlgeschlagene Aktionen, Stacktraces und Ablehnungsgründe bleiben im Verlauf und im
Fehlertext erhalten. Kein Abfangen, das den Fehler in eine freundliche Zusammenfassung
verwandelt.

## `fs.*` bleibt in seinen Zonen

Jeder `fs.*`-Pfad wird über `resolvePath` aus `tools/fs/paths.ts` aufgelöst — relativ zur
Workspace-Wurzel, danach lexikalisch und nach Auflösung aller Symlinks gegen zwei Zonen
geprüft. Ein Pfad außerhalb beider wird abgewiesen (`PathEscapeError`). Kein Handler öffnet
je die rohe Eingabe.

Zwei Zonen: die **Artefaktzone** (`ARTIFACT_ROOT`) ist frei beschreibbar, die **Quellzone**
(Workspace-Wurzel) nur lesbar — ein Schreibzugriff dorthin braucht eine Freigabe, die erst
die Policy-Engine (S11) erteilt. `..`, absolute Ausbrüche und Symlinks nach außen werden
nicht toleriert; das ist keine Konfigurationsfrage.

## Vor einem Edit erst lesen

`fs.edit` verlangt `expected_sha256` aus dem letzten `fs.read` und bricht ab, wenn die Datei
sich seither geändert hat. Ein Edit ohne frischen Lesestand ist ein stiller Überschreiber.

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
