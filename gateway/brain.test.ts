import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  brainPfad,
  dateiname,
  erreichbarkeit,
  leseNotiz,
  linksIn,
  schreibeNotiz,
  schreibeVerzeichnis,
  sichere,
  suche,
} from "./brain.js";

async function leeresBrain(): Promise<string> {
  const workdir = await mkdtemp(path.join(tmpdir(), "brain-"));
  await mkdir(brainPfad(workdir), { recursive: true });
  return workdir;
}

async function lege(workdir: string, pfad: string, inhalt: string): Promise<void> {
  await mkdir(path.dirname(brainPfad(workdir, pfad)), { recursive: true });
  await writeFile(brainPfad(workdir, pfad), inhalt, "utf8");
}

describe("Eigenschaften", () => {
  it("schreibt und liest flache Eigenschaften samt Listen", () => {
    const text = schreibeNotiz(
      {
        art: "trade",
        instrument: "BTC-USD",
        entry: 61234.5,
        status: "Offen",
        plan_befolgt: "Ja",
        tags: ["Krypto", "Swing"],
        leer: null,
        fehlt: undefined,
        zahlwort: "12",
        mit_doppelpunkt: "Setup 1: Pullback",
      },
      "## These\nBreakout über 62.000.",
    );
    const { felder, inhalt } = leseNotiz(text);
    expect(felder).toEqual({
      art: "trade",
      instrument: "BTC-USD",
      entry: 61234.5,
      status: "Offen",
      plan_befolgt: "Ja",
      tags: ["Krypto", "Swing"],
      zahlwort: "12",
      mit_doppelpunkt: "Setup 1: Pullback",
    });
    expect(inhalt).toBe("## These\nBreakout über 62.000.\n");
  });

  it("liest Text ohne Eigenschaften unverändert", () => {
    expect(leseNotiz("# Nur Text\n")).toEqual({ felder: {}, inhalt: "# Nur Text\n" });
  });

  it("macht aus einem Titel einen gültigen Dateinamen", () => {
    expect(dateiname('Setup 1: "Pullback" / EMA 20?')).toBe("Setup 1 Pullback EMA 20");
    expect(dateiname("   ")).toBe("Ohne Titel");
  });
});

describe("Links und Erreichbarkeit", () => {
  it("findet Wiki- und relative Markdown-Links", () => {
    expect(
      linksIn("[[Trading]] und [[Trading/Journal|Journal]] und [Tag](2026/2026-09-28.md)"),
    ).toEqual({
      wiki: ["Trading", "Trading/Journal"],
      relativ: ["2026/2026-09-28.md"],
    });
  });

  it("misst die Schritte von START.md und meldet zu Tiefes und Verwaistes", () => {
    const notizen = new Map([
      ["START.md", "[[Trading]]"],
      ["Bereiche/Trading.md", "[[Trading/Journal|Journal]]"],
      ["Trading/Journal.md", "- [[Trading/Journal/2026-09-22 BTC-USD Long|BTC]]"],
      ["Trading/Journal/2026-09-22 BTC-USD Long.md", "[[Tiefer]]"],
      ["Tiefer.md", "zu weit unten"],
      ["Verwaist.md", "niemand verlinkt mich"],
      ["Gespräche/INDEX.md", "[Montag](2026/2026-09-28.md)"],
      ["Gespräche/2026/2026-09-28.md", "Wortlaut"],
    ]);
    notizen.set(
      "Bereiche/Trading.md",
      "[[Trading/Journal|Journal]] [Archiv](../Gespräche/INDEX.md)",
    );
    const e = erreichbarkeit(notizen);
    expect(e.tiefe.get("Trading/Journal/2026-09-22 BTC-USD Long.md")).toBe(3);
    expect(e.tiefe.get("Gespräche/2026/2026-09-28.md")).toBe(3);
    expect(e.zuTief).toEqual(["Tiefer.md"]);
    expect(e.unerreichbar).toEqual(["Verwaist.md"]);
  });

  it("ohne START.md ist nichts erreichbar", () => {
    expect(erreichbarkeit(new Map([["A.md", ""]])).unerreichbar).toEqual(["A.md"]);
  });
});

describe("Suche, Verzeichnis, Sichern", () => {
  it("findet Notizen, in denen alle Wörter stehen", async () => {
    const w = await leeresBrain();
    await lege(w, "Trading/Watchlist/NVDA.md", "Pullback an den EMA 20\nUnterstützung 150");
    await lege(w, "Trading/Watchlist/Siemens.md", "Robotik, kein Pullback");
    await lege(w, ".obsidian/workspace.md", "Pullback EMA versteckt");
    const funde = await suche(w, "pullback ema");
    expect(funde.map((f) => f.pfad)).toEqual(["Trading/Watchlist/NVDA.md"]);
    expect(funde[0].zeilen[0]).toBe("Pullback an den EMA 20");
  });

  it("schreibt eine Verzeichnisseite nur, wenn sie sich ändert", async () => {
    const w = await leeresBrain();
    await lege(w, "Trading/Watchlist/NVDA.md", schreibeNotiz({ status: "Aktiv" }, "x"));
    const v = {
      seite: "Trading/Watchlist.md",
      ordner: "Trading/Watchlist",
      titel: "Watchlist",
      satz: "Was Jakob beobachtet.",
      anzeige: (f: Record<string, unknown>, name: string) => `${name} (${f.status})`,
    };
    expect(await schreibeVerzeichnis(w, v)).toBe(true);
    expect(await schreibeVerzeichnis(w, v)).toBe(false);
    expect(await readFile(brainPfad(w, "Trading/Watchlist.md"), "utf8")).toContain(
      "- [[Trading/Watchlist/NVDA|NVDA (Aktiv)]]",
    );
  });

  it("committet Änderungen im Brain und sonst nichts", async () => {
    const w = await leeresBrain();
    const git = (...a: string[]) => execFileSync("git", a, { cwd: brainPfad(w), encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@kuronami.local");
    await lege(w, "START.md", "# Start");
    expect(await sichere(w, "Probe")).toBe(true);
    expect(await sichere(w, "Probe")).toBe(false);
    expect(git("log", "--format=%s")).toBe("Kuro: Probe\n");
  });
});
