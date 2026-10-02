const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("insel", {
  beiLage(rueckruf) {
    ipcRenderer.on("lage", (_e, lage) => rueckruf(lage));
  },
  klick: () => ipcRenderer.send("insel-klick"),
});
