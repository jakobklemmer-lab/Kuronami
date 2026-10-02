import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { alleNotizen, brainPfad, erstenTitel, leseNotiz, linksIn, suche } from "./brain.js";

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
