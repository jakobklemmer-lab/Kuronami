import { createApiClient } from "../api/client.js";
import { resolveBackendOrigin } from "../backend-origin.js";
import { createEventBus } from "../events/bus.js";
import { createMicStateStore } from "../mic/state.js";
import type { Zustand } from "../praesenz/sphaere.js";
import { loadToken } from "../settings.js";
import { werName } from "../welle/form.js";
import { oeffneGespraech } from "../welle/gespraech.js";
import * as V from "../welle/verlauf.js";
import { ZUSTAND_SATZ } from "../welle/zustand.js";
import { mountFigur } from "./figur.js";

/**
 * Der kleine Kuro als Seite: in der Desktop-App der Begleiter auf dem Schreibtisch, im Browser zum
 * Ansehen. `?vorschau` zeigt alle Zustände nebeneinander. Dateien, die man auf ihn zieht, schluckt
 * er — sie landen im Eingang des Brain.
 */

/** Was die Desktop-App dem Begleiter bereitstellt (N19e); im Browser fehlt es. */
const desktop = () =>
  (globalThis as { kuroDesktop?: { begleiterKlick?(): void; oeffneHaupt?(): void } }).kuroDesktop;

const wurzel = document.getElementById("begleiter") as HTMLElement;

function vorschau() {
  document.body.classList.add("ist-vorschau");
  const zustaende: Array<[Zustand | "hunger" | "satelliten", string]> = [
    ["ruhe", "Ruhe"],
    ["zuhoeren", "Hört zu"],
    ["denken", "Denkt nach"],
    ["sprechen", "Antwortet"],
    ["arbeiten", "Arbeitet"],
    ["satelliten", "Bedienstete arbeiten"],
    ["rueckfrage", "Wartet auf Sie"],
    ["fehler", "Etwas ging schief"],
    ["offline", "Keine Verbindung"],
    ["hunger", "Datei darüber"],
  ];
  wurzel.innerHTML = `<div class="v-raster"><h1>Der kleine Kuro</h1><p>Jeder Zustand des Begleiters. Bewegen Sie die Maus — er schaut Ihnen nach. Ziehen Sie eine Datei auf die letzte Figur.</p></div>`;
  const raster = wurzel.querySelector(".v-raster") as HTMLElement;
  const figuren = zustaende.map(([z, name]) => {
    const zelle = document.createElement("div");
    zelle.className = "v-zelle";
    raster.append(zelle);
    const f = mountFigur(zelle);
    const unter = document.createElement("span");
    unter.textContent = name;
    zelle.append(unter);
    if (z === "hunger") f.hunger(true);
    else if (z === "satelliten") {
      f.setzeZustand("arbeiten");
      for (const n of ["Börse", "Recherche", "Werkstatt"]) f.bediensteterBeginnt(n);
    } else f.setzeZustand(z);
    return f;
  });
  document.addEventListener("pointermove", (e) => {
    for (const f of figuren) f.schaue(e.clientX, e.clientY);
  });
}

