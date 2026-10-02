import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Express, Request, Response } from "express";
import {
  alleNotizen,
  brainPfad,
  dateiname,
  erstenTitel,
  leseNotiz,
  linksIn,
  schreibeNotiz,
  suche,
} from "./brain.js";

/**
 * Das Brain für Kuro OS, nur lesend: eine Notiz samt aufgelöster Links, die Suche, die Liste.
 * Geschrieben wird in Obsidian am Mac oder von Kuro; die Oberfläche zeigt.
 */

/** Ein Pfad im Brain, wie er aus der Adresse kommt — sonst null. */
export function sichererPfad(roh: unknown): string | null {
  if (typeof roh !== "string" || roh.length === 0 || roh.length > 300) return null;
  const pfad = path.posix.normalize(roh.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (pfad.startsWith("..") || pfad.split("/").some((t) => t.startsWith("."))) return null;
  return pfad.endsWith(".md") ? pfad : null;
}

/** Wohin ein Link führt — wie Obsidian ihn auflöst: voller Pfad, sonst der Dateiname. */
export function loeseLinks(
  von: string,
  inhalt: string,
  pfade: readonly string[],
): Record<string, string | null> {
  const nachName = new Map<string, string>();
  for (const p of pfade) {
    const ohne = p.replace(/\.md$/, "").toLowerCase();
    nachName.set(ohne, p);
    const kurz = path.posix.basename(ohne);
    if (!nachName.has(kurz)) nachName.set(kurz, p);
  }
  const vorhanden = new Set(pfade);
  const { wiki, relativ } = linksIn(inhalt);
  const ziele: Record<string, string | null> = {};
  for (const w of wiki) {
    ziele[w] =
      nachName.get(w.toLowerCase()) ?? nachName.get(path.posix.basename(w).toLowerCase()) ?? null;
  }
  for (const r of relativ) {
    const ziel = path.posix.normalize(path.posix.join(path.posix.dirname(von), r));
    ziele[r] = vorhanden.has(ziel) ? ziel : null;
  }
  return ziele;
}

/** Höchstens so groß darf eine abgelegte Datei sein (Base64 im JSON, Grenze des Gateways 32 MB). */
export const EINGANG_HOECHSTENS = 20 * 1024 * 1024;

const TEXT_ENDUNG = /\.(md|txt|markdown)$/i;

/**
 * Was aus einer abgelegten Datei im Brain wird: Text als Notiz im Eingang, alles andere als
 * Anhang mit einer Notiz im Eingang, die ihn einbettet — Obsidian zeigt Bilder und PDFs so an.
 */
export function eingangsPlan(
  name: string,
  heute: string,
): { notiz: string; anhang: string | null; text: boolean } {
  const endung = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0].toLowerCase() ?? "";
  const stamm = dateiname(name.slice(0, name.length - endung.length)) || "Ohne Titel";
  const text = TEXT_ENDUNG.test(endung);
  return {
    notiz: `Eingang/${heute} ${stamm}.md`,
    anhang: text ? null : `Anhänge/${heute} ${stamm}${endung}`,
    text,
  };
}

async function frei(workdir: string, pfad: string): Promise<string> {
  const endung = path.posix.extname(pfad);
  const stamm = pfad.slice(0, pfad.length - endung.length);
  for (let n = 1; n < 100; n++) {
    const kandidat = n === 1 ? pfad : `${stamm} (${n})${endung}`;
    try {
      await stat(brainPfad(workdir, kandidat));
    } catch {
      return kandidat;
    }
  }
  throw new Error("Zu viele gleichnamige Dateien im Eingang.");
}

export function brainRouten(
  app: Express,
  deps: { workdir: () => string; webPrincipal: (req: Request, res: Response) => unknown },
): void {
  app.get("/integrations/brain/notiz", async (req, res, next) => {
    try {
      if (!deps.webPrincipal(req, res)) return;
      const pfad = sichererPfad(req.query.pfad ?? "START.md");
      if (!pfad) {
        res.status(400).json({ error: "Kein gültiger Pfad im Brain." });
        return;
      }
      let roh: string;
      try {
        roh = await readFile(brainPfad(deps.workdir(), pfad), "utf8");
      } catch {
        res.status(404).json({ error: `${pfad} gibt es im Brain nicht.` });
        return;
      }
      const { felder, inhalt } = leseNotiz(roh);
      const pfade = await alleNotizen(deps.workdir());
      res.json({
        pfad,
        titel: erstenTitel(inhalt, path.posix.basename(pfad, ".md")),
        felder,
        inhalt,
        links: loeseLinks(pfad, inhalt, pfade),
      });
    } catch (error) {
      next(error);
    }
  });

  // Per Drag-and-drop in Kuro OS: die Datei landet im Eingang, Kuro findet sie dort.
  app.post("/integrations/brain/eingang", async (req, res, next) => {
    try {
      if (!deps.webPrincipal(req, res)) return;
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 200) : "";
      const inhalt = typeof req.body?.inhalt === "string" ? req.body.inhalt : "";
      if (!name || !inhalt) {
        res.status(400).json({ error: "Name und Inhalt der Datei fehlen." });
        return;
      }
      const daten = Buffer.from(inhalt, "base64");
      if (daten.length > EINGANG_HOECHSTENS) {
        res.status(413).json({ error: "Die Datei ist größer als 20 MB." });
        return;
      }
      const workdir = deps.workdir();
      const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Vienna" });
      const plan = eingangsPlan(name, heute);
      const notiz = await frei(workdir, plan.notiz);
      const titel = path.posix.basename(notiz, ".md");
      let text: string;
      if (plan.text) {
        const roh = daten.toString("utf8");
        text = /^\s*#\s/.test(roh) ? roh : `# ${titel}\n\n${roh}`;
      } else {
        const anhang = await frei(workdir, plan.anhang as string);
        await mkdir(path.dirname(brainPfad(workdir, anhang)), { recursive: true });
        await writeFile(brainPfad(workdir, anhang), daten);
        text = schreibeNotiz(
          { quelle: "abgelegt", datei: anhang },
          `# ${titel}\n\n![[${anhang}]]\n\nAbgelegt in Kuro OS. Wohin damit, entscheidet Jakob oder Kuro.`,
        );
      }
      await mkdir(path.dirname(brainPfad(workdir, notiz)), { recursive: true });
      await writeFile(brainPfad(workdir, notiz), text, "utf8");
      res.json({ pfad: notiz });
    } catch (error) {
      next(error);
    }
  });

  app.get("/integrations/brain/suche", async (req, res, next) => {
    try {
      if (!deps.webPrincipal(req, res)) return;
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
      if (q.length < 2) {
        res.json({ funde: [] });
        return;
      }
      res.json({ funde: await suche(deps.workdir(), q, 20) });
    } catch (error) {
      next(error);
    }
  });
}
