import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import express from "express";
import {
  UI_ROOT,
  contentTypeFor,
  loeseModulPfad,
  resolveInUi,
  statischeImporte,
  transpileMitKarte,
  versioniere,
} from "./serve.js";

/**
 * Der Server der Oberfläche (S21). Express auf Port 3001, statische Dateien aus `ui/`,
 * TypeScript beim Ausliefern übersetzt, und ein Neuladen, wenn sich etwas ändert.
 *
 * **Kein HMR**, ausdrücklich: ein Modul im laufenden Bild auszutauschen verlangt, dass jedes
 * Modul seinen eigenen Zustand zurückgeben kann — für eine Oberfläche, deren Zustand aus einem
 * Ereignisstrom kommt, der sich in Millisekunden wieder aufbaut, wäre das viel Maschinerie für
 * nichts. Ein Neuladen ist hier die ehrlichere und schnellere Antwort.
 *
 * **Schnell ausliefern (03.10.)** — dieser Server ist auch der, von dem die Desktop-App lädt.
 * Gemessen vorher: 102 Anfragen und 3,9 MB bei jedem kalten Start, und bei jedem warmen fragte
 * der Browser alle 93 Dateien einzeln nach, jede neu übersetzt. Jetzt:
 *  - jede Datei wird einmal übersetzt und bis zur nächsten Änderung im Speicher gehalten;
 *  - jede Modul-Adresse trägt den **Stand** (`?v=…`, ein Fingerabdruck über alle Dateien in
 *    `ui/`); so versehene Antworten darf der Browser für immer behalten — ein warmer Start lädt
 *    nur noch die Seite selbst;
 *  - die Seite nennt alle Module, die sie braucht, vorab (`modulepreload`): statt Ebene um Ebene
 *    nachzufragen, lädt der Browser alles in einem Zug;
 *  - die Quelltext-Karte ist eine eigene Datei, nur für die Entwicklerwerkzeuge.
 *
 * Er bedient **nur** die Oberfläche. Der Ereignisstrom kommt aus dem Gateway (Port 3000).
 */

const PORT = Number(process.env.UI_PORT ?? 3001);
const IMMER = "public, max-age=31536000, immutable";

const app = express();

// ------------------------------------------------------------------------------ Stand

/** Fingerabdruck über Namen, Größe und Änderungszeit aller Dateien in `ui/`. */
async function berechneStand(): Promise<string> {
  const teile: string[] = [];
  async function lauf(ordner: string): Promise<void> {
    for (const eintrag of await readdir(ordner, { withFileTypes: true })) {
      if (eintrag.name === "dist" || eintrag.name === "node_modules") continue;
      const voll = path.join(ordner, eintrag.name);
      if (eintrag.isDirectory()) await lauf(voll);
      else if (!eintrag.name.endsWith(".test.ts")) {
        const info = await stat(voll);
        teile.push(`${path.relative(UI_ROOT, voll)}:${info.size}:${Math.round(info.mtimeMs)}`);
      }
    }
  }
  await lauf(UI_ROOT);
  return createHash("sha1").update(teile.sort().join("\n")).digest("hex").slice(0, 10);
}

let stand = await berechneStand();

/** Übersetzte und versionierte Module, je Datei bis zu ihrer nächsten Änderung. */
const modulSpeicher = new Map<
  string,
  { mtime: number; stand: string; js: string; karte: string | null }
>();

