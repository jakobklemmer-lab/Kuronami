/**
 * Probe des Begleiters unter xvfb, ohne Mac:
 *
 *   xvfb-run -a desktop/node_modules/electron/dist/electron --no-sandbox desktop/probe-begleiter.cjs
 *
 * Startet die App mit leerem Profil gegen `KURO_ADRESSE` (Vorgabe: der Dev-Server auf 3101),
 * meldet sich mit `GATEWAY_WEB_TOKEN` aus `KURO_ENV` an und prüft: beide Fenster da, Brücke da,
 * Zustand vom Gateway und von der Sprechtaste kommt an, Ziehen per IPC, Rand, Blase, Tray-Schalter.
 * Gibt keine Inhalte aus dem Gespräch aus, nur Längen. Bilder nach `/tmp/kuronami-ansehen/`.
 */
const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const profil = fs.mkdtempSync(path.join(os.tmpdir(), "kuro-probe-"));
app.setPath("userData", profil);
const adresse = process.env.KURO_ADRESSE ?? "http://localhost:3101";
fs.writeFileSync(
  path.join(profil, "kuro-os.json"),
  JSON.stringify({ adresse, sprechtasteAn: false }),
);
const token =
  /^GATEWAY_WEB_TOKEN=(.*)$/m
    .exec(fs.readFileSync(process.env.KURO_ENV ?? "/opt/kuronami/.env", "utf8"))?.[1]
    ?.trim() ?? "";

const app_ = require("./main.cjs");

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
let fehler = 0;
const pruefe = (name, ok, mehr = "") => {
  if (!ok) fehler += 1;
  console.log(`${ok ? "ok  " : "FEHL"} ${name}${mehr ? ` — ${mehr}` : ""}`);
};
async function bis(bedingung, ms = 8000) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await bedingung()) return true;
    await warte(100);
  }
  return false;
}
const fenster = () => {
  const alle = BrowserWindow.getAllWindows();
  return {
    haupt: alle.find(
      (w) =>
        w.webContents.getURL().includes("/os/") && !w.webContents.getURL().includes("begleiter"),
    ),
    begleiter: alle.find((w) => w.webContents.getURL().includes("/os/begleiter/")),
  };
};
const imBegleiter = (js) => fenster().begleiter.webContents.executeJavaScript(js);
const konfig = () => JSON.parse(fs.readFileSync(path.join(profil, "kuro-os.json"), "utf8"));

