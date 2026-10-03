import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
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

export interface BrainKnoten {
  pfad: string;
  titel: string;
  ordner: string;
  /** Tags aus den Eigenschaften (`tags:`) und aus dem Text (`#tag`), klein geschrieben. */
  tags: string[];
  /** Eine Farbe, die die Notiz selbst wünscht (`farbe:` oder `color:` in den Eigenschaften). */
  farbe: string | null;
  /** Wann die Notiz entstand (ms): Datum im Namen, sonst `datum:`/`erstellt:`, sonst die Datei. */
  erstellt: number;
  /** Letzte Änderung der Datei (ms). */
  geaendert: number;
  worte: number;
}

export interface BrainGraph {
  knoten: BrainKnoten[];
  kanten: Array<[string, string]>;
  /** Links auf Notizen, die es nicht gibt: [von, wie der Link lautet]. */
  offen: Array<[string, string]>;
}

/** Zeiten einer Datei, wie `stat` sie liefert. */
export interface DateiZeiten {
  geaendert: number;
  geboren: number;
}

const DATUM_IM_NAMEN = /(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?:[^\d]|$)/;

/** Wann eine Notiz entstand — so, wie Jakob es lesen würde, nicht wann die Datei kopiert wurde. */
export function erstelltAm(
  pfad: string,
  felder: Record<string, unknown>,
  zeiten: DateiZeiten | undefined,
): number {
  const ausText = (text: string): number | null => {
    const m = DATUM_IM_NAMEN.exec(text);
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    return Number.isFinite(t) && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? t : null;
  };
  const imNamen = ausText(path.posix.basename(pfad));
  if (imNamen !== null) return imNamen;
  for (const feld of ["datum", "erstellt", "created", "date"]) {
    const wert = felder[feld];
    if (typeof wert === "string") {
      const t = ausText(` ${wert} `);
      if (t !== null) return t;
    }
  }
  const geboren = zeiten?.geboren ?? 0;
  return geboren > 0 ? geboren : (zeiten?.geaendert ?? 0);
}

