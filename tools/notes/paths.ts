import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Harte Pfadabsicherung für die `notes.*`-Tools (S15). Dieselbe Rolle wie `fs/paths.ts` für
 * `fs.*` — und aus demselben Grund eine eigene Datei mit eigener Testdatei ohne Datenbank:
 * `notes.write` schreibt **direkt** in den echten Obsidian-Vault des Nutzers, ein Leck hier
 * schreibt irgendwohin auf die Platte.
 *
 * Anders als `fs.*` gibt es nur **eine** Zone: den Vault-Ordner aus `OBSIDIAN_VAULT_PATH`,
 * absolut und per `realpath` aufgelöst. Eine Notiz-Kennung ist immer **relativ** zu dieser
 * Wurzel; ein absoluter Pfad, ein Windows-Laufwerksbuchstabe, `..` und ein Symlink nach
 * außen werden abgewiesen — lexikalisch **und** nach Auflösung aller Symlinks, nach dem
 * Muster von `resolvePath` in `fs/paths.ts`.
 *
 * **Warum das Feld `note` heißt und nicht `path`.** Die Policy-Engine findet Pfade unter dem
 * Namen `path` und löst sie über den `fs`-Zonen-Resolver auf (`policy/resource.ts`). Der
 * kennt die `fs`-Zonen, nicht den Vault — ein `path`-Feld hier liefe also in `unresolvable`
 * und würde von der Engine abgelehnt (fail closed). Mit `note` bleibt die Ressource `none`,
 * die Stufe `hard_write` greift als Boden, und `notes.write` pausiert **immer** für eine
 * Freigabe (auch im Sessionmodus `accept_edits`, der nur Pfad-Aufrufe vorab entscheidet).
 */

/** Die Notiz-Kennung ist unbrauchbar (leer, kein String, Nullbyte). */
export class VaultPathError extends Error {}
/** Die Kennung zeigt — lexikalisch oder über einen Symlink — aus dem Vault heraus. */
export class VaultEscapeError extends Error {}
/** `OBSIDIAN_VAULT_PATH` ist nicht gesetzt; die `notes.*`-Tools sind nicht bedienbar. */
export class VaultNotConfiguredError extends Error {}

export interface VaultRoot {
  /** Absolut, bereits durch `realpath` aufgelöst. Kein abschließender Trenner. */
  root: string;
}

/**
 * Baut die Vault-Wurzel. Fabrik, keine Modul-Konstante — die Konfiguration bleibt beim
 * Aufrufer (`runtime/loop/api.ts`), Tests zeigen sie auf ein Wegwerf-Verzeichnis.
 *
 * Die Wurzel wird per `realpath` kanonisiert (wie in `buildFsZones`, S08): `os.tmpdir()` und
 * `/var` auf macOS sind selbst Symlinks, ohne die Auflösung vergliche die Containment-Prüfung
 * später einen aufgelösten Ist-Pfad gegen eine nicht aufgelöste Wurzel. Ein fehlender oder
 * kein-Verzeichnis-Vault ist eine **falsche Konfiguration** und wirft hier — er soll
 * auffallen, nicht still ein leeres Verzeichnis erzeugen (dieselbe Haltung wie die Quellzone
 * in `buildFsZones`).
 */
export async function buildVaultRoot(vaultPath: string | undefined): Promise<VaultRoot> {
  const raw = vaultPath?.trim();
  if (!raw) {
    throw new VaultNotConfiguredError(
      "OBSIDIAN_VAULT_PATH ist nicht gesetzt: die notes.*-Tools brauchen einen Vault-Pfad und sind ohne ihn nicht bedienbar.",
    );
  }
  const resolved = path.resolve(raw);
  let root: string;
  try {
    root = await realpath(resolved);
  } catch (cause) {
    throw new VaultPathError(
      `Obsidian-Vault "${resolved}" ist nicht erreichbar (OBSIDIAN_VAULT_PATH). Er muss existieren, bevor die notes.*-Tools laufen.`,
      { cause },
    );
  }
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new VaultPathError(`Obsidian-Vault "${root}" ist kein Verzeichnis.`);
  }
  return { root };
}

