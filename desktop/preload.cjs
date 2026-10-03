/**
 * Die Brücke zwischen Kuro OS (der Seite vom Server) und der App: nur diese Handgriffe, kein
 * Node, kein Dateisystem. Rückrufe statt Ereignissen mit Nutzlast — ein `CustomEvent` aus dieser
 * isolierten Welt käme bei der Seite ohne `detail` an. Hauptfenster und Begleiter teilen sie; was
 * nur einem gehört, nimmt die App vom anderen nicht an.
 */
const { contextBridge, ipcRenderer } = require("electron");

const zahl = (w) => (Number.isFinite(w) ? Number(w) : 0);

contextBridge.exposeInMainWorld("kuroDesktop", {
  plattform: process.platform,
  /** Die systemweite Sprechtaste: `true` gedrückt, `false` losgelassen. */
  beiSprechtaste(rueckruf) {
    ipcRenderer.on("sprechtaste", (_e, an) => rueckruf(an === true));
  },
  /** ⌥⌘K bzw. Strg+Alt+K: Kuro OS ist vorn, Kuros Platz soll aufgehen. */
  beiInselOeffnen(rueckruf) {
    ipcRenderer.on("insel-oeffnen", () => rueckruf());
  },
  /** Nur für die Einrichtungsseite. */
  adresseSetzen: (url) => ipcRenderer.invoke("adresse", url),
  adresseLesen: () => ipcRenderer.invoke("adresse-lesen"),

  // Der Begleiter (`/os/begleiter/`).
  /** Wo im Fenster Figur und Blase stehen, ob er am Rand steckt, ob die Blase offen ist. */
  beiBegleiterLage(rueckruf) {
    ipcRenderer.on("begleiter-lage", (_e, lage) => rueckruf(lage));
  },
  /** Der Zeiger, im Fenster gerechnet — auch wenn er weit weg ist. */
  beiZeiger(rueckruf) {
    ipcRenderer.on("begleiter-zeiger", (_e, p) => rueckruf(zahl(p?.x), zahl(p?.y)));
  },
  /** Wo Figur und Blase liegen; nur dort nimmt das Fenster Klicks an. */
  begleiterFlaechen: (liste) =>
    ipcRenderer.send(
      "begleiter-flaechen",
      (Array.isArray(liste) ? liste : []).slice(0, 4).map((r) => ({
        x: zahl(r?.x),
        y: zahl(r?.y),
        w: zahl(r?.w),
        h: zahl(r?.h),
      })),
    ),
  /** Ziehen: `start`, `zug`, `ende` mit Bildschirmpunkten. */
  begleiterZiehen: (phase, x, y) =>
    ipcRenderer.send("begleiter-ziehen", String(phase), zahl(x), zahl(y)),
  begleiterBlase: (offen) => ipcRenderer.send("begleiter-blase", offen === true),
  oeffneHaupt: () => ipcRenderer.send("begleiter-haupt"),
});
