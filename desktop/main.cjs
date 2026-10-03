/**
 * Kuro OS als Desktop-App (2026-10-02). Die Oberfläche kommt vom Server (`/os/`), damit es
 * nur eine gibt; die App bringt, was ein Browser nicht kann: eine Sprechtaste, die auch wirkt,
 * wenn ein anderes Programm vorn ist, den kleinen Kuro als Begleiter auf dem Schreibtisch, Tray und
 * Autostart.
 */
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const L = require("./begleiter-lage.cjs");

const MAC = process.platform === "darwin";
const BILD = (name) => path.join(__dirname, "bild", name);

// ------------------------------------------------------------------ Einstellungen

const KONFIG = () => path.join(app.getPath("userData"), "kuro-os.json");
const VORGABE = {
  adresse: null,
  // Rechte Wahltaste am Mac, rechte Strg-Taste unter Windows — beide tippen sonst kaum etwas.
  sprechtaste: MAC ? "AltRight" : "CtrlRight",
  sprechtasteAn: true,
  begleiterAn: true,
  /** Ecke oben links der Figur; `null` heißt unten rechts. */
  begleiter: null,
};

function liesKonfig() {
  try {
    return { ...VORGABE, ...JSON.parse(fs.readFileSync(KONFIG(), "utf8")) };
  } catch {
    return { ...VORGABE };
  }
}

function schreibeKonfig(k) {
  fs.mkdirSync(path.dirname(KONFIG()), { recursive: true });
  fs.writeFileSync(KONFIG(), JSON.stringify(k, null, 2));
}

let konfig = VORGABE;

function osAdresse() {
  return konfig.adresse ? new URL("/os/", konfig.adresse).toString() : null;
}

function gleicherUrsprung(url) {
  try {
    return konfig.adresse !== null && new URL(url).origin === new URL(konfig.adresse).origin;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- Fenster

/** @type {BrowserWindow | null} */
let haupt = null;
/** @type {BrowserWindow | null} */
let begleiter = null;
/** @type {Tray | null} */
let tray = null;
let beenden = false;

function erstelleHaupt() {
  haupt = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: "#0d0c0a",
    title: "Kuro OS",
    // Oben ist in Kuro OS nichts (4c, alles steht in der Statuszeile unten); die Seite lässt einen
    // schmalen Streifen frei, an dem das Fenster hängt und in dem Ampel bzw. Knöpfe sitzen.
    titleBarStyle: MAC ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 14, y: 8 },
    ...(MAC ? {} : { titleBarOverlay: { color: "#00000000", symbolColor: "#a39d92", height: 32 } }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Die Sprachsitzung läuft weiter, wenn ein anderes Programm vorn ist.
      backgroundThrottling: false,
    },
  });
  haupt.once("ready-to-show", () => {
    haupt?.maximize();
    haupt?.show();
  });
  const ziel = osAdresse();
  if (ziel) void haupt.loadURL(ziel);
  else void haupt.loadFile(path.join(__dirname, "einrichten.html"));

  // Was nicht zu Kuronami gehört, öffnet der Browser.
  haupt.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  haupt.webContents.on("will-navigate", (e, url) => {
    // Auch keine abgelegte Datei als Seite: die nimmt Kuro OS selbst entgegen.
    if (gleicherUrsprung(url)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  haupt.webContents.on("did-fail-load", (_e, code, beschreibung, url) => {
    if (code === -3 || !gleicherUrsprung(url)) return;
    void haupt?.loadFile(path.join(__dirname, "einrichten.html"), {
      query: { fehler: `${beschreibung} (${url})` },
    });
  });

  // Schließen heißt verstecken: Sprechtaste und Mitteilungen bleiben, bis „Beenden".
  haupt.on("close", (e) => {
    if (beenden) return;
    e.preventDefault();
    haupt?.hide();
  });
  for (const art of ["focus", "blur", "show", "hide", "minimize", "restore"]) {
    haupt.on(art, () => aktualisiereBegleiter());
  }
}

function zeigeHaupt() {
  if (!haupt) erstelleHaupt();
  if (haupt?.isMinimized()) haupt.restore();
  haupt?.show();
  haupt?.focus();
}

// ----------------------------------------------------------------- Begleiter

/**
 * Der kleine Kuro auf dem Schreibtisch: die Seite `/os/begleiter/` in einem randlosen,
 * durchsichtigen Fenster über allen Programmen. Er zeigt sich, wenn Kuro OS nicht vorn ist.
 * Durchklickbar ist alles außer Figur und Blase; das entscheidet ein Blick auf den Zeiger alle
 * 50 ms statt `forward` — so kommt auch eine Datei, die man aus dem Finder zieht, bei ihm an.
 */

/** @type {{ x: number, y: number, rand: "links" | "rechts" | null }} */
let lageFigur = { x: 0, y: 0, rand: null };
let aufbauJetzt = null;
let blaseOffen = false;
/** Flächen von Figur und Blase im Fenster, von der Seite gemeldet. */
let flaechen = [];
let durchklick = true;
/** Während des Ziehens: wo im Fenster der Zeiger gefasst hat. */
let anker = null;
let zeigerUhr = null;
let zeigerZuletzt = null;
let sichtUhr = null;

const schirme = () =>
  screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea }));