app.whenReady().then(async () => {
  try {
    await bis(() => fenster().haupt && fenster().begleiter);
    const { haupt, begleiter } = fenster();
    pruefe("Hauptfenster lädt /os/", Boolean(haupt));
    pruefe("Begleiter lädt /os/begleiter/", Boolean(begleiter));
    if (!haupt || !begleiter) throw new Error("Fenster fehlen");
    await bis(() => !begleiter.webContents.isLoading() && !haupt.webContents.isLoading());

    const b = begleiter.getBounds();
    pruefe("Begleiter 320 × 460", b.width === 320 && b.height === 460, JSON.stringify(b));
    pruefe("immer oben", begleiter.isAlwaysOnTop());
    pruefe("auf allen Schreibtischen", begleiter.isVisibleOnAllWorkspaces?.() ?? true);
    pruefe(
      "Brücke im Begleiter",
      await imBegleiter(
        "['beiBegleiterLage','beiZeiger','begleiterFlaechen','begleiterZiehen','begleiterBlase','oeffneHaupt','beiSprechtaste'].every((n) => typeof kuroDesktop[n] === 'function')",
      ),
    );
    pruefe(
      "Brücke im Hauptfenster",
      await haupt.webContents.executeJavaScript(
        "typeof kuroDesktop.beiSprechtaste === 'function' && !('zustand' in kuroDesktop)",
      ),
    );
    pruefe(
      "Seite weiß, dass sie im Fenster läuft",
      await imBegleiter("document.body.classList.contains('ist-im-fenster')"),
    );

    // Angemeldet wie das Hauptfenster: derselbe Seitenspeicher. Der Begleiter merkt es selbst.
    const vorAnmeldung = await imBegleiter("document.querySelector('.fg').dataset.zustand");
    pruefe("vor der Anmeldung: offline", vorAnmeldung === "offline");
    await haupt.webContents.executeJavaScript(
      `localStorage.setItem("kuronami.webToken", ${JSON.stringify(token)})`,
    );
    // Ohne Ereignisstrom stünde er nach 4 s auf „offline" (`OFFLINE_NACH_MS` im Gespräch).
    await warte(6000);
    const zustand = await imBegleiter("document.querySelector('.fg')?.dataset.zustand");
    const strom = await imBegleiter("document.querySelector('[data-role=zustand]').textContent");
    pruefe(
      "Zustand vom Gateway kommt an",
      zustand && zustand !== "offline",
      `Zustand ${zustand} nach 6 s`,
    );
    pruefe("Kein Satz „Keine Verbindung“", !strom.includes("Keine Verbindung"));
    // Das Hauptfenster speichert eine (erfundene) Antwort; der Begleiter übernimmt sie, ohne zu schreiben.
    const probe = {
      id: "probe",
      von: "kuro",
      text: "Probe: erfundene Antwort",
      zeit: Date.now() + 60_000,
      zugId: null,
      stand: "fertig",
      tafeln: [],
    };
    await haupt.webContents.executeJavaScript(
      `localStorage.setItem("kuronami.welle.verlauf", ${JSON.stringify(JSON.stringify({ fassung: 1, eintraege: [probe] }))})`,
    );
    pruefe(
      "Antwort aus dem Hauptfenster steht in der Blase",
      await bis(
        async () =>
          (await imBegleiter("document.querySelector('.b-antwort').textContent")) === probe.text,
        3000,
      ),
    );

    app_.meldeSprechtaste(true);
    pruefe(
      "Sprechtaste: er hört zu",
      await bis(
        async () =>
          (await imBegleiter("document.querySelector('.fg').dataset.zustand")) === "zuhoeren",
        2000,
      ),
    );
    app_.meldeSprechtaste(false);
    pruefe(
      "Sprechtaste los: zurück",
      await bis(
        async () =>
          (await imBegleiter("document.querySelector('.fg').dataset.zustand")) !== "zuhoeren",
        2000,
      ),
    );

    // Durchklicken: die Seite meldet die Figur; der Zeiger steht unter xvfb weit weg.
    await warte(300);
    const innen = app_.begleiterInnen();
    const f = innen.flaechen[0];
    const figurMitte = f ? f.x + f.w / 2 : Number.NaN;
    pruefe(
      "Seite meldet die Figur als Klickfläche",
      innen.flaechen.length === 1 &&
        Math.abs(figurMitte - (160 + innen.aufbau.versatz)) < 2 &&
        f.y > 260,
      f
        ? `x ${Math.round(f.x)}, y ${Math.round(f.y)}, ${Math.round(f.w)} × ${Math.round(f.h)}`
        : "keine",
    );
    pruefe("außerhalb der Figur durchklickbar", innen.durchklick === true);

    // Sichtbar, wenn Kuro OS nicht vorn ist.
    haupt.hide();
    pruefe("Kuro OS versteckt: Begleiter sichtbar", await bis(() => begleiter.isVisible(), 2000));
    haupt.show();
    haupt.focus();
    const weg = await bis(() => !begleiter.isVisible(), 2000);
    pruefe("Kuro OS vorn: Begleiter weg", weg, weg ? "" : `fokussiert: ${haupt.isFocused()}`);
    haupt.hide();
    await bis(() => begleiter.isVisible(), 2000);

    // Ziehen über die Brücke, mit Bildschirmpunkten.
    const wa = screen.getPrimaryDisplay().workArea;
    const vorher = begleiter.getBounds();
    const sx = vorher.x + 160;
    const sy = vorher.y + 380;
    await imBegleiter(`kuroDesktop.begleiterZiehen("start", ${sx}, ${sy})`);
    await imBegleiter(`kuroDesktop.begleiterZiehen("zug", ${sx - 300}, ${sy - 120})`);
    await warte(150);
    const mitten = begleiter.getBounds();
    pruefe(
      "Ziehen verschiebt das Fenster",
      mitten.x === vorher.x - 300 && mitten.y === vorher.y - 120,
      `${vorher.x},${vorher.y} → ${mitten.x},${mitten.y}`,
    );
    await imBegleiter(`kuroDesktop.begleiterZiehen("ende", ${sx - 300}, ${sy - 120})`);
    await warte(300);
    const gemerkt = konfig().begleiter;
    pruefe(
      "Lage in kuro-os.json gemerkt",
      gemerkt && Number.isFinite(gemerkt.x),
      JSON.stringify(gemerkt),
    );

    // An den linken Rand: halb hinaus.
    const jetzt = begleiter.getBounds();
    const zx = jetzt.x + 160;
    await imBegleiter(`kuroDesktop.begleiterZiehen("start", ${zx}, ${sy - 120})`);
    await imBegleiter(`kuroDesktop.begleiterZiehen("zug", ${wa.x + 10}, ${sy - 120})`);
    await imBegleiter(`kuroDesktop.begleiterZiehen("ende", ${wa.x + 10}, ${sy - 120})`);
    await warte(300);
    const rand = await imBegleiter("document.querySelector('.b-buehne').dataset.rand");
    pruefe(
      "am Rand halb hinaus",
      rand === "links" && konfig().begleiter.x === wa.x - 84,
      `rand ${rand}, x ${konfig().begleiter.x}`,
    );
    await warte(500);
    fs.writeFileSync(
      "/tmp/kuronami-ansehen/electron-begleiter-rand.png",
      (await begleiter.webContents.capturePage()).toPNG(),
    );

    // Klick auf den Zurückgenommenen: er kommt herein, die Blase geht auf.
    await imBegleiter("kuroDesktop.begleiterBlase(true)");
    await warte(300);
    const offen = await imBegleiter(
      "!document.querySelector('.b-blase').hidden && document.querySelector('.b-buehne').dataset.rand === ''",
    );
    const figurX =
      begleiter.getBounds().x +
      160 +
      Number(
        await imBegleiter(
          "parseFloat(getComputedStyle(document.querySelector('.b-buehne')).getPropertyValue('--versatz'))",
        ),
      ) -
      84;
    pruefe(
      "Blase auf, er kommt vom Rand herein",
      offen && figurX === wa.x,
      `Figur bei x ${figurX}`,
    );
    await warte(200);
    pruefe("Blase zählt als Klickfläche", app_.begleiterInnen().flaechen.length === 2);
    await warte(200);
    fs.writeFileSync(
      "/tmp/kuronami-ansehen/electron-begleiter-blase.png",
      (await begleiter.webContents.capturePage()).toPNG(),
    );
    await imBegleiter("kuroDesktop.begleiterBlase(false)");
    await warte(300);
    pruefe(
      "Blase zu, er geht zurück an den Rand",
      (await imBegleiter("document.querySelector('.b-buehne').dataset.rand")) === "links",
    );

    // Tray-Schalter „Kuro auf dem Desktop".
    app_.setzeBegleiterAn(false);
    pruefe("Schalter aus: Begleiter weg", await bis(() => !begleiter.isVisible(), 2000));
    pruefe("Schalter gemerkt", konfig().begleiterAn === false);
    app_.setzeBegleiterAn(true);
    pruefe("Schalter an: Begleiter wieder da", await bis(() => begleiter.isVisible(), 2000));
  } catch (e) {
    fehler += 1;
    console.log("FEHL", e);
  }
  console.log(fehler === 0 ? "Probe grün." : `Probe rot: ${fehler} Fehler.`);
  app.exit(fehler === 0 ? 0 : 1);
});
