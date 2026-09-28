import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import { bearerToken } from "./identity.js";

/**
 * Was Kuro aus fremden Lehrvideos lernt (2026-09-27) — zuerst der Kanal TradingLab.
 *
 * Jakob: „du könntest dir die Videos anschauen und von ihm lernen … so hab ich das früher
 * gemacht." Anschauen heißt hier: lesen. Die Untertitel, die YouTube selbst erzeugt, reichen für
 * das, was gesagt wird; was nur gezeichnet wird, fehlt — das steht so im Lehrbuch.
 *
 * **Warum der Server die Videos nicht selbst holt.** Gemessen am 27.09.: die Kanalseite und die
 * Liste der Videos lädt er, jede Watch-Seite beantwortet YouTube einem Rechenzentrum mit „Sign in
 * to confirm you're not a bot" — mit allen vier Abspiel-Clients von yt-dlp. Jakobs PC hat eine
 * Heimleitung, die nicht gesperrt ist. Also: **der Server führt die Liste, der PC holt die
 * Untertitel und lädt sie hoch** (`werkzeuge/pc/tradinglab_transkripte.py`).
 *
 * Der PC zeigt dafür einen eigenen Schlüssel vor (`KURO_WISSEN_SCHLUESSEL`), nicht den
 * Betreiber-Token. Geht der Schlüssel verloren, kann man damit Untertitel ablegen und sehen,
 * welche fehlen — sonst nichts.
 *
 * Ablage unter `workspace/wissen/<kanal>/`: `inventar.json` (die Liste), `roh/<id>.json` (je
 * Video ein Transkript mit Zeitmarken), `notizen/<id>.md` (was der Lehrgang daraus gemacht hat,
 * `lehrgang.ts`). Nicht im Git — fremder Inhalt, und das Repo hat einen GitHub-Remote.
 */

export interface Video {
  id: string;
  titel: string;
  /** Länge in Sekunden. */
  dauer: number;
  aufrufe?: number;
  /** Eins der ältesten Strategievideos, mit denen Jakob gelernt hat — der Lehrgang nimmt sie zuerst. */
  kalibrierung?: boolean;
}

export interface Segment {
  /** Sekunden ab Videobeginn. */
  start: number;
  text: string;
}

export interface Transkript {
  id: string;
  titel: string;
  sprache: string;
  /** `manuell` = vom Kanal hochgeladen, `automatisch` = von YouTube erkannt, `ohne` = keine da. */
  art: "manuell" | "automatisch" | "ohne";
  segmente: Segment[];
  /** Wann der PC es geholt hat (ISO). */
  geholt: string;
}

export class WissenFehler extends Error {}

const VIDEO_ID = /^[\w-]{11}$/;
const KANAL = /^[a-z0-9-]{1,40}$/;
const MAX_SEGMENTE = 20_000;
const MAX_ZEICHEN = 1_500_000;

function kurz(wert: unknown, max: number): string {
  return typeof wert === "string" ? wert.trim().slice(0, max) : "";
}

/**
 * Prüft, was der PC schickt, und behält nur die bekannten Felder. Ein Transkript, das nicht zur
 * Liste gehört, wird abgewiesen — sonst könnte über diesen Weg beliebiger Text in Kuros
 * Lehrmaterial landen.
 */
export function pruefeTranskript(roh: unknown, inventar: Video[]): Transkript {
  const t = (roh ?? {}) as Record<string, unknown>;
  const id = kurz(t.id, 20);
  if (!VIDEO_ID.test(id)) throw new WissenFehler("Keine gültige Video-ID.");
  const video = inventar.find((v) => v.id === id);
  if (!video) throw new WissenFehler(`${id} steht nicht in der Liste dieses Kanals.`);
  const art = t.art;
  if (art !== "manuell" && art !== "automatisch" && art !== "ohne") {
    throw new WissenFehler("`art` muss manuell, automatisch oder ohne sein.");
  }
  if (!Array.isArray(t.segmente)) throw new WissenFehler("`segmente` fehlt.");
  if (t.segmente.length > MAX_SEGMENTE) throw new WissenFehler("Zu viele Segmente.");
  const segmente: Segment[] = [];
  let zeichen = 0;
  for (const s of t.segmente as Array<Record<string, unknown>>) {
    const start = s?.start;
    const text = kurz(s?.text, 2_000).replace(/\s+/g, " ");
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) continue;
    if (text.length === 0) continue;
    zeichen += text.length;
    segmente.push({ start: Math.round(start * 10) / 10, text });
  }
  if (zeichen > MAX_ZEICHEN) throw new WissenFehler("Transkript zu lang.");
  if (art !== "ohne" && segmente.length === 0) {
    throw new WissenFehler("Ein Transkript ohne Text muss `art: ohne` tragen.");
  }
  segmente.sort((a, b) => a.start - b.start);
  return {
    id,
    titel: video.titel,
    sprache: kurz(t.sprache, 10) || "en",
    art,
    segmente,
    geholt: new Date().toISOString(),
  };
}

