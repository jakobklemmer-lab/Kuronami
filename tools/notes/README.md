# Notizen-Tools · direkter Obsidian-Zugriff (S15)

`notes.read`, `notes.write` — direkter Dateizugriff auf den lokalen Obsidian-Vault, **ohne
n8n**. Der Vault-Pfad kommt aus `OBSIDIAN_VAULT_PATH`; `runtime/loop/api.ts` baut daraus die
`VaultRoot` (`paths.ts`), und jede Notiz-Kennung wird gegen diese eine Wurzel abgesichert.

Beide Tools laufen durch denselben Router wie `fs.*` — Ausführungshülle (S05), Policy-Engine
(S11), einheitliche Rückgabehülle.

## Pfadabsicherung (`paths.ts`)

Eigene Datei mit eigener Testdatei ohne Datenbank, dieselbe Rolle wie `fs/paths.ts`:
`notes.write` schreibt in den **echten** Vault des Nutzers, ein Leck hier schreibt irgendwohin
auf die Platte. Eine Notiz-Kennung ist immer **relativ** zum Vault; abgewiesen werden
(lexikalisch **und** nach Auflösung aller Symlinks):

- absoluter Pfad, Windows-Laufwerksbuchstabe
- `..` aus dem Vault heraus
- Nullbyte, leere Kennung
- Symlink, dessen Ziel außerhalb des Vaults liegt

Eine Kennung ohne Dateiendung bekommt `.md` (Obsidian-Konvention). `buildVaultRoot` wirft,
wenn `OBSIDIAN_VAULT_PATH` leer ist oder auf etwas zeigt, das kein Verzeichnis ist — eine
falsche Konfiguration soll auffallen (wie die Quellzone in `buildFsZones`).

## Warum das Feld `note` heißt und nicht `path`

Die Policy-Engine findet Pfade unter dem Namen `path` und löst sie über den `fs`-Zonen-
Resolver auf. Der kennt die `fs`-Zonen, nicht den Vault — ein `path`-Feld liefe in
`unresolvable` und würde abgelehnt (fail closed). Mit `note` bleibt die Ressource `none`, die
Stufe `hard_write` greift als Boden, und `notes.write` pausiert **immer** für eine Freigabe —
auch im Sessionmodus `accept_edits`, der nur Pfad-Aufrufe vorab entscheidet.

## Risikostufen

| Tool | Risikostufe | Verhalten |
| --- | --- | --- |
| `notes.read` | `read` | Volltext **immer** als Artefakt, Ausschnitt (`NOTES_READ_EXCERPT_MAX_CHARS`, 2000) im Kontext |
| `notes.write` | `hard_write` | pausiert für eine Freigabe, dann atomarer Schreibvorgang (tmp + fsync + rename) |

`notes.write` ist `hard_write`, obwohl Abschnitt 10 "Notizen schreiben" unter "Weiches
Schreiben" führt: der Session-Auftrag hebt das ausdrücklich an, und das ist auch die
strengere, richtige Lesart — ein direkter Schreibzugriff in den echten Vault ist nichts, was
"automatisch im Arbeitsverzeichnis" erlaubt (der Vault liegt außerhalb jeder `fs`-Zone).
`assertHardWriteGrant` prüft zusätzlich, dass die Engine denselben Aufruf als
`hard_write`/`destructive` freigegeben hat — Parität zu `assertWritableZone` in `fs/tools.ts`.

## Vertrauensstellung

Anders als bei `mail.*`/`web.*` ist der Notiz-Inhalt **vertrauenswürdig**: das eigene
Langzeitgedächtnis des Nutzers (Abschnitt 8), kein Fremdinhalt. Kein `trust: "untrusted"`,
keine Injection-Markierung.

## Im Katalog

Die `notes.*`-Tools kommen in den Katalog, sobald `OBSIDIAN_VAULT_PATH` gesetzt ist
(`buildCatalog({ obsidian: {} })`; `runtime/index.ts` schaltet das anhand der Umgebung). Ohne
Vault-Pfad bleibt der Fingerabdruck der aus S12/S13 (`v1-53a18ba0cb4e49c8`, 10 Tools) — ein
leeres `OBSIDIAN_VAULT_PATH` in der Umgebung schaltet nichts frei.
