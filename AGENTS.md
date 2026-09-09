# AGENTS.md

Dauerhafte Konventionen und Arbeitsregeln. Vollständiger Kontext steht in
`docs/ARCHITEKTUR.md`. Diese Datei ist die verdichtete Fassung für den Alltag beim
Codeschreiben.

## Tool-Namenskonvention

`namensraum.aktion`, kleingeschrieben, Punkt als Trenner, Aktion englisch.
Erlaubte Namensräume: `fs`, `web`, `exec`, `task`, `user`, `agent`, `mail`, `cal`,
`notes`, `memory`, `github`, `server`, `dev`. Ein neuer Namensraum braucht eine Begründung
in `docs/`. `dev.*` sind Prüf-Tools des Harness und gehören in keinen produktiven
Tool-Katalog.

`notes.*` und `memory.*` sind **nicht dasselbe** und werden es auch nicht: `notes.*` greift
auf den Obsidian-Vault des Nutzers zu (fremdes Gebiet, `hard_write`, jede Änderung mit
Freigabe), `memory.*` auf das Langzeitgedächtnis des Assistenten (eigene Ablage, `soft_write`,
eigenes Git-Repo). Begründung in `docs/GEDAECHTNIS.md`.

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
`redact` aus `runtime/redaction/`. Heute sind das sechs: Ereignisprotokoll, Artefaktmetadaten,
Prompt-Aufbau, die Freigabezeilen in `kuronami.approvals` (dort steht die Eingabe des
freigegebenen Aufrufs), der Notiztext im Langzeitgedächtnis und die Nachlauf-Zusammenfassung,
die es füllt. Kommt ein siebter dazu, wird er dort angeschlossen — nicht mit einer eigenen
Prüfung an der Aufrufstelle.

Der Gedächtnispfad ist der heikelste: eine Notiz mit einem Zugangsschlüssel läge nicht nur im
Klartext auf der Platte, sondern **dauerhaft in einer Git-Historie**, und der Recall legte sie
bei jedem thematisch verwandten Lauf erneut in den Modellkontext.

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

## Konventionen hierher, Erkenntnisse ins Gedächtnis

Was **immer** gilt — Arbeitsregeln, Vorlieben, Dauerregeln — steht in dieser Datei. Was
**geschehen** ist und was daraus folgt, steht als Notiz in `memory/`: Ereignisse mit Folgen
für später, widerlegte Annahmen, Entscheidungen samt ihrem Grund. Festgemacht ist die Trennung
am Feld `art` einer Notiz, das genau zwei Werte kennt (`ereignis`, `erkenntnis`) und keinen
für eine Konvention.

**Nicht alles wird gespeichert.** Die meisten Läufe hinterlassen keine Notiz; das ist der
Normalfall und keine Panne. Eine bewusste Nicht-Ablage steht als `memory.skipped` im
Protokoll, damit sie nicht wie eine vergessene Zusammenfassung aussieht.

Eine neue Notiz überschreibt nie eine alte. Widerspricht sie einer, wird das über `supersedes`
vermerkt und **beide bleiben stehen** — die Entscheidung, welche gilt, trifft der Leser mit
beiden Daten vor Augen, nicht der Speicher hinter seinem Rücken.

## Artefakte sind unveränderlich

Ein bestehender Artefaktname wird nie überschrieben, bei Kollision hängt der Speicher
`-2`, `-3` an.

## Jede Session endet mit einem Commit

Sobald `pnpm typecheck && pnpm lint && pnpm test` grün sind, wird committet — ohne
Rückfrage, ohne Ausnahme. Commit-Message im Format `S<Nr>: <Thema>`, wie die bisherige
Historie. Kein Zwischenzustand bleibt uncommittet liegen, auch nicht "bis zur nächsten
Freigabe". Das Fertig-Kriterium einer Session ist erst erfüllt, wenn Tests grün UND der
Commit geschrieben ist.

## Testbefehl

```
pnpm install && pnpm typecheck && pnpm lint && pnpm test
```

## Codestil

TypeScript, strict, ESM, NodeNext, Node 24 LTS. Biome für Lint und Format, kein ESLint,
kein Prettier. Kein ORM. pnpm als Paketmanager, vitest als Testrunner.
