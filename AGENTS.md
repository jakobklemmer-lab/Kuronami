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

## Jedes Tool hat eine Risikostufe

`read`, `soft_write`, `hard_write` oder `destructive` (Abschnitt 10). **Kein Tool ohne
Zuordnung**, und keine Vorgabe für ein Tool, das keine angibt: eine geratene Stufe sieht aus
wie eine entschiedene. Geprüft wird an zwei Toren, in der Registry und in der Policy-Engine.

Ein Tool, das einen Pfad entgegennimmt, nennt das Feld `path`; eines mit einer Adresse `url`.
Das ist keine Empfehlung, sondern eine Prüfung in der Registry: unter anderen Namen fände die
Policy-Engine weder Pfad noch Domain, und der Aufruf liefe an jeder Zonen-, Geheimnis- und
Domainregel vorbei — unbemerkt, weil er ja durchginge.

## Kein Tool läuft ohne Policy-Prüfung

Der Router ruft die Engine (`policy/engine.ts`) zwischen Schema-Prüfung und Ausführung, für
beide Ausführungswege. Ein Handler bekommt seine Aufrufdaten nur mit einer `PolicyGrant`, und
die stellt allein die Engine aus — der Weg daran vorbei ist nicht verboten, es gibt ihn nicht.

Es gewinnt immer die schärfste Aussage aller Ebenen. Ein `allow` aus einer Regel oder einem
Hook senkt nichts; nur der Sessionmodus darf den Boden senken, und nie bei `destructive`.

## Secrets laufen durch den Redaction-Filter

Jeder Schreibpfad, der Text auf die Platte oder in den Modellkontext bringt, läuft durch
`redact` aus `runtime/redaction/`. Heute sind das vier: Ereignisprotokoll, Artefaktmetadaten,
Prompt-Aufbau und die Freigabezeilen in `kuronami.approvals` (dort steht die Eingabe des
freigegebenen Aufrufs). Kommt ein fünfter dazu, wird er dort angeschlossen — nicht mit einer
eigenen Prüfung an der Aufrufstelle.

Der Filter regelt das **Durchsickern**, nicht den **Zugriff**. Wer eine Datei öffnen darf,
deren Inhalt per Bauart ein Geheimnis ist (`.env`, `*.pem`, `.ssh/`), entscheidet die
Policy-Engine über die Geheimnisklassen in `policy/secrets.ts`, und jeder solche Zugriff
hinterlässt ein `policy.secret_accessed`.

Ein Wert, der als Schlüssel wieder nachgeschlagen wird — `idempotency_key`, `task_id`, der
Subjektschlüssel einer Freigabe — darf vom Filter nicht verändert werden. Passiert es doch,
wird abgewiesen statt einen kaputten Schlüssel entstehen zu lassen.

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
(Workspace-Wurzel) braucht zum Schreiben eine Freigabe — ein Schreibzugriff dorthin ist
hartes Schreiben, und darüber entscheidet die Policy-Engine. `..`, absolute Ausbrüche und
Symlinks nach außen werden nicht toleriert; das ist keine Konfigurationsfrage.

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
