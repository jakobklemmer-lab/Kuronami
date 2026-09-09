import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VaultEscapeError,
  VaultNotConfiguredError,
  VaultPathError,
  type VaultRoot,
  buildVaultRoot,
  resolveNotePath,
} from "./paths.js";

/**
 * Die Vault-Absicherung ohne Datenbank — das Gegenstück zu `tools/fs/paths.test.ts`. Hier
 * steht in seiner reinsten Form, dass `notes.*` den Obsidian-Vault nicht verlassen kann:
 * `../außerhalb`, ein absoluter Pfad und ein Symlink nach draußen.
 */

let vaultDir: string;
let outsideDir: string;
let vault: VaultRoot;

beforeAll(async () => {
  vaultDir = await mkdtemp(path.join(tmpdir(), "kuronami-vault-"));
  outsideDir = await mkdtemp(path.join(tmpdir(), "kuronami-vault-out-"));

  await mkdir(path.join(vaultDir, "Projekte"), { recursive: true });
  await writeFile(path.join(vaultDir, "Projekte", "Kuronami.md"), "# Kuronami\n\nNotiz.\n");
  await writeFile(path.join(outsideDir, "geheim.md"), "streng geheim");

  vault = await buildVaultRoot(vaultDir);
});

afterAll(async () => {
  await rm(vaultDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("buildVaultRoot", () => {
  it("löst die Wurzel über realpath auf", () => {
    expect(path.isAbsolute(vault.root)).toBe(true);
  });

  it("weist einen leeren Pfad ab (nicht konfiguriert)", async () => {
    await expect(buildVaultRoot(undefined)).rejects.toThrow(VaultNotConfiguredError);
    await expect(buildVaultRoot("   ")).rejects.toThrow(VaultNotConfiguredError);
  });

  it("weist einen nicht existierenden Vault ab", async () => {
    await expect(buildVaultRoot(path.join(outsideDir, "gibtsnicht"))).rejects.toThrow(
      VaultPathError,
    );
  });

  it("weist einen Vault ab, der kein Verzeichnis ist", async () => {
    await expect(buildVaultRoot(path.join(outsideDir, "geheim.md"))).rejects.toThrow(
      VaultPathError,
    );
  });
});

describe("resolveNotePath · gültige Kennungen", () => {
  it("nimmt eine relative Kennung im Vault an", async () => {
    const resolved = await resolveNotePath(vault, "Projekte/Kuronami.md");
    expect(resolved.rel).toBe("Projekte/Kuronami.md");
    expect(resolved.existed).toBe(true);
    expect(resolved.path.startsWith(vault.root)).toBe(true);
  });

  it("hängt .md an eine Kennung ohne Endung", async () => {
    const resolved = await resolveNotePath(vault, "Projekte/Kuronami");
    expect(resolved.rel).toBe("Projekte/Kuronami.md");
    expect(resolved.existed).toBe(true);
  });

  it("erlaubt eine noch nicht existierende Notiz unter einem existierenden Ordner", async () => {
    const resolved = await resolveNotePath(vault, "Projekte/Neu.md");
    expect(resolved.existed).toBe(false);
    expect(resolved.rel).toBe("Projekte/Neu.md");
  });
});

describe("resolveNotePath · abgewiesene Kennungen", () => {
  it("weist eine leere Kennung ab", async () => {
    await expect(resolveNotePath(vault, "")).rejects.toThrow(VaultPathError);
  });

  it("weist ein Nullbyte ab", async () => {
    await expect(resolveNotePath(vault, "Projekte/Kur\0onami.md")).rejects.toThrow(VaultPathError);
  });

  it("weist ../ nach außen ab, auch wenn nichts davon existiert", async () => {
    await expect(resolveNotePath(vault, "../../etc/passwd")).rejects.toThrow(VaultEscapeError);
    await expect(resolveNotePath(vault, "Projekte/../../draußen.md")).rejects.toThrow(
      VaultEscapeError,
    );
  });

  it("weist einen absoluten Pfad ab", async () => {
    await expect(resolveNotePath(vault, path.join(outsideDir, "geheim.md"))).rejects.toThrow(
      VaultEscapeError,
    );
    await expect(resolveNotePath(vault, "/etc/hosts")).rejects.toThrow(VaultEscapeError);
  });

  it("weist einen Symlink ab, der aus dem Vault herauszeigt", async () => {
    const linkPath = path.join(vaultDir, "flucht");
    try {
      await symlink(outsideDir, linkPath, "dir");
    } catch {
      // Windows ohne Symlink-Recht: dann ist dieser Pfad ohnehin nicht herstellbar.
      return;
    }
    await expect(resolveNotePath(vault, "flucht/geheim.md")).rejects.toThrow(VaultEscapeError);
    await rm(linkPath, { force: true });
  });
});
