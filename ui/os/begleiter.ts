import { createApiClient } from "../api/client.js";
import { resolveBackendOrigin } from "../backend-origin.js";
import { createEventBus } from "../events/bus.js";
import { createMicStateStore } from "../mic/state.js";
import type { Zustand } from "../praesenz/sphaere.js";
import { TOKEN_STORAGE_KEY, loadToken } from "../settings.js";
import { werName } from "../welle/form.js";
import { SPEICHER_SCHLUESSEL, oeffneGespraech } from "../welle/gespraech.js";
import * as V from "../welle/verlauf.js";
import { ZUSTAND_SATZ } from "../welle/zustand.js";
import { mountFigur } from "./figur.js";

/**
 * Der kleine Kuro als Seite: in der Desktop-App der Begleiter auf dem Schreibtisch, im Browser zum
 * Ansehen. `?vorschau` zeigt alle Zustände nebeneinander. Dateien, die man auf ihn zieht, schluckt
 * er — sie landen im Eingang des Brain.
 */

/** Was die Desktop-App dem Begleiter bereitstellt (`desktop/preload.cjs`); im Browser fehlt es. */
interface BegleiterDesktop {
  beiSprechtaste(rueckruf: (an: boolean) => void): void;
  beiBegleiterLage(
    rueckruf: (lage: {
      seite: "oben" | "unten";
      versatz: number;
      rand: "links" | "rechts" | null;
      offen: boolean;
    }) => void,
  ): void;
  beiZeiger(rueckruf: (x: number, y: number) => void): void;
  begleiterFlaechen(liste: Array<{ x: number; y: number; w: number; h: number }>): void;
  begleiterZiehen(phase: "start" | "zug" | "ende", x: number, y: number): void;
  begleiterBlase(offen: boolean): void;
  oeffneHaupt(): void;
}
const desktop = () =>
  (globalThis as { kuroDesktop?: Partial<BegleiterDesktop> }).kuroDesktop?.beiBegleiterLage
    ? ((globalThis as { kuroDesktop?: unknown }).kuroDesktop as BegleiterDesktop)
    : null;

/** Nach der Sprechtaste so lange: eine Antwort öffnet die Blase von selbst. */
const NACH_TASTE_MS = 3 * 60_000;
/** Eine Blase, die er von selbst geöffnet hat, schließt er wieder, wenn niemand hinsieht. */
const KURZ_OFFEN_MS = 12_000;
/** Ab so viel Bewegung ist ein Druck auf ihn Ziehen statt Klick. */
const ZIEH_SCHWELLE = 4;