/** Ein Modul, wie es hinausgeht: `.ts` übersetzt, `.mjs` wie es ist — beide mit Stand. */
async function modul(urlPfad: string): Promise<{ js: string; karte: string | null } | null> {
  const ziel = resolveInUi(urlPfad);
  if (ziel === null) return null;
  const quelle = urlPfad.endsWith(".mjs") ? ziel : `${ziel.slice(0, -3)}.ts`;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(quelle);
  } catch {
    return null;
  }
  const gemerkt = modulSpeicher.get(urlPfad);
  if (gemerkt && gemerkt.mtime === info.mtimeMs && gemerkt.stand === stand) return gemerkt;
  const text = await readFile(quelle, "utf8");
  const roh = urlPfad.endsWith(".mjs")
    ? { js: text, karte: null }
    : transpileMitKarte(text, quelle);
  const eintrag = { mtime: info.mtimeMs, stand, js: versioniere(roh.js, stand), karte: roh.karte };
  modulSpeicher.set(urlPfad, eintrag);
  return eintrag;
}

/** Alle Module, die `einstieg` statisch braucht, als URL-Pfade — für die Vorladeliste. */
async function modulBaum(einstieg: string): Promise<string[]> {
  const gesehen = new Set<string>();
  const offen = [einstieg];
  while (offen.length > 0) {
    const pfad = offen.pop() as string;
    if (gesehen.has(pfad)) continue;
    gesehen.add(pfad);
    const m = await modul(pfad);
    // Nur, was es gibt — ein Beispiel-Import in einem Kommentar ist kein Modul.
    if (!m) {
      gesehen.delete(pfad);
      continue;
    }
    for (const angabe of statischeImporte(m.js)) {
      offen.push(loeseModulPfad(pfad, angabe.split("?")[0]));
    }
  }
  return [...gesehen];
}

const cacheKopf = (req: express.Request, res: express.Response) => {
  res.setHeader("cache-control", req.query.v === stand ? IMMER : "no-cache");
};

// --------------------------------------------------------------------------- Neuladen

/** Die Clients, die auf ein Neuladen warten (Server-Sent Events, kein zweiter WebSocket). */
const reloadClients = new Set<express.Response>();

app.get("/__reload", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": verbunden\n\n");
  reloadClients.add(res);
  req.on("close", () => {
    reloadClients.delete(res);
  });
});

function announceReload(reason: string): void {
  for (const client of reloadClients) client.write(`data: ${reason}\n\n`);
}

/**
 * Das Neulade-Schnipsel wird in `index.html` eingefügt, nicht in die Datei geschrieben: was
 * im Repo liegt, ist die ausgelieferte Seite, und was der Server dazutut, verschwindet mit
 * ihm. `ui/build.ts` erzeugt dieselbe Datei ohne diesen Block.
 */
const RELOAD_SNIPPET = `
    <script>
      new EventSource("/__reload").onmessage = () => location.reload();
    </script>
  `;

// ------------------------------------------------------------------------------ Seiten

/**
 * Jede Seite bekommt das Schnipsel, die versionierten Adressen ihrer eigenen Dateien und die
 * Vorladeliste ihrer Module. Ein Ordnerpfad liefert dessen `index.html`; ohne Schrägstrich am
 * Ende wird umgeleitet, weil die Seite ihre Dateien relativ lädt (`./welle.css`).
 */
