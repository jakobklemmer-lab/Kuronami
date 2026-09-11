import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillFileError, loadSkillCatalog } from "./catalog.js";

/**
 * `loadSkillCatalog` ohne Router und ohne Datenbank — reines Dateisystem. Die zehn
 * Dummy-Skills aus dem Sessionauftrag ("10 Dummy-Skills anlegen") leben hier als
 * Wegwerf-Verzeichnis, nicht unter dem echten `skills/` im Repo: die ersten eigenen Skills
 * kommen erst mit S18d, und ein Test soll das nicht vorwegnehmen.
 */

let root: string;

async function writeSkill(
  name: string,
  fields: { titel: string; beschreibung: string; wann: string },
  body = `Anleitung für ${name}. Vollständiger Text, der nur nach skill.load im Kontext steht.`,
): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\ntitel: ${fields.titel}\nbeschreibung: ${fields.beschreibung}\nwann: ${fields.wann}\n---\n\n${body}\n`,
    "utf8",
  );
}

/** Die zehn Dummy-Skills aus dem Auftrag: gleich geschnitten, an Namen und Inhalt unterscheidbar. */
async function writeTenDummySkills(): Promise<void> {
  for (let i = 1; i <= 10; i += 1) {
    const name = `dummy-${String(i).padStart(2, "0")}`;
    await writeSkill(name, {
      titel: `Dummy-Skill ${i}`,
      beschreibung: `Testfähigkeit Nummer ${i}, für die progressive Offenlegung.`,
      wann: `Wenn im Test gezielt Dummy-Skill ${i} gebraucht wird.`,
    });
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kuronami-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadSkillCatalog · zehn Dummy-Skills", () => {
  it("lädt alle zehn, sortiert nach Namen", async () => {
    await writeTenDummySkills();
    const catalog = await loadSkillCatalog(root);

    expect(catalog.skills).toHaveLength(10);
    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      "dummy-01",
      "dummy-02",
      "dummy-03",
      "dummy-04",
      "dummy-05",
      "dummy-06",
      "dummy-07",
      "dummy-08",
      "dummy-09",
      "dummy-10",
    ]);
  });

  it("trägt Titel, Beschreibung, Auslösebedingung und vollständigen Rumpf je Skill", async () => {
    await writeTenDummySkills();
    const catalog = await loadSkillCatalog(root);

    const fifth = catalog.get("dummy-05");
    expect(fifth).toMatchObject({
      name: "dummy-05",
      title: "Dummy-Skill 5",
      description: "Testfähigkeit Nummer 5, für die progressive Offenlegung.",
      when: "Wenn im Test gezielt Dummy-Skill 5 gebraucht wird.",
      path: "dummy-05/SKILL.md",
    });
    expect(fifth?.body).toContain("Anleitung für dummy-05");
  });
});

describe("loadSkillCatalog · Grenzfälle", () => {
  it("gibt einen leeren Katalog zurück, wenn die Wurzel fehlt", async () => {
    const catalog = await loadSkillCatalog(path.join(root, "existiert-nicht"));
    expect(catalog.skills).toEqual([]);
    expect(catalog.get("irgendwas")).toBeUndefined();
  });

  it("überspringt ein Verzeichnis ohne SKILL.md, ohne die übrigen zu verlieren", async () => {
    await writeSkill("echter-skill", {
      titel: "Echt",
      beschreibung: "Ein echter Skill.",
      wann: "Immer.",
    });
    await mkdir(path.join(root, "kein-skill"), { recursive: true });
    await writeFile(path.join(root, "kein-skill", "notizen.txt"), "kein Frontmatter hier", "utf8");

    const catalog = await loadSkillCatalog(root);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["echter-skill"]);
  });

  it("überspringt eine Datei auf oberster Ebene (skills/README.md)", async () => {
    await writeFile(path.join(root, "README.md"), "# Skills\n", "utf8");
    await writeSkill("mit-skill", {
      titel: "Mit Skill",
      beschreibung: "Beschreibung.",
      wann: "Wann.",
    });

    const catalog = await loadSkillCatalog(root);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["mit-skill"]);
  });

  it("lässt einen kaputten Skill draußen, ohne die übrigen mitzureißen", async () => {
    await mkdir(path.join(root, "kaputt"), { recursive: true });
    await writeFile(
      path.join(root, "kaputt", "SKILL.md"),
      "---\ntitel: Kaputt\n---\n\nBeschreibung und wann fehlen.\n",
      "utf8",
    );
    await writeSkill("heil", { titel: "Heil", beschreibung: "Läuft.", wann: "Immer." });

    const catalog = await loadSkillCatalog(root);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["heil"]);
  });

  it("weist eine SKILL.md ohne Anleitungstext ab (kein Rumpf nach dem Frontmatter)", async () => {
    const dir = path.join(root, "leer");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\ntitel: Leer\nbeschreibung: Nichts drin.\nwann: Nie.\n---\n",
      "utf8",
    );
    const catalog = await loadSkillCatalog(root);
    expect(catalog.skills).toEqual([]);
  });

  it("ignoriert einen Ordnernamen, der nicht wie ein Skill-Name aussieht", async () => {
    await mkdir(path.join(root, "Gross_Geschrieben"), { recursive: true });
    await writeFile(
      path.join(root, "Gross_Geschrieben", "SKILL.md"),
      "---\ntitel: X\nbeschreibung: Y\nwann: Z\n---\n\nInhalt.\n",
      "utf8",
    );
    const catalog = await loadSkillCatalog(root);
    expect(catalog.skills).toEqual([]);
  });
});

describe("loadSkillCatalog · Fehlertyp", () => {
  it("SkillFileError ist ein Error mit Wortlaut", () => {
    const error = new SkillFileError("Testfall");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Testfall");
  });
});
