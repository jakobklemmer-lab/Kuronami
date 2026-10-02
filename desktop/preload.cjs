/**
 * Die Brücke zwischen Kuro OS (der Seite vom Server) und der App: nur diese Handgriffe, kein
 * Node, kein Dateisystem. Rückrufe statt Ereignissen mit Nutzlast — ein `CustomEvent` aus dieser
 * isolierten Welt käme bei der Seite ohne `detail` an.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kuroDesktop", {
  plattform: process.platform,
  /** Die systemweite Sprechtaste: `true` gedrückt, `false` losgelassen. */
  beiSprechtaste(rueckruf) {
    ipcRenderer.on("sprechtaste", (_e, an) => rueckruf(an === true));
  },
  /** ⌥⌘K bzw. Strg+Alt+K: Kuro OS ist vorn, die Insel soll aufgehen. */
  beiInselOeffnen(rueckruf) {
    ipcRenderer.on("insel-oeffnen", () => rueckruf());
  },
  /** Kuros Zustand für die Insel über den anderen Programmen. */
  zustand(lage) {
    ipcRenderer.send("zustand", {
      zustand: String(lage?.zustand ?? "ruhe"),
      satz: String(lage?.satz ?? ""),
      farbe: String(lage?.farbe ?? ""),
      text: typeof lage?.text === "string" ? lage.text.slice(0, 600) : null,
    });
  },
  /** Nur für die Einrichtungsseite. */
  adresseSetzen: (url) => ipcRenderer.invoke("adresse", url),
  adresseLesen: () => ipcRenderer.invoke("adresse-lesen"),
});