/** Der Begleiter liest den Verlauf des Hauptfensters mit, schreibt ihn aber nie. */
function nurLesen(speicher: Storage | null): Storage | null {
  if (!speicher) return null;
  return {
    get length() {
      return speicher.length;
    },
    key: (i) => speicher.key(i),
    getItem: (k) => speicher.getItem(k),
    setItem() {},
    removeItem() {},
    clear() {},
  };
}

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
    <div class="b-buehne" data-role="buehne" data-seite="oben">
      <div class="b-blase" data-role="blase" hidden>
        <p class="b-zustand" data-role="zustand" hidden></p>
        <p class="b-antwort" data-role="antwort"></p>
        <form data-role="form"><input name="text" placeholder="Kuro fragen" autocomplete="off" /><button type="submit">Senden</button></form>
        <button type="button" class="b-oeffnen" data-role="oeffnen">Kuro OS öffnen</button>
      </div>
      <div class="b-figur" data-role="figur" title="Kuro"></div>
    </div>`;
  const q = <T extends Element>(r: string) => wurzel.querySelector<T>(`[data-role="${r}"]`) as T;
  const buehne = q<HTMLElement>("buehne");
  const figurEl = q<HTMLElement>("figur");
  const figur = mountFigur(figurEl);
  const blase = q<HTMLElement>("blase");
  const zustandEl = q<HTMLElement>("zustand");
  const antwort = q<HTMLElement>("antwort");
  const form = q<HTMLFormElement>("form");
  const feld = form.querySelector("input") as HTMLInputElement;
  const d = desktop();
  document.body.classList.toggle("ist-im-fenster", d !== null);

  // In der App kommt der Zeiger vom Schirm, damit er auch weit weg noch hinschaut.
  if (d) d.beiZeiger((x, y) => figur.schaue(x, y));
  else {
    document.addEventListener("pointermove", (e) => figur.schaue(e.clientX, e.clientY));
    document.addEventListener("pointerleave", () => figur.schaue(null, null));
  }

  // ------------------------------------------------------- Blase und Lage
  let offen = false;
  let fokusGewuenscht = false;
  let kurzUhr: ReturnType<typeof setTimeout> | null = null;

  /** Nur auf Figur und Blase nimmt das Fenster Klicks an; alles daneben geht durch. */
  const meldeFlaechen = () => {
    if (!d) return;
    requestAnimationFrame(() => {
      const f = figurEl.getBoundingClientRect();
      const liste = [
        {
          x: f.left + f.width * 0.14,
          y: f.top + f.height * 0.06,
          w: f.width * 0.72,
          h: f.height * 0.84,
        },
      ];
      if (offen) {
        const b = blase.getBoundingClientRect();
        liste.push({ x: b.left, y: b.top - 8, w: b.width, h: b.height + 16 });
      }
      d.begleiterFlaechen(liste);
    });
  };
  new ResizeObserver(meldeFlaechen).observe(blase);

  const zeigeOffen = (an: boolean) => {
    offen = an;
    blase.hidden = !an;
    if (an) figurEl.classList.remove("hat-neues");
    if (an && fokusGewuenscht) feld.focus();
    fokusGewuenscht = false;
    if (!an && kurzUhr) {
      globalThis.clearTimeout(kurzUhr);
      kurzUhr = null;
    }
    meldeFlaechen();
  };
  /** In der App entscheidet das Fenster (es holt ihn dafür vom Rand); im Browser die Seite. */
  const wuensche = (an: boolean, fokus = false) => {
    fokusGewuenscht = an && fokus;
    if (d) d.begleiterBlase(an);
    else zeigeOffen(an);
  };
  /** Von selbst geöffnet: nach einer Weile wieder zu, außer Jakob ist gerade dran. */
  const zeigeKurz = () => {
    wuensche(true);
    if (kurzUhr) globalThis.clearTimeout(kurzUhr);
    const pruefe = () => {
      if (blase.matches(":hover") || document.activeElement === feld) {
        kurzUhr = globalThis.setTimeout(pruefe, 3000);
      } else {
        kurzUhr = null;
        wuensche(false);
      }
    };
    kurzUhr = globalThis.setTimeout(pruefe, KURZ_OFFEN_MS);
  };
  d?.beiBegleiterLage((lage) => {
    buehne.dataset.seite = lage.seite;
    buehne.dataset.rand = lage.rand ?? "";
    buehne.style.setProperty("--versatz", `${lage.versatz}px`);
    zeigeOffen(lage.offen);
  });
  meldeFlaechen();

  const oeffneHaupt = () => {
    if (d) d.oeffneHaupt();
    else globalThis.open("/os/", "_blank");
  };
  q<HTMLButtonElement>("oeffnen").addEventListener("click", oeffneHaupt);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") wuensche(false);
  });

  // ------------------------------------------- Ziehen, Klick, Doppelklick
  // Ein Klick wartet kurz, ob ein zweiter folgt: sonst ginge die Blase auf und gleich wieder zu.
  let griff: { x: number; y: number } | null = null;
  let zieht = false;
  let gezogen = false;
  let klickUhr: ReturnType<typeof setTimeout> | null = null;
  figurEl.addEventListener("pointerdown", (e) => {
    gezogen = false;
    if (!d || e.button !== 0) return;
    griff = { x: e.screenX, y: e.screenY };
    figurEl.setPointerCapture(e.pointerId);
  });
  figurEl.addEventListener("pointermove", (e) => {
    if (!d || !griff) return;
    if (!zieht && Math.hypot(e.screenX - griff.x, e.screenY - griff.y) < ZIEH_SCHWELLE) return;
    if (!zieht) {
      zieht = true;
      figurEl.classList.add("ist-gezogen");
      d.begleiterZiehen("start", griff.x, griff.y);
    }
    d.begleiterZiehen("zug", e.screenX, e.screenY);
  });
  const lass = (e: PointerEvent) => {
    if (!griff) return;
    if (zieht) {
      d?.begleiterZiehen("ende", e.screenX, e.screenY);
      gezogen = true;
      figurEl.classList.remove("ist-gezogen");
    }
    griff = null;
    zieht = false;
  };
  figurEl.addEventListener("pointerup", lass);
  figurEl.addEventListener("pointercancel", lass);
  figurEl.addEventListener("lostpointercapture", lass);
  figurEl.addEventListener("click", () => {
    if (gezogen || klickUhr) return;
    klickUhr = globalThis.setTimeout(() => {
      klickUhr = null;
      wuensche(!offen, true);
    }, 240);
  });
  figurEl.addEventListener("dblclick", () => {
    if (klickUhr) globalThis.clearTimeout(klickUhr);
    klickUhr = null;
    oeffneHaupt();
  });

  // ------------------------------------------------------------ Gespräch
  const backend = resolveBackendOrigin(
    globalThis.location.hostname || "localhost",
    globalThis.location.protocol === "https:",
    null,
  );
  // Meldet sich Kuro OS an oder ab, fängt der Begleiter mit dem neuen Schlüssel von vorn an.
  globalThis.addEventListener("storage", (e) => {
    if (e.key === TOKEN_STORAGE_KEY) globalThis.location.reload();
  });
  if (loadToken() === null) {
    figur.setzeZustand("offline");
    antwort.textContent = "Bitte zuerst Kuro OS öffnen und anmelden.";
    return;
  }
  const speicher = (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })();
  const api = createApiClient({ baseUrl: backend.http, token: () => loadToken() });
  const bus = createEventBus({ url: backend.ws });
  const gespraech = oeffneGespraech({
    api,
    bus,
    mic: createMicStateStore(),
    speicher: nurLesen(speicher),
    postfach: false,
  });

  let gehalten = false;
  let tasteLos = 0;
  const zeigeZustand = () => {
    const z = gehalten ? "zuhoeren" : gespraech.zustand;
    figur.setzeZustand(z);
    zustandEl.textContent = gespraech.detail ?? ZUSTAND_SATZ[z];
    zustandEl.hidden = z === "ruhe";
  };
  d?.beiSprechtaste((an) => {
    if (gehalten && !an) tasteLos = Date.now();
    gehalten = an;
    zeigeZustand();
  });

  /** Die neueste Antwort — aus diesem Gespräch oder dem, was das Hauptfenster gespeichert hat. */
  const zeigeAntwort = () => {
    let letzte = V.letzteAntwort(gespraech.verlauf);
    try {
      const dort = V.letzteAntwort(V.lade(speicher?.getItem(SPEICHER_SCHLUESSEL) ?? null));
      if (dort && (!letzte || dort.zeit > letzte.zeit)) letzte = dort;
    } catch {
      // Ohne lesbaren Speicher zählt nur dieses Gespräch.
    }
    antwort.textContent = letzte?.text?.trim() || ZUSTAND_SATZ[gespraech.zustand];
  };
  globalThis.addEventListener("storage", (e) => {
    if (e.key === SPEICHER_SCHLUESSEL) zeigeAntwort();
  });

  zeigeZustand();
  for (const wer of gespraech.arbeit.keys()) figur.bediensteterBeginnt(werName(wer));
  gespraech.abonniere((s) => {
    if (s.art === "zustand") zeigeZustand();
    if (s.art === "bediensteter") {
      if (s.was === "beginnt") figur.bediensteterBeginnt(werName(s.wer));
      if (s.was === "fertig") figur.bediensteterFertig(werName(s.wer));
    }
    if (s.art === "verlauf") zeigeAntwort();
    if (s.art === "fertig") {
      zeigeAntwort();
      // Hinter Kuro OS hat Jakob die Antwort schon gesehen.
      if (offen || document.visibilityState !== "visible") return;
      if (Date.now() - tasteLos < NACH_TASTE_MS) zeigeKurz();
      else figurEl.classList.add("hat-neues");
    }
  });
  zeigeAntwort();
  bus.connect();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = feld.value.trim();
    if (!text) return;
    feld.value = "";
    void gespraech.sende(text);
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
      zeigeKurz();
    })();
  });
}

if (new URLSearchParams(globalThis.location.search).has("vorschau")) vorschau();
else begleiter();