/** Tags wie Obsidian: `tags:` in den Eigenschaften und `#wort` im Text (nicht in Code, nicht `# Titel`). */
export function tagsIn(felder: Record<string, unknown>, inhalt: string): string[] {
  const tags = new Set<string>();
  for (const feld of ["tags", "tag"]) {
    const wert = felder[feld];
    const liste = Array.isArray(wert) ? wert : typeof wert === "string" ? wert.split(/[,\s]+/) : [];
    for (const t of liste) {
      const sauber = String(t).replace(/^#/, "").trim().toLowerCase();
      if (sauber) tags.add(sauber);
    }
  }
  const ohneCode = inhalt.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of ohneCode.matchAll(/(?:^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gu)) {
    tags.add(m[1].toLowerCase());
  }
  return [...tags].sort();
}

/** Alle Notizen und ihre aufgelösten Links — für die Graph-Ansicht und die Rückverweise. */
export function baueGraph(
  notizen: ReadonlyMap<string, string>,
  zeiten: ReadonlyMap<string, DateiZeiten> = new Map(),
): BrainGraph {
  const pfade = [...notizen.keys()];
  const kanten = new Set<string>();
  const offen = new Set<string>();
  const knoten: BrainGraph["knoten"] = [];
  for (const [pfad, roh] of notizen) {
    const { felder, inhalt } = leseNotiz(roh);
    const farbe = felder.farbe ?? felder.color;
    knoten.push({
      pfad,
      titel: erstenTitel(inhalt, path.posix.basename(pfad, ".md")),
      ordner: pfad.includes("/") ? (pfad.split("/")[0] as string) : "",
      tags: tagsIn(felder, inhalt),
      farbe: typeof farbe === "string" && farbe.trim() ? farbe.trim() : null,
      erstellt: erstelltAm(pfad, felder, zeiten.get(pfad)),
      geaendert: zeiten.get(pfad)?.geaendert ?? 0,
      worte: inhalt.split(/\s+/).filter(Boolean).length,
    });
    for (const [wie, ziel] of Object.entries(loeseLinks(pfad, inhalt, pfade))) {
      if (ziel === null) offen.add(`${pfad}\u0000${wie}`);
      else if (ziel !== pfad) kanten.add(`${pfad}\u0000${ziel}`);
    }
  }
  return {
    knoten,
    kanten: [...kanten].map((k) => k.split("\u0000") as [string, string]),
    offen: [...offen].map((k) => k.split("\u0000") as [string, string]),
  };
}

async function liesAlle(workdir: string): Promise<Map<string, string>> {
  const notizen = new Map<string, string>();
  for (const pfad of await alleNotizen(workdir)) {
    notizen.set(pfad, await readFile(brainPfad(workdir, pfad), "utf8"));
  }
  return notizen;
}

async function liesZeiten(
  workdir: string,
  pfade: Iterable<string>,
): Promise<Map<string, DateiZeiten>> {
  const zeiten = new Map<string, DateiZeiten>();
  for (const pfad of pfade) {
    try {
      const info = await stat(brainPfad(workdir, pfad));
      zeiten.set(pfad, { geaendert: info.mtimeMs, geboren: info.birthtimeMs });
    } catch {
      // eben gelöscht
    }
  }
  return zeiten;
}

/** Höchstens so groß darf eine abgelegte Datei sein (Base64 im JSON, Grenze des Gateways 32 MB). */
export const EINGANG_HOECHSTENS = 20 * 1024 * 1024;
/** Roh geschickt darf es mehr sein — Murphys Buch als PDF hatte über 20 MB. */
export const EINGANG_ROH_HOECHSTENS = 300 * 1024 * 1024;

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
      const graph = baueGraph(await liesAlle(deps.workdir()));
      const titel = new Map(graph.knoten.map((k) => [k.pfad, k.titel]));
      res.json({
        pfad,
        titel: erstenTitel(inhalt, path.posix.basename(pfad, ".md")),
        felder,
        inhalt,
        roh,
        links: loeseLinks(
          pfad,
          inhalt,
          graph.knoten.map((k) => k.pfad),
        ),
        rueckverweise: graph.kanten
          .filter(([, nach]) => nach === pfad)
          .map(([von]) => ({ pfad: von, titel: titel.get(von) ?? von })),
      });
    } catch (error) {
      next(error);
    }
  });

  async function legeAb(name: string, daten: Buffer): Promise<string> {
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
    return notiz;
  }

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
      res.json({ pfad: await legeAb(name, daten) });
    } catch (error) {
      next(error);
    }
  });

  // Dasselbe für große Dateien: der Körper ist die Datei selbst, der Name steht in der Adresse.
  app.post(
    "/integrations/brain/eingang/datei",
    express.raw({ type: () => true, limit: EINGANG_ROH_HOECHSTENS }),
    async (req, res, next) => {
      try {
        if (!deps.webPrincipal(req, res)) return;
        const name = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 200) : "";
        const daten = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!name || daten.length === 0) {
          res.status(400).json({ error: "Name und Inhalt der Datei fehlen." });
          return;
        }
        res.json({ pfad: await legeAb(name, daten) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/integrations/brain/graph", async (req, res, next) => {
    try {
      if (!deps.webPrincipal(req, res)) return;
      const notizen = await liesAlle(deps.workdir());
      res.json(baueGraph(notizen, await liesZeiten(deps.workdir(), notizen.keys())));
    } catch (error) {
      next(error);
    }
  });

  // Bearbeiten in Kuro OS. Erzeugte Notizen (Strategien, Analysen, Verzeichnisse) schreibt der
  // Gateway neu — dort ginge eine Änderung beim nächsten Abgleich verloren, also gar nicht erst.
  app.put("/integrations/brain/notiz", async (req, res, next) => {
    try {
      if (!deps.webPrincipal(req, res)) return;
      const pfad = sichererPfad(req.body?.pfad);
      const inhalt = typeof req.body?.inhalt === "string" ? req.body.inhalt : null;
      if (!pfad || inhalt === null || inhalt.length > 2_000_000) {
        res.status(400).json({ error: "Pfad oder Inhalt fehlt." });
        return;
      }
      const datei = brainPfad(deps.workdir(), pfad);
      let alt: string | null = null;
      try {
        alt = await readFile(datei, "utf8");
      } catch {
        // neue Notiz
      }
      if (alt !== null && leseNotiz(alt).felder.erzeugt === true) {
        res
          .status(409)
          .json({ error: "Diese Notiz wird erzeugt und lässt sich nicht bearbeiten." });
        return;
      }
      if (alt === null && req.body?.neu !== true) {
        res.status(404).json({ error: `${pfad} gibt es im Brain nicht.` });
        return;
      }
      await mkdir(path.dirname(datei), { recursive: true });
      await writeFile(datei, inhalt, "utf8");
      res.json({ pfad });
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
