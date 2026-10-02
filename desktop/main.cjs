/**
 * Kuro OS als Desktop-App (2026-10-02). Die Oberfläche kommt vom Server (`/os/`), damit es
 * nur eine gibt; die App bringt, was ein Browser nicht kann: eine Sprechtaste, die auch wirkt,
 * wenn ein anderes Programm vorn ist, Kuros Insel über allen Fenstern, Tray und Autostart.
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

const MAC = process.platform === "darwin";
const BILD = (name) => path.join(__dirname, "bild", name);

// ------------------------------------------------------------------ Einstellungen

const KONFIG = () => path.join(app.getPath("userData"), "kuro-os.json");
const VORGABE = {
  adresse: null,
  // Rechte Wahltaste am Mac, rechte Strg-Taste unter Windows — beide tippen sonst kaum etwas.
  sprechtaste: MAC ? "AltRight" : "CtrlRight",
  sprechtasteAn: true,
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
let insel = null;
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
    backgroundColor: "#03080b",
    title: "Kuro OS",
    titleBarStyle: MAC ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 20, y: 18 },
    ...(MAC ? {} : { titleBarOverlay: { color: "#03080b", symbolColor: "#93a7b0", height: 52 } }),
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
  haupt.on("focus", () => aktualisiereInsel());
  haupt.on("blur", () => aktualisiereInsel());
  haupt.on("show", () => aktualisiereInsel());
  haupt.on("hide", () => aktualisiereInsel());
}

function zeigeHaupt() {
  if (!haupt) erstelleHaupt();
  if (haupt?.isMinimized()) haupt.restore();
  haupt?.show();
  haupt?.focus();
}

// --------------------------------------------------------------------- Insel

const INSEL_BREITE = 380;
const INSEL_HOCH_ZU = 40;
const INSEL_HOCH_AUF = 118;
const ANTWORT_STEHT_MS = 10_000;

let lage = { zustand: "ruhe", satz: "", farbe: "#6d90ff", text: null };
let antwortSeit = 0;
let gehalten = false;

function erstelleInsel() {
  insel = new BrowserWindow({
    width: INSEL_BREITE,
    height: INSEL_HOCH_ZU,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "insel-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  insel.setAlwaysOnTop(true, "screen-saver");
  insel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void insel.loadFile(path.join(__dirname, "insel.html"));
}

/**
 * Die Insel steht über anderen Programmen nur, wenn Kuro OS nicht vorn ist und es etwas zu sehen
 * gibt: Kuro arbeitet, die Sprechtaste ist gedrückt, oder eine Antwort ist gerade gekommen.
 */
function aktualisiereInsel() {
  if (!insel) return;
  const vorn = haupt?.isVisible() && haupt.isFocused();
  const neu = Date.now() - antwortSeit < ANTWORT_STEHT_MS;
  const zeigen = !vorn && (gehalten || lage.zustand !== "ruhe" || neu);
  if (!zeigen) {
    if (insel.isVisible()) insel.hide();
    return;
  }
  const { bounds } = screen.getPrimaryDisplay();
  const hoch = neu && lage.text ? INSEL_HOCH_AUF : INSEL_HOCH_ZU;
  insel.setBounds({
    x: Math.round(bounds.x + (bounds.width - INSEL_BREITE) / 2),
    y: bounds.y,
    width: INSEL_BREITE,
    height: hoch,
  });
  insel.webContents.send("lage", { ...lage, gehalten, neu });
  if (!insel.isVisible()) insel.showInactive();
}

ipcMain.on("zustand", (e, neueLage) => {
  if (e.sender !== haupt?.webContents) return;
  if (neueLage.text && neueLage.text !== lage.text && neueLage.zustand === "ruhe") {
    antwortSeit = Date.now();
    setTimeout(aktualisiereInsel, ANTWORT_STEHT_MS + 50);
  }
  lage = { ...lage, ...neueLage };
  aktualisiereInsel();
});

ipcMain.on("insel-klick", () => zeigeHaupt());

// ---------------------------------------------------------------- Sprechtaste

/**
 * Systemweit über uiohook: Electrons eigene Kürzel kennen kein Loslassen. Die Taste gilt erst
 * nach 180 ms ohne eine zweite — sonst wäre ⌥L (@) am Mac oder AltGr unter Windows Sprechen.
 * Solange sie gehalten ist, geht alle 300 ms „an" hinaus: so findet die Sprachsitzung, die der
 * erste Druck erst öffnet, den Zustand, sobald sie steht.
 */
let hook = null;
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
  const sende = (an) => {
    gehalten = an;
    haupt?.webContents.send("sprechtaste", an);
    aktualisiereInsel();
  };
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

ipcMain.handle("adresse", (_e, roh) => {
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
    erstelleInsel();
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