/** Schlüsselvergleich in fester Zeit. Ohne eingerichteten Schlüssel gilt keiner. */
export function schluesselGilt(erwartet: string | undefined, vorgezeigt: string | null): boolean {
  if (!erwartet || !vorgezeigt) return false;
  const a = Buffer.from(erwartet);
  const b = Buffer.from(vorgezeigt);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WissenStand {
  kanal: string;
  videos: number;
  transkripte: number;
  ohneUntertitel: number;
  offen: number;
  stunden: number;
  /** Videos, zu denen der Lehrgang eine Notiz abgelegt hat. */
  durchgearbeitet: number;
  kalibrierung: { videos: number; durchgearbeitet: number };
}

export interface WissenAblage {
  inventar(kanal: string): Promise<Video[]>;
  /** Videos der Liste, für die noch nichts abgelegt ist — in der Reihenfolge der Liste. */
  offen(kanal: string): Promise<Video[]>;
  lege(kanal: string, roh: unknown): Promise<Transkript>;
  stand(kanal: string): Promise<WissenStand>;
  /** Das abgelegte Transkript eines Videos, `null`, wenn keins da ist. */
  transkript(kanal: string, id: string): Promise<Transkript | null>;
  /** Zu welchen Videos eine Notiz liegt, mit dem Zeitpunkt der Datei. */
  notizen(kanal: string): Promise<Map<string, Date>>;
  notiz(kanal: string, id: string): Promise<string | null>;
  legeNotiz(kanal: string, id: string, text: string): Promise<void>;
}

export function createWissen(opt: { workdir: string }): WissenAblage {
  const ordner = (kanal: string) => {
    if (!KANAL.test(kanal)) throw new WissenFehler("Unbekannter Kanal.");
    return path.join(opt.workdir, "wissen", kanal);
  };

  async function inventar(kanal: string): Promise<Video[]> {
    try {
      const roh = JSON.parse(await readFile(path.join(ordner(kanal), "inventar.json"), "utf8"));
      return Array.isArray(roh?.videos) ? (roh.videos as Video[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  function videoId(id: string): string {
    if (!VIDEO_ID.test(id)) throw new WissenFehler("Keine gültige Video-ID.");
    return id;
  }

  async function notizen(kanal: string): Promise<Map<string, Date>> {
    const ziel = path.join(ordner(kanal), "notizen");
    const da = new Map<string, Date>();
    let dateien: string[];
    try {
      dateien = await readdir(ziel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return da;
      throw error;
    }
    for (const datei of dateien) {
      const id = datei.replace(/\.md$/, "");
      if (datei === id || !VIDEO_ID.test(id)) continue;
      da.set(id, (await stat(path.join(ziel, datei))).mtime);
    }
    return da;
  }

  async function vorhanden(kanal: string): Promise<Map<string, Transkript["art"]>> {
    const roh = path.join(ordner(kanal), "roh");
    const arten = new Map<string, Transkript["art"]>();
    let dateien: string[];
    try {
      dateien = await readdir(roh);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return arten;
      throw error;
    }
    for (const datei of dateien) {
      if (!datei.endsWith(".json")) continue;
      try {
        const t = JSON.parse(await readFile(path.join(roh, datei), "utf8")) as Transkript;
        arten.set(t.id, t.art);
      } catch {
        // Eine halb geschriebene Datei gibt es wegen `rename` nicht; eine kaputte zählt als fehlend.
      }
    }
    return arten;
  }

  return {
    inventar,

    async offen(kanal) {
      const [liste, da] = await Promise.all([inventar(kanal), vorhanden(kanal)]);
      return liste.filter((v) => !da.has(v.id));
    },

    async lege(kanal, roh) {
      const transkript = pruefeTranskript(roh, await inventar(kanal));
      const ziel = path.join(ordner(kanal), "roh");
      await mkdir(ziel, { recursive: true });
      const datei = path.join(ziel, `${transkript.id}.json`);
      await writeFile(`${datei}.neu`, `${JSON.stringify(transkript, null, 1)}\n`);
      await rename(`${datei}.neu`, datei);
      return transkript;
    },

    async stand(kanal) {
      const [liste, da, notiert] = await Promise.all([
        inventar(kanal),
        vorhanden(kanal),
        notizen(kanal),
      ]);
      const ohne = [...da.values()].filter((a) => a === "ohne").length;
      const kalibrierung = liste.filter((v) => v.kalibrierung);
      return {
        kanal,
        videos: liste.length,
        transkripte: da.size - ohne,
        ohneUntertitel: ohne,
        offen: liste.filter((v) => !da.has(v.id)).length,
        stunden: Math.round((liste.reduce((s, v) => s + (v.dauer || 0), 0) / 3600) * 10) / 10,
        durchgearbeitet: liste.filter((v) => notiert.has(v.id)).length,
        kalibrierung: {
          videos: kalibrierung.length,
          durchgearbeitet: kalibrierung.filter((v) => notiert.has(v.id)).length,
        },
      };
    },

    async transkript(kanal, id) {
      try {
        const datei = path.join(ordner(kanal), "roh", `${videoId(id)}.json`);
        return JSON.parse(await readFile(datei, "utf8")) as Transkript;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    notizen,

    async notiz(kanal, id) {
      try {
        return await readFile(path.join(ordner(kanal), "notizen", `${videoId(id)}.md`), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async legeNotiz(kanal, id, text) {
      const ziel = path.join(ordner(kanal), "notizen");
      await mkdir(ziel, { recursive: true });
      const datei = path.join(ziel, `${videoId(id)}.md`);
      // Erst daneben, dann umbenennen: eine halbe Notiz zählte sonst als durchgearbeitet.
      await writeFile(`${datei}.neu`, text, "utf8");
      await rename(`${datei}.neu`, datei);
    },
  };
}

/**
 * Die zwei Türen für den PC und zwei für die Oberfläche.
 *
 * `GET /wissen/:kanal/offen` und `POST /wissen/:kanal/transkript` nehmen **nur** den
 * Wissensschlüssel. `GET /integrations/wissen/:kanal` (der Stand, mit dem des Lehrgangs) und
 * `GET /integrations/wissen/:kanal/notizen/:id` (eine Notiz zum Lesen) nehmen den normalen Ausweis
 * — dafür reicht der Server die Prüfung herein (`webPrincipal`).
 */
export function wissenRouten(
  app: Express,
  deps: {
    wissen: WissenAblage;
    /** Der Lehrgang arbeitet nur einen Kanal durch; für die anderen steht `lehrgang: null`. */
    lehrgang?: { kanal: string; stand(): Promise<unknown> };
    schluessel: () => string | undefined;
    webPrincipal: (req: Request, res: Response) => unknown;
  },
): void {
  function pcDarf(req: Request, res: Response): boolean {
    const erwartet = deps.schluessel();
    if (!erwartet) {
      res.status(403).json({ error: "KURO_WISSEN_SCHLUESSEL ist auf dem Server nicht gesetzt." });
      return false;
    }
    if (!schluesselGilt(erwartet, bearerToken(req.header("authorization")))) {
      res.status(401).json({ error: "Falscher Schlüssel." });
      return false;
    }
    return true;
  }

  function fehler(error: unknown, res: Response, next: NextFunction) {
    if (error instanceof WissenFehler) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }

  app.get("/wissen/:kanal/offen", async (req, res, next) => {
    try {
      if (!pcDarf(req, res)) return;
      const offen = await deps.wissen.offen(String(req.params.kanal));
      res.json({ offen: offen.map(({ id, titel, dauer }) => ({ id, titel, dauer })) });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.post("/wissen/:kanal/transkript", async (req, res, next) => {
    try {
      if (!pcDarf(req, res)) return;
      const t = await deps.wissen.lege(String(req.params.kanal), req.body);
      res.json({ ok: true, id: t.id, art: t.art, segmente: t.segmente.length });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.get("/integrations/wissen/:kanal", async (req, res, next) => {
    try {
      if (!deps.webPrincipal(req, res)) return;
      const kanal = String(req.params.kanal);
      const lehrgang = deps.lehrgang?.kanal === kanal ? await deps.lehrgang.stand() : null;
      res.json({ ...(await deps.wissen.stand(kanal)), lehrgang });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.get("/integrations/wissen/:kanal/notizen/:id", async (req, res, next) => {
    try {
      if (!deps.webPrincipal(req, res)) return;
      const kanal = String(req.params.kanal);
      const id = String(req.params.id);
      const text = await deps.wissen.notiz(kanal, id);
      if (text === null) {
        res.status(404).json({ error: `Zu ${id} liegt keine Notiz.` });
        return;
      }
      const titel = (await deps.wissen.inventar(kanal)).find((v) => v.id === id)?.titel ?? id;
      res.json({ id, titel, text });
    } catch (error) {
      fehler(error, res, next);
    }
  });
}
