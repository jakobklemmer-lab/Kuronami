import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FsZones,
  PathEscapeError,
  PathInputError,
  buildFsZones,
  displayPath,
  resolvePath,
} from "./paths.js";

/**
 * Die Pfadabsicherung ohne Datenbank. Hier stehen die beiden ersten S08-Testkriterien in
 * ihrer reinsten Form: `../../etc/passwd` und der Symlink nach außen.
 */

let sourceRoot: string;
let artifactRoot: string;
let outsideRoot: string;
let zones: FsZones;

beforeAll(async () => {
  // Verschachtelt wie im Betrieb: ARTIFACT_ROOT liegt unter der Workspace-Wurzel.
  sourceRoot = await mkdtemp(path.join(tmpdir(), "kuronami-paths-src-"));
  artifactRoot = path.join(sourceRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  outsideRoot = await mkdtemp(path.join(tmpdir(), "kuronami-paths-out-"));

  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "a.ts"), "const a = 1;\n");
  await writeFile(path.join(outsideRoot, "secret.txt"), "streng geheim");

  zones = await buildFsZones({ sourceRoot, artifactRoot });
});

afterAll(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

describe("buildFsZones", () => {
  it("löst beide Wurzeln über realpath auf", async () => {
    // mkdtemp liegt auf macOS unter /var -> /private/var; die Wurzel muss aufgelöst sein,
    // sonst schlägt jede spätere Containment-Prüfung fehl.
    expect(path.isAbsolute(zones.sourceRoot)).toBe(true);
    expect(zones.ordered.map((zone) => zone.name)).toContain("artifact");
    expect(zones.ordered.map((zone) => zone.name)).toContain("source");
  });

  it("stellt die speziellere (verschachtelte) Zone nach vorn", () => {
    // Die Artefaktzone liegt tiefer als die Quellzone und muss zuerst geprüft werden,
    // sonst würde ein Pfad unter artifacts/ als Quellzone eingestuft.
    expect(zones.ordered[0].name).toBe("artifact");
  });

  it("weist identische Wurzeln ab", async () => {
    await expect(buildFsZones({ sourceRoot, artifactRoot: sourceRoot })).rejects.toThrow(
      /dieselbe Wurzel/,
    );
  });
});

describe("resolvePath · gültige Pfade", () => {
  it("nimmt einen relativen Pfad in der Quellzone an", async () => {
    const resolved = await resolvePath(zones, "src/a.ts");
    expect(resolved.zone).toBe("source");
    expect(resolved.existed).toBe(true);
    expect(displayPath(zones, resolved.path)).toBe("src/a.ts");
  });

  it("stuft einen Pfad in der verschachtelten Artefaktzone als artifact ein", async () => {
    const resolved = await resolvePath(zones, "artifacts/plan.md");
    expect(resolved.zone).toBe("artifact");
    expect(resolved.existed).toBe(false);
  });

  it("nimmt einen absoluten Pfad an, der in einer Zone liegt", async () => {
    const resolved = await resolvePath(zones, path.join(sourceRoot, "src", "a.ts"));
    expect(resolved.zone).toBe("source");
  });

  it("erlaubt eine noch nicht existierende Datei unter einem existierenden Verzeichnis", async () => {
    const resolved = await resolvePath(zones, "src/neu/tief/datei.txt");
    expect(resolved.zone).toBe("source");
    expect(resolved.existed).toBe(false);
  });
});

describe("resolvePath · Traversal wird abgewiesen", () => {
  it("weist ../../etc/passwd ab", async () => {
    await expect(resolvePath(zones, "../../etc/passwd")).rejects.toThrow(PathEscapeError);
  });

  it("weist .. und ../nachbar ab", async () => {
    await expect(resolvePath(zones, "..")).rejects.toThrow(PathEscapeError);
    await expect(resolvePath(zones, "../nachbar")).rejects.toThrow(PathEscapeError);
  });

  it("weist einen Pfad ab, der erst hinaus und dann wieder herein zeigt", async () => {
    await expect(resolvePath(zones, "src/../../../etc")).rejects.toThrow(PathEscapeError);
  });

  it("weist einen absoluten Pfad außerhalb jeder Zone ab", async () => {
    await expect(resolvePath(zones, path.join(outsideRoot, "secret.txt"))).rejects.toThrow(
      PathEscapeError,
    );
  });
});

describe("resolvePath · Symlinks", () => {
  it("weist einen Symlink ab, der aus der Zone hinauszeigt", async () => {
    const linkDir = path.join(sourceRoot, "escape");
    await symlink(outsideRoot, linkDir, "junction");

    // Lesen "durch" den Symlink: der aufgelöste Pfad liegt außerhalb jeder Zone.
    await expect(resolvePath(zones, "escape/secret.txt")).rejects.toThrow(PathEscapeError);
    await expect(resolvePath(zones, "escape")).rejects.toThrow(/Symlink/);
  });

  it("erlaubt einen Symlink, der innerhalb der Zone bleibt", async () => {
    const target = path.join(sourceRoot, "src");
    const link = path.join(sourceRoot, "src-alias");
    await symlink(target, link, "junction");

    const resolved = await resolvePath(zones, "src-alias/a.ts");
    expect(resolved.zone).toBe("source");
    // Der zurückgegebene Pfad ist der aufgelöste, nicht der über den Symlink.
    expect(displayPath(zones, resolved.path)).toBe("src/a.ts");
  });

  it("stuft einen Symlink aus der Quell- in die Artefaktzone als artifact ein", async () => {
    const link = path.join(sourceRoot, "into-artifacts");
    await symlink(artifactRoot, link, "junction");

    const resolved = await resolvePath(zones, "into-artifacts/x.txt");
    expect(resolved.zone).toBe("artifact");
  });

  it("schützt die Quellzone vor einem Schreib-Symlink aus der Artefaktzone", async () => {
    // Ein Symlink von der freien Zone in die Quellzone bringt keine Schreibfreiheit:
    // die Einstufung folgt dem aufgelösten Ziel, also "source".
    const link = path.join(artifactRoot, "back-to-source");
    await symlink(path.join(sourceRoot, "src"), link, "junction");

    const resolved = await resolvePath(zones, "artifacts/back-to-source/a.ts");
    expect(resolved.zone).toBe("source");
  });
});

describe("resolvePath · kaputte Eingaben", () => {
  it("weist leere und Nicht-String-Eingaben ab", async () => {
    await expect(resolvePath(zones, "")).rejects.toThrow(PathInputError);
    // biome-ignore lint/suspicious/noExplicitAny: absichtlich falscher Typ für die Grenzprüfung
    await expect(resolvePath(zones, undefined as any)).rejects.toThrow(PathInputError);
  });

  it("weist ein Nullbyte im Pfad ab", async () => {
    await expect(resolvePath(zones, "src/a.ts\0.png")).rejects.toThrow(PathInputError);
  });
});
