import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { UI_ROOT, contentTypeFor, resolveInUi, transpileFile } from "./serve.js";

/**
 * Der Dev-Server der Oberfläche (S21). Express auf Port 3001, statische Dateien aus `ui/`,
 * TypeScript beim Ausliefern übersetzt, und ein Neuladen, wenn sich etwas ändert.
 *
 * **Kein HMR**, ausdrücklich: ein Modul im laufenden Bild auszutauschen verlangt, dass jedes
 * Modul seinen eigenen Zustand zurückgeben kann — für eine Oberfläche, deren Zustand aus einem
 * Ereignisstrom kommt, der sich in Millisekunden wieder aufbaut, wäre das viel Maschinerie für
 * nichts. Ein Neuladen ist hier die ehrlichere und schnellere Antwort.
 *
 * Er bedient **nur** die Oberfläche. Der Ereignisstrom kommt aus der Runtime bzw. dem Gateway
 * (Port 3000, `runtime/events/bus.ts`); dieser Prozess kennt weder Datenbank noch Katalog.
 */

const PORT = Number(process.env.UI_PORT ?? 3001);

const app = express();

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
 * im Repo liegt, ist die ausgelieferte Seite, und was der Dev-Server dazutut, verschwindet mit
 * ihm. `ui/build.ts` erzeugt dieselbe Datei ohne diesen Block.
 */
const RELOAD_SNIPPET = `
    <script>
      new EventSource("/__reload").onmessage = () => location.reload();
    </script>
  `;

/**
 * Jede Seite bekommt das Schnipsel, nicht nur die unter `/`: seit 2026-09-26 steht unter
 * `/welle/` eine zweite Oberfläche mit eigener `index.html`. Ein Ordnerpfad liefert deren
 * `index.html`; ohne Schrägstrich am Ende wird umgeleitet, weil die Seite ihre Dateien relativ
 * lädt (`./welle.css`) und der Browser sie sonst eine Ebene zu hoch suchte.
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
    const html = await readFile(target, "utf8");
    res.type("html").send(html.replace("</body>", `${RELOAD_SNIPPET}</body>`));
  } catch (error) {
    next(error);
  }
});

/**
 * Jede `.js`-Anfrage kommt aus einer `.ts`-Datei. Gibt es die nicht, ist das ein 404 mit
 * Begründung und keine leere Antwort, an der man später rät, warum das Modul fehlt.
 */
app.get(/\.js$/, async (req, res, next) => {
  try {
    const target = resolveInUi(req.path);
    if (target === null) {
      res.status(403).type("text/plain").send("Pfad außerhalb von ui/.");
      return;
    }
    const source = `${target.slice(0, -3)}.ts`;
    const relative = path.relative(UI_ROOT, source);
    try {
      await stat(source);
    } catch {
      res.status(404).type("text/plain").send(`Es gibt kein ${relative} in ui/.`);
      return;
    }
    res.type("application/javascript").send(await transpileFile(relative));
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
  console.log(`[ui] http://localhost:${PORT}`);
  console.log(
    `[ui] Ereignisstrom erwartet auf ws://localhost:${process.env.EVENTS_PORT ?? 3000}/events`,
  );
});

// Ein Beobachter über `ui/` reicht: die Oberfläche ist flach, und `recursive` deckt die beiden
// Unterordner mit ab. Gebündelt über ein kurzes Fenster, weil ein Editor beim Speichern
// mehrere Ereignisse auslöst und ein Neuladen je Ereignis das Fenster flackern ließe.
let pending: NodeJS.Timeout | null = null;
const watcher = watch(UI_ROOT, { recursive: true }, (_event, filename) => {
  if (filename === null || filename.endsWith(".test.ts")) return;
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    console.log(`[ui] ${filename} geändert — neu laden.`);
    announceReload(String(filename));
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
