Die fünf Kern-Primitive `fs.list`, `fs.read`, `fs.write`, `fs.edit`, `fs.search` (S08,
Abschnitt 9). Sie laufen über `tools/router.ts` und damit durch die Ausführungshülle aus
`runtime/steps/` — Checkpoint davor und danach.

`paths.ts` ist die harte Pfadabsicherung und steht bewusst getrennt, mit einer eigenen
Testdatei ohne Datenbank. `buildFsZones` legt zwei Zonen mit absoluter, per `realpath`
aufgelöster Wurzel an: `artifact` (`ARTIFACT_ROOT`, frei beschreibbar) und `source` (die
Workspace-Wurzel, nur lesbar — Schreiben braucht eine Freigabe, die erst S11 erteilt).
`resolvePath` löst einen Eingabepfad auf und weist ihn ab, wenn er lexikalisch **oder** nach
Auflösung aller Symlinks außerhalb beider Zonen landet. Kein Handler in `tools.ts` arbeitet
je mit einem Pfad, der nicht durch `resolvePath` gegangen ist.

`fs.read` gibt kleine Dateien ganz zurück, große als Ausschnitt plus Artefakt-Handle;
`fs.edit` verlangt `expected_sha256` aus dem letzten `fs.read` und bricht bei
zwischenzeitlicher Änderung ab. `fs.search` liefert Treffer mit Zeilennummer, nie ganze
Dateien.