const begleiterAdresse = () =>
  konfig.adresse ? new URL("/os/begleiter/", konfig.adresse).toString() : null;

function erstelleBegleiter() {
  const ziel = begleiterAdresse();
  if (!ziel || begleiter) return;
  lageFigur = L.startLage(konfig.begleiter, schirme(), screen.getPrimaryDisplay());
  aufbauJetzt = L.aufbau(lageFigur, schirme());
  begleiter = new BrowserWindow({
    ...aufbauJetzt.fenster,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    // Am Mac sonst nie über der Menüleiste und nie halb aus dem Schirm.
    enableLargerThanScreen: true,
    // Der erste Klick auf ihn gilt schon, auch wenn ein anderes Programm vorn ist.
    acceptFirstMouse: true,
    title: "Kuro",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  begleiter.setAlwaysOnTop(true, "floating");
  // Kuro OS ist schon eine Vordergrund-App; ohne `skip` verschwände das Dock kurz.
  begleiter.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  begleiter.setIgnoreMouseEvents(true);
  durchklick = true;
  begleiter.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  begleiter.webContents.on("will-navigate", (e, url) => {
    if (gleicherUrsprung(url)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  begleiter.webContents.on("did-finish-load", () => {
    anker = null;
    sendeAufbau();
  });
  // Ohne Server bleibt er unsichtbar und versucht es später wieder.
  begleiter.webContents.on("did-fail-load", (_e, code, _b, url) => {
    if (code === -3 || !gleicherUrsprung(url)) return;
    setTimeout(() => {
      const neu = begleiterAdresse();
      if (begleiter && neu) void begleiter.loadURL(neu);
    }, 30_000);
  });
  begleiter.on("blur", () => setzeBlase(false));
  begleiter.on("closed", () => {
    begleiter = null;
    stoppeZeiger();
  });
  void begleiter.loadURL(ziel);
}

function sendeAufbau() {
  if (!begleiter || !aufbauJetzt) return;
  begleiter.webContents.send("begleiter-lage", {
    seite: aufbauJetzt.seite,
    versatz: aufbauJetzt.versatz,
    rand: blaseOffen ? null : lageFigur.rand,
    offen: blaseOffen,
  });
}

/** Stellt das Fenster so, dass die Figur bei `figur` steht. */
function stelleBegleiter(figur) {
  if (!begleiter) return;
  aufbauJetzt = L.aufbau(figur, schirme());
  begleiter.setBounds(aufbauJetzt.fenster);
  sendeAufbau();
}

function setzeBlase(offen) {
  if (!begleiter || offen === blaseOffen) return;
  blaseOffen = offen;
  stelleBegleiter(offen ? L.ausDemRand(lageFigur, schirme()) : lageFigur);
}

function merkeLage() {
  konfig = { ...konfig, begleiter: { x: lageFigur.x, y: lageFigur.y } };
  schreibeKonfig(konfig);
}

/**
 * Sichtbar, wenn eingeschaltet und Kuro OS nicht vorn ist — ist es vorn, ist Kuro dort. Kurz
 * verzögert, damit er beim Wechsel zwischen den Fenstern nicht aufblitzt.
 */
function aktualisiereBegleiter() {
  if (sichtUhr) clearTimeout(sichtUhr);
  sichtUhr = setTimeout(() => {
    sichtUhr = null;
    if (!begleiter) return;
    const vorn = haupt?.isVisible() && haupt.isFocused() && !haupt.isMinimized();
    const zeigen = konfig.begleiterAn && !vorn;
    if (zeigen && !begleiter.isVisible()) {
      begleiter.showInactive();
      starteZeiger();
    } else if (!zeigen && begleiter.isVisible()) {
      // Ein Ziehen, dessen Ende nie ankam, hielte sonst das Durchklicken an.
      anker = null;
      setzeBlase(false);
      begleiter.hide();
      stoppeZeiger();
    }
  }, 150);
}

function setzeBegleiterAn(an) {
  konfig = { ...konfig, begleiterAn: an };
  schreibeKonfig(konfig);
  aktualisiereBegleiter();
}

/** Der Zeiger entscheidet über Durchklicken, und Kuro schaut ihm nach — über den ganzen Schirm. */
function zeigerTakt() {
  if (!begleiter?.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = begleiter.getBounds();
  const punkt = { x: p.x - b.x, y: p.y - b.y };
  if (anker === null) {
    const drin = L.trifft(punkt, flaechen);
    if (drin === durchklick) {
      durchklick = !drin;
      begleiter.setIgnoreMouseEvents(durchklick);
    }
  }
  if (zeigerZuletzt?.x !== punkt.x || zeigerZuletzt?.y !== punkt.y) {
    zeigerZuletzt = punkt;
    begleiter.webContents.send("begleiter-zeiger", punkt);
  }
}

function starteZeiger() {
  zeigerUhr ??= setInterval(zeigerTakt, 50);
}

function stoppeZeiger() {
  if (zeigerUhr) clearInterval(zeigerUhr);
  zeigerUhr = null;
}

const vomBegleiter = (e) => begleiter !== null && e.sender === begleiter.webContents;
const zahl = (w) => (Number.isFinite(w) ? Number(w) : null);

ipcMain.on("begleiter-flaechen", (e, liste) => {
  if (!vomBegleiter(e) || !Array.isArray(liste)) return;
  flaechen = liste
    .slice(0, 4)
    .map((r) => ({ x: zahl(r?.x), y: zahl(r?.y), w: zahl(r?.w), h: zahl(r?.h) }))
    .filter((r) => r.x !== null && r.y !== null && r.w !== null && r.h !== null);
});

/** Ziehen über Bildschirmpunkte: `-webkit-app-region: drag` schluckte Klick, Doppelklick und Dateien. */
ipcMain.on("begleiter-ziehen", (e, phase, x, y) => {
  if (!vomBegleiter(e) || zahl(x) === null || zahl(y) === null) return;
  const b = begleiter.getBounds();
  if (phase === "start") {
    if (blaseOffen) {
      blaseOffen = false;
      sendeAufbau();
    }
    anker = { x: x - b.x, y: y - b.y };
  } else if (phase === "zug" && anker) {
    begleiter.setPosition(Math.round(x - anker.x), Math.round(y - anker.y));
  } else if (phase === "ende" && anker) {
    anker = null;
    const figur = L.figurAus(begleiter.getBounds(), aufbauJetzt);
    lageFigur = L.setzeAb(figur, schirme());
    stelleBegleiter(lageFigur);
    merkeLage();
  }
});

ipcMain.on("begleiter-blase", (e, offen) => {
  if (vomBegleiter(e)) setzeBlase(offen === true);
});

ipcMain.on("begleiter-haupt", (e) => {
  if (vomBegleiter(e)) zeigeHaupt();
});

/** Ein Schirm kam dazu, ging weg oder änderte sich: er bleibt auf einem, der da ist. */
function holeAufSchirm() {
  if (!begleiter) return;
  lageFigur = L.setzeAb(lageFigur, schirme());
  stelleBegleiter(blaseOffen ? L.ausDemRand(lageFigur, schirme()) : lageFigur);
}

// ---------------------------------------------------------------- Sprechtaste

/**
 * Systemweit über uiohook: Electrons eigene Kürzel kennen kein Loslassen. Die Taste gilt erst
 * nach 180 ms ohne eine zweite — sonst wäre ⌥L (@) am Mac oder AltGr unter Windows Sprechen.
 * Solange sie gehalten ist, geht alle 300 ms „an" hinaus: so findet die Sprachsitzung, die der
 * erste Druck erst öffnet, den Zustand, sobald sie steht.
 */
let hook = null;

/** Kuro OS hört zu; der Begleiter leuchtet dabei im Zuhör-Zustand. */
function meldeSprechtaste(an) {
  haupt?.webContents.send("sprechtaste", an);
  begleiter?.webContents.send("sprechtaste", an);
}

function starteSprechtaste() {
  if (!konfig.sprechtasteAn || hook) return;
  if (MAC && !systemPreferences.isTrustedAccessibilityClient(true)) {
    // macOS fragt jetzt nach „Bedienungshilfen"; nach dem Erlauben gilt es beim nächsten Start.
    return;
  }
  let modul;
  try {
    modul = require("uiohook-napi");
  } catch (fehler) {
    console.warn("[kuro-os] Sprechtaste nicht verfügbar:", fehler);
    return;
  }
  const { uIOhook, UiohookKey } = modul;
  const taste = UiohookKey[konfig.sprechtaste];
  if (taste === undefined) return;
  let unten = false;
  let aktiv = false;
  let warte = null;
  let wiederhole = null;
  const sende = (an) => meldeSprechtaste(an);
  const loese = () => {
    if (warte) clearTimeout(warte);
    if (wiederhole) clearInterval(wiederhole);
    warte = null;
    wiederhole = null;
    if (aktiv) sende(false);
    aktiv = false;
    unten = false;
  };
  uIOhook.on("keydown", (e) => {
    if (e.keycode === taste) {
      if (unten) return;
      unten = true;
      warte = setTimeout(() => {
        aktiv = true;
        sende(true);
        wiederhole = setInterval(() => sende(true), 300);
      }, 180);
    } else if (unten) {
      loese();
    }
  });
  uIOhook.on("keyup", (e) => {
    if (e.keycode === taste) loese();
  });
  try {
    uIOhook.start();
    hook = uIOhook;
  } catch (fehler) {
    uIOhook.removeAllListeners();
    console.warn("[kuro-os] Sprechtaste konnte nicht starten:", fehler);
  }
}

function stoppeSprechtaste() {
  hook?.stop();
  hook?.removeAllListeners();
  hook = null;
}

// ---------------------------------------------------------------------- Tray

const TASTEN_NAME = { AltRight: "rechte Wahltaste", CtrlRight: "rechte Strg-Taste" };

function baueTray() {
  const bild = nativeImage.createFromPath(BILD(MAC ? "trayTemplate.png" : "tray.png"));
  if (MAC) bild.setTemplateImage(true);
  tray ??= new Tray(bild);
  tray.setToolTip("Kuro OS");
  const autostart = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Kuro OS zeigen", click: zeigeHaupt },
      { type: "separator" },
      {
        label: `Sprechtaste (${TASTEN_NAME[konfig.sprechtaste] ?? konfig.sprechtaste})`,
        type: "checkbox",
        checked: konfig.sprechtasteAn,
        click: (m) => {
          konfig = { ...konfig, sprechtasteAn: m.checked };
          schreibeKonfig(konfig);
          if (m.checked) starteSprechtaste();
          else stoppeSprechtaste();
        },
      },
      {
        label: "Kuro auf dem Desktop",
        type: "checkbox",
        checked: konfig.begleiterAn,
        click: (m) => setzeBegleiterAn(m.checked),
      },
      {
        label: "Beim Anmelden starten",
        type: "checkbox",
        checked: autostart,
        click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, openAsHidden: true }),
      },
      {
        label: "Adresse ändern …",
        click: () => {
          zeigeHaupt();
          void haupt?.loadFile(path.join(__dirname, "einrichten.html"));
        },
      },
      { type: "separator" },
      {
        label: "Beenden",
        click: () => {
          beenden = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", zeigeHaupt);
}

// ------------------------------------------------------------- Einrichtung

ipcMain.handle("adresse", (e, roh) => {
  if (e.sender !== haupt?.webContents) return { ok: false, grund: "Nur aus Kuro OS." };
  let url;
  try {
    url = new URL(String(roh).trim());
  } catch {
    return { ok: false, grund: "Das ist keine Adresse. Beispiel: https://kuronami.example.org" };
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    return {
      ok: false,
      grund: "Bitte eine https-Adresse — die Anmeldung geht sonst offen durchs Netz.",
    };
  }
  konfig = { ...konfig, adresse: url.origin };
  schreibeKonfig(konfig);
  void haupt?.loadURL(osAdresse());
  if (begleiter) void begleiter.loadURL(begleiterAdresse());
  else erstelleBegleiter();
  aktualisiereBegleiter();
  return { ok: true };
});

ipcMain.handle("adresse-lesen", () => konfig.adresse);

// ------------------------------------------------------------------- Start

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", zeigeHaupt);

  void app.whenReady().then(async () => {
    konfig = liesKonfig();
    // Mikrofon und Mitteilungen nur für Kuronamis eigene Adresse.
    const darf = (permission, url) =>
      ["media", "notifications", "clipboard-sanitized-write"].includes(permission) &&
      (gleicherUrsprung(url) || url.startsWith("file:"));
    session.defaultSession.setPermissionRequestHandler((wc, permission, antwort, details) =>
      antwort(darf(permission, details.requestingUrl ?? wc.getURL())),
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
      darf(permission, origin),
    );
    if (MAC) await systemPreferences.askForMediaAccess("microphone").catch(() => false);

    erstelleHaupt();
    erstelleBegleiter();
    aktualisiereBegleiter();
    for (const art of ["display-added", "display-removed", "display-metrics-changed"]) {
      screen.on(art, holeAufSchirm);
    }
    baueTray();
    starteSprechtaste();
    // Kuro OS nach vorn holen, von überall: ⌥⌘K am Mac, Strg+Alt+K unter Windows.
    globalShortcut.register(MAC ? "Alt+Command+K" : "Control+Alt+K", () => {
      zeigeHaupt();
      haupt?.webContents.send("insel-oeffnen");
    });
  });

  app.on("activate", zeigeHaupt);
  app.on("before-quit", () => {
    beenden = true;
  });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    stoppeSprechtaste();
  });
  // Fenster zu heißt nicht App zu: Tray und Sprechtaste bleiben.
  app.on("window-all-closed", () => {});
}

// Für die Probe unter xvfb (`probe-begleiter.cjs`).
module.exports = {
  meldeSprechtaste,
  setzeBegleiterAn,
  begleiterInnen: () => ({ flaechen, durchklick, aufbau: aufbauJetzt }),
};