function begleiter() {
  wurzel.innerHTML = `
    <div class="b-buehne">
      <div class="b-blase" data-role="blase" hidden>
        <p data-role="antwort"></p>
        <form data-role="form"><input name="text" placeholder="Kuro fragen" autocomplete="off" /><button type="submit">Senden</button></form>
        <button type="button" class="b-oeffnen" data-role="oeffnen">Kuro OS öffnen</button>
      </div>
      <div class="b-figur" data-role="figur" title="Kuro"></div>
    </div>`;
  const q = <T extends Element>(r: string) => wurzel.querySelector<T>(`[data-role="${r}"]`) as T;
  const figur = mountFigur(q<HTMLElement>("figur"));
  const blase = q<HTMLElement>("blase");
  const antwort = q<HTMLElement>("antwort");
  const form = q<HTMLFormElement>("form");
  document.addEventListener("pointermove", (e) => figur.schaue(e.clientX, e.clientY));
  document.addEventListener("pointerleave", () => figur.schaue(null, null));

  const backend = resolveBackendOrigin(
    globalThis.location.hostname || "localhost",
    globalThis.location.protocol === "https:",
    null,
  );
  if (loadToken() === null) {
    figur.setzeZustand("offline");
    antwort.textContent = "Bitte zuerst Kuro OS öffnen und anmelden.";
    return;
  }
  const api = createApiClient({ baseUrl: backend.http, token: () => loadToken() });
  const bus = createEventBus({ url: backend.ws });
  const gespraech = oeffneGespraech({
    api,
    bus,
    mic: createMicStateStore(),
    speicher: (() => {
      try {
        return globalThis.localStorage ?? null;
      } catch {
        return null;
      }
    })(),
  });
  const zeigeAntwort = () => {
    const letzte = V.letzteAntwort(gespraech.verlauf);
    antwort.textContent = letzte?.text?.trim() || ZUSTAND_SATZ[gespraech.zustand];
  };
  figur.setzeZustand(gespraech.zustand);
  for (const wer of gespraech.arbeit.keys()) figur.bediensteterBeginnt(werName(wer));
  gespraech.abonniere((s) => {
    if (s.art === "zustand") figur.setzeZustand(gespraech.zustand);
    if (s.art === "bediensteter") {
      if (s.was === "beginnt") figur.bediensteterBeginnt(werName(s.wer));
      if (s.was === "fertig") figur.bediensteterFertig(werName(s.wer));
    }
    if (s.art === "fertig" || s.art === "verlauf") zeigeAntwort();
  });
  zeigeAntwort();
  bus.connect();

  q<HTMLElement>("figur").addEventListener("click", () => {
    blase.hidden = !blase.hidden;
    if (!blase.hidden) form.querySelector("input")?.focus();
    desktop()?.begleiterKlick?.();
  });
  q<HTMLElement>("figur").addEventListener("dblclick", () => {
    const d = desktop();
    if (d?.oeffneHaupt) d.oeffneHaupt();
    else globalThis.open("/os/", "_blank");
  });
  q<HTMLButtonElement>("oeffnen").addEventListener("click", () => {
    const d = desktop();
    if (d?.oeffneHaupt) d.oeffneHaupt();
    else globalThis.open("/os/", "_blank");
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const feld = form.querySelector("input") as HTMLInputElement;
    const text = feld.value.trim();
    if (!text) return;
    feld.value = "";
    void gespraech.sende(text);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") blase.hidden = true;
  });

  // Dateien schlucken: was man auf ihn zieht, landet im Eingang des Brain.
  let ueber = 0;
  const hatDateien = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hatDateien(e)) return;
    ueber += 1;
    figur.hunger(true);
  });
  document.addEventListener("dragleave", (e) => {
    if (!hatDateien(e)) return;
    ueber = Math.max(0, ueber - 1);
    if (ueber === 0) figur.hunger(false);
  });
  document.addEventListener("dragover", (e) => {
    if (hatDateien(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!hatDateien(e)) return;
    e.preventDefault();
    ueber = 0;
    void (async () => {
      const namen: string[] = [];
      for (const datei of e.dataTransfer?.files ?? []) {
        if (datei.size > 20 * 1024 * 1024) {
          namen.push(`${datei.name} ist größer als 20 MB`);
          continue;
        }
        const inhalt = await new Promise<string>((fertig, fehler) => {
          const leser = new FileReader();
          leser.onload = () => fertig(String(leser.result).replace(/^data:[^,]*,/, ""));
          leser.onerror = () => fehler(leser.error);
          leser.readAsDataURL(datei);
        });
        try {
          const r = await api.post<{ pfad: string }>("/integrations/brain/eingang", {
            name: datei.name,
            inhalt,
          });
          namen.push(r.pfad.replace(/\.md$/, ""));
        } catch (fehler) {
          namen.push(`${datei.name}: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
        }
      }
      await figur.schlucke();
      antwort.textContent = `Aufgenommen und im Brain abgelegt:\n${namen.join("\n")}`;
      blase.hidden = false;
    })();
  });
}

if (new URLSearchParams(globalThis.location.search).has("vorschau")) vorschau();
else begleiter();