app.get(/(^\/$|\/index\.html$|^(\/[a-z-]+)+\/?$)/, async (req, res, next) => {
  try {
    const seite = req.path.endsWith("index.html")
      ? req.path
      : `${req.path.replace(/\/?$/, "/")}index.html`;
    const target = resolveInUi(seite);
    if (target === null) {
      res.status(403).type("text/plain").send("Pfad außerhalb von ui/.");
      return;
    }
    try {
      await stat(target);
    } catch {
      next();
      return;
    }
    if (!req.path.endsWith("/") && !req.path.endsWith("index.html")) {
      res.redirect(302, `${req.path}/`);
      return;
    }
    let html = await readFile(target, "utf8");
    // Eigene Dateien (relativ angegeben) mit Stand, fremde (https://…) bleiben, wie sie sind.
    html = html.replace(
      /(<(?:script|link)\b[^>]*?\b(?:src|href)=")(\.{1,2}\/[^"?]+\.(?:js|css|mjs))(")/g,
      (_m, vor: string, pfad: string, nach: string) => `${vor}${pfad}?v=${stand}${nach}`,
    );
    const einstieg = /<script\b[^>]*type="module"[^>]*src="([^"?]+)/.exec(html)?.[1];
    if (einstieg) {
      const baum = await modulBaum(loeseModulPfad(seite, einstieg));
      const vorladen = baum
        .map((p) => `    <link rel="modulepreload" href="${p}?v=${stand}" />`)
        .join("\n");
      html = html.replace("</head>", `${vorladen}\n  </head>`);
    }
    res.setHeader("cache-control", "no-cache");
    res.type("html").send(html.replace("</body>", `${RELOAD_SNIPPET}</body>`));
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------------------------ Module

/**
 * Jede `.js`-Anfrage kommt aus einer `.ts`-Datei, jede `.mjs` ist ein fertiges Modul aus
 * `vendor/`. Gibt es die Quelle nicht, ist das ein 404 mit Begründung und keine leere Antwort,
 * an der man später rät, warum das Modul fehlt.
 */
app.get(/\.m?js$/, async (req, res, next) => {
  try {
    if (resolveInUi(req.path) === null) {
      res.status(403).type("text/plain").send("Pfad außerhalb von ui/.");
      return;
    }
    const m = await modul(req.path);
    if (!m) {
      res.status(404).type("text/plain").send(`Es gibt kein ${req.path} in ui/.`);
      return;
    }
    cacheKopf(req, res);
    res.type("application/javascript").send(m.js);
  } catch (error) {
    next(error);
  }
});

app.get(/\.js\.map$/, async (req, res, next) => {
  try {
    const m = await modul(req.path.slice(0, -4));
    if (!m?.karte) {
      res.status(404).type("text/plain").send("Keine Quelltext-Karte.");
      return;
    }
    res.setHeader("cache-control", "no-cache");
    res.type("application/json").send(m.karte);
  } catch (error) {
    next(error);
  }
});

app.get(/.*/, async (req, res, next) => {
  try {
    const target = resolveInUi(req.path);
    if (target === null) {
      res.status(403).type("text/plain").send("Pfad außerhalb von ui/.");
      return;
    }
    try {
      await stat(target);
    } catch {
      res.status(404).type("text/plain").send(`Nicht gefunden: ${req.path}`);
      return;
    }
    cacheKopf(req, res);
    res.type(contentTypeFor(target)).send(await readFile(target));
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ): void => {
    // Der Fehlertext geht unverändert hinaus — beim Entwickeln ist er die eigentliche Nachricht.
    console.error("[ui]", error);
    res
      .status(500)
      .type("text/plain")
      .send(error instanceof Error ? error.message : String(error));
  },
);

const server = app.listen(PORT, () => {
  console.log(`[ui] http://localhost:${PORT} (Stand ${stand})`);
  console.log(
    `[ui] Ereignisstrom erwartet auf ws://localhost:${process.env.EVENTS_PORT ?? 3000}/events`,
  );
});

// Ein Beobachter über `ui/` reicht: `recursive` deckt die Unterordner mit ab. Gebündelt über ein
// kurzes Fenster, weil ein Editor beim Speichern mehrere Ereignisse auslöst. Vor dem Neuladen
// steht der neue Stand fest — sonst hielte der Browser die alten Dateien für aktuell.
let pending: NodeJS.Timeout | null = null;
const watcher = watch(UI_ROOT, { recursive: true }, (_event, filename) => {
  if (filename === null || filename.endsWith(".test.ts") || filename.startsWith("dist")) return;
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void berechneStand().then((neu) => {
      if (neu === stand) return;
      stand = neu;
      console.log(`[ui] ${filename} geändert — neu laden (Stand ${stand}).`);
      announceReload(String(filename));
    });
  }, 80);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[ui] ${signal} — herunterfahren.`);
    watcher.close();
    for (const client of reloadClients) client.end();
    server.close(() => process.exit(0));
  });
}