export interface ResolvedNote {
  /** Absoluter, symlink-freier Pfad innerhalb des Vaults. Nur dieser geht an eine `fs`-Operation. */
  path: string;
  /** Vault-relativ, mit `/` als Trenner — eine stabile Kennung. `notes.*` nimmt sie unverändert wieder an. */
  rel: string;
  /** true, wenn die Datei existiert; false, wenn eine Endkomponente neu wäre. */
  existed: boolean;
}

/** Hat die Kennung schon eine Dateiendung? Sonst hängt der Resolver `.md` an (Obsidian-Konvention). */
const HAS_EXTENSION = /\.[a-z0-9]+$/i;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

/**
 * Löst eine Notiz-Kennung zu einem absoluten, symlink-freien Pfad im Vault auf — oder wirft.
 * Eine Kennung ohne Endung bekommt `.md`. Der Rest ist die Logik aus `fs/paths.ts`, auf eine
 * Zone eingedampft.
 */
export async function resolveNotePath(vault: VaultRoot, input: string): Promise<ResolvedNote> {
  if (typeof input !== "string" || input.trim() === "") {
    throw new VaultPathError("Notiz-Kennung fehlt oder ist leer");
  }
  if (input.includes("\0")) {
    throw new VaultPathError("Notiz-Kennung enthält ein Nullbyte");
  }
  if (path.isAbsolute(input) || WINDOWS_DRIVE.test(input)) {
    throw new VaultEscapeError(
      `"${input}" ist ein absoluter Pfad; erwartet wird eine Kennung relativ zum Vault (z. B. "Projekte/Kuronami").`,
    );
  }

  const withExt = HAS_EXTENSION.test(input) ? input : `${input}.md`;
  const lexical = path.resolve(vault.root, withExt);

  // Erste, rein lexikalische Prüfung: fängt `../../etc/passwd` auch dann, wenn nichts davon
  // existiert, und hält `realpath` von Pfaden fern, die ohnehin außerhalb liegen.
  if (!contains(vault.root, lexical)) {
    throw new VaultEscapeError(`"${input}" liegt außerhalb des Obsidian-Vaults`);
  }

  // Zweite Prüfung nach Auflösung aller Symlinks: ein Pfad, der eben noch drin lag, kann über
  // einen Symlink nach draußen zeigen.
  const { real, existed } = await realpathDeepest(lexical);
  if (!contains(vault.root, real)) {
    throw new VaultEscapeError(
      `"${input}" verlässt den Obsidian-Vault über einen Symlink (Ziel: ${real})`,
    );
  }

  return { path: real, rel: vaultRelative(vault.root, real), existed };
}

/**
 * Liegt `p` auf oder unter `root`? Rein lexikalisch — beide müssen absolut und normalisiert
 * sein. `path.relative` trägt die Last: ein Ergebnis mit `..` am Anfang oder selbst absolut
 * (anderes Laufwerk unter Windows) heißt "außerhalb". Wortgleich mit `contains` in `fs/paths.ts`.
 */
function contains(root: string, p: string): boolean {
  if (p === root) return true;
  const rel = path.relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Vault-relativer Pfad mit `/` als Trenner. */
function vaultRelative(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/**
 * `realpath` auf den tiefsten existierenden Vorfahren von `p`; der noch nicht existierende
 * Rest wird unverändert wieder angehängt. So wirkt die Symlink-Auflösung auch auf einen Pfad,
 * dessen letzte Komponente(n) noch fehlen (der Normalfall bei `notes.write` auf eine neue
 * Notiz). Wortgleich mit `realpathDeepest` in `fs/paths.ts`.
 */
async function realpathDeepest(
  p: string,
  tail: string[] = [],
): Promise<{ real: string; existed: boolean }> {
  try {
    const real = await realpath(p);
    return tail.length === 0
      ? { real, existed: true }
      : { real: path.join(real, ...tail), existed: false };
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") throw error;
    const parent = path.dirname(p);
    if (parent === p) {
      throw new VaultEscapeError(
        `Kein Teil des Pfades "${p}" existiert; er lässt sich nicht gegen den Vault prüfen`,
      );
    }
    return realpathDeepest(parent, [path.basename(p), ...tail]);
  }
}
