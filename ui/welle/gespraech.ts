import type { ApiClient } from "../api/client.js";
import type { BusMessage, EventBusClient } from "../events/bus.js";
import type { MicStateStore } from "../mic/state.js";
import type { Zustand } from "../praesenz/sphaere.js";
import { werName } from "./form.js";
import { TAFELN, type Tafel } from "./verlauf.js";
import * as V from "./verlauf.js";
import { type Lage, leiteZustandAb, werkzeugSatz } from "./zustand.js";

/**
 * Das Gespräch mit Kuro — die eine Stelle, an der die Welle mit dem Gateway spricht.
 *
 * Es lebt so lange wie die Oberfläche, nicht wie eine Ansicht: eine Frage, die in „Kuro" gestellt
 * wurde, läuft weiter, während Jakob in die Märkte wechselt, und ihre Antwort erscheint dort im
 * Blatt über der Eingabe. Die Präsenz hatte das alles in ihrer Ansicht und verlor es beim
 * Wechseln — samt einer halben Antwort.
 *
 * Hier kommt zusammen, was die Präsenz auf ihre Ansicht verteilt hatte: der Ereignisstrom (die
 * Wortstücke, Werkzeuge, Bediensteten, Tafeln), der eigene Aufruf an `/channels/web/messages`,
 * die offenen Rückfragen und das Postfach für Nachträge. Heraus gehen Signale; wer zuhört
 * (Orb, Verlauf, Leiste, Blatt), zeichnet selbst.
 */

export interface Arbeit {
  seit: number;
  stand: string;
  auftrag: string | null;
}

/** Was im Haus geschah, seit die Welle offen ist — für „Im Haus" in „Dein Tag". */
export interface Chronik {
  zeit: number;
  wer: string;
  text: string;
}

export type Signal =
  | { art: "verlauf" }
  | { art: "zustand" }
  | { art: "arbeit" }
  | { art: "impuls"; staerke: number }
  | { art: "fertig" }
  | { art: "bediensteter"; was: "beginnt" | "stand" | "fertig"; wer: string; text: string };

export interface Gespraech {
  readonly verlauf: V.Verlauf;
  readonly zustand: Zustand;
  /** Was Kuro gerade tut, ein kurzer Satz — oder null. */
  readonly detail: string | null;
  readonly arbeit: ReadonlyMap<string, Arbeit>;
  readonly chronik: readonly Chronik[];
  readonly unterwegs: boolean;
  sende(text: string): Promise<void>;
  /** Was Jakob ins Mikrofon gesagt hat — es steht als seine Frage im Verlauf. */
  gesprochen(text: string): void;
  /** Eine Antwort, die außerhalb des Stroms ankam (Sprachschicht). */
  nachtrag(text: string): void;
  antworte(askId: string, option: V.Option): Promise<void>;
  /** Leert nur, was hier angezeigt wird. Kuros Sitzung beim Gateway bleibt, wie sie ist. */
  leere(): void;
  abonniere(fn: (signal: Signal) => void): () => void;
  destroy(): void;
}

export interface GespraechsOptionen {
  api: ApiClient;
  bus: EventBusClient;
  mic: MicStateStore;
  /** Wo der Verlauf ein Neuladen übersteht. `null`: nirgends. */
  speicher: Storage | null;
}

interface NachrichtAntwort {
  status?: string;
  reason?: string;
  delivered?: Array<{ kind: string; text?: string }>;
}
interface OffeneAntwort {
  pending?: V.OffeneFrage[];
}
interface GespraecheAntwort {
  /** Kuros laufende Sitzung; `null`, wenn seit dem letzten Archivieren keine begann. */
  lage?: { seit: string | null } | null;
}
interface PostfachAntwort {
  deliveries?: Array<{ message: { kind: string; text?: string } }>;
}

const SPEICHER_SCHLUESSEL = "kuronami.welle.verlauf";
const FEHLER_STEHT_MS = 4000;
/** Uhr der Seite gegen Uhr des Gateways, und Jakobs erste Frage steht vor Kuros erster Zeile. */
const SITZUNG_SPIELRAUM_MS = 2 * 60_000;
const OFFLINE_NACH_MS = 4000;

const KANAL: Record<string, string> = {
  voice: "gesprochen",
  telegram: "über Telegram",
  slack: "über Slack",
  heartbeat: "von selbst",
};

export function oeffneGespraech(opt: GespraechsOptionen): Gespraech {
  let zaehler = 0;
  const umgebung = (): V.Umgebung => ({
    jetzt: Date.now(),
    id: () => `w${Date.now().toString(36)}${(zaehler++).toString(36)}`,
  });

  let verlauf = V.lade(lies());
  let zustand: Zustand = "ruhe";
  let detail: string | null = null;
  let fehlertext: string | null = null;
  const arbeit = new Map<string, Arbeit>();
  const chronik: Chronik[] = [];
  const hoerer = new Set<(s: Signal) => void>();
  const lage: Lage = {
    unterwegs: false,
    zugLaeuft: false,
    letztesStueck: null,
    werkzeug: null,
    rueckfrage: V.wartetAufJakob(verlauf),
    fehlerBis: 0,
    offline: false,
    mikrofon: opt.mic.state === "listening",
  };
  let weg = false;

  function lies(): string | null {
    try {
      return opt.speicher?.getItem(SPEICHER_SCHLUESSEL) ?? null;
    } catch {
      return null;
    }
  }
  const melde = (s: Signal): void => {
    for (const fn of hoerer) fn(s);
  };
  const setze = (neu: V.Verlauf): void => {
    if (neu === verlauf) return;
    verlauf = neu;
    lage.rueckfrage = V.wartetAufJakob(verlauf);
    try {
      opt.speicher?.setItem(SPEICHER_SCHLUESSEL, V.speichere(verlauf));
    } catch {
      // Voller oder gesperrter Seitenspeicher: der Verlauf gilt dann nur bis zum Neuladen.
    }
    melde({ art: "verlauf" });
    neuerZustand();
  };

  const neuerZustand = (): void => {
    const jetzt = Date.now();
    const z = leiteZustandAb(lage, jetzt);
    let d: string | null = null;
    if (z === "fehler") d = fehlertext;
    else if (z === "arbeiten" && lage.werkzeug) d = werkzeugSatz(lage.werkzeug);
    else if (z === "rueckfrage") d = "Eine Frage wartet auf deine Antwort.";
    else if (arbeit.size > 0) {
      const namen = [...arbeit.keys()].map(werName);
      d = namen.length === 1 ? `${namen[0]} arbeitet` : `${namen.join(", ")} arbeiten`;
    }
    if (z === zustand && d === detail) return;
    zustand = z;
    detail = d;
    melde({ art: "zustand" });
  };
  // „Spricht" und „Fehler" laufen von selbst ab; ein Takt prüft das nach.
  const takt = globalThis.setInterval(neuerZustand, 400);

  const notiere = (wer: string, text: string): void => {
    chronik.unshift({ zeit: Date.now(), wer, text });
    chronik.length = Math.min(chronik.length, 40);
  };

  // ------------------------------------------------------------ Strom
  // Der Strom spielt beim Verbinden die letzten Ereignisse nach. Was vor dem Öffnen geschah,
  // gehört nicht in dieses Gespräch — sonst hingen alte Wortstücke mitten im Wort an.
  const geoeffnetUm = Date.now() - 1500;

  const busAbo = opt.bus.onMessage((m: BusMessage) => {
    const wann = Date.parse(m.timestamp);
    if (Number.isFinite(wann) && wann < geoeffnetUm) return;
    const d = (m.data ?? {}) as Record<string, unknown>;
    const text = (x: unknown): string => (typeof x === "string" ? x : "");

    switch (m.type) {
      case "gespraech.archiviert":
        // Kuro beginnt frisch — das alte Gespräch geht von der Startseite ins Archiv.
        setze(V.abSeit(verlauf, Date.now()));
        return;
      case "turn.started": {
        const zug = text(d.turn_id);
        lage.zugLaeuft = true;
        lage.werkzeug = null;
        // Ein Zug, der nicht von hier kam, sagt, woher er kam — und nimmt keiner Frage von hier
        // den Platz weg.
        const kanal = text(d.channel);
        const nachtrag = text(d.external_id).startsWith("nachtrag_");
        const herkunft = nachtrag ? "nachgereicht" : (KANAL[kanal] ?? null);
        const quelle = kanal ? { kanal, nachtrag } : null;
        if (zug) setze(V.zugBeginnt(verlauf, zug, umgebung(), herkunft, quelle));
        neuerZustand();
        return;
      }
      case "model.delta": {
        const inhalt = (d.payload ?? d) as Record<string, unknown>;
        const stueck = text(inhalt.text);
        if (!stueck) return;
        lage.letztesStueck = Date.now();
        lage.werkzeug = null;
        setze(V.stueck(verlauf, text(inhalt.turn_id) || null, stueck, umgebung()));
        melde({ art: "impuls", staerke: Math.min(1, stueck.length / 14) });
        neuerZustand();
        return;
      }
      case "turn.completed": {
        const zug = text(d.turn_id);
        lage.zugLaeuft = false;
        lage.werkzeug = null;
        if (d.status === "failed") {
          const grund = text(d.reason) || "Der Zug ist gescheitert.";
          fehlertext = grund;
          lage.fehlerBis = Date.now() + FEHLER_STEHT_MS;
          if (zug) setze(V.zugEndet(verlauf, zug, "", umgebung()));
          setze(V.scheitert(verlauf, `Das ist misslungen: ${grund}`, umgebung()));
        } else if (zug) {
          setze(V.zugEndet(verlauf, zug, text(d.text), umgebung()));
        }
        melde({ art: "fertig" });
        neuerZustand();
        return;
      }
      case "kuro.werkzeug": {
        lage.werkzeug = text(d.name) || null;
        neuerZustand();
        return;
      }
      case "haus.arbeitet": {
        const wer = text(d.wer);
        if (!wer) return;
        const auftrag = text(d.auftrag) || null;
        arbeit.set(wer, { seit: Date.now(), stand: "übernimmt", auftrag });
        notiere(wer, auftrag ? `übernimmt: ${auftrag}` : "übernimmt einen Auftrag");
        melde({ art: "bediensteter", was: "beginnt", wer, text: auftrag ?? "" });
        melde({ art: "arbeit" });
        neuerZustand();
        return;
      }
      case "haus.fortschritt": {
        const wer = text(d.wer);
        if (!wer) return;
        const wobei = text(d.wobei);
        const stand = wobei ? `${wobei}: ${text(d.text)}` : text(d.text);
        const vorher = arbeit.get(wer);
        arbeit.set(wer, {
          seit: vorher?.seit ?? Date.now(),
          stand,
          auftrag: vorher?.auftrag ?? null,
        });
        melde({ art: "bediensteter", was: "stand", wer, text: stand });
        melde({ art: "arbeit" });
        return;
      }
      case "haus.fertig": {
        const wer = text(d.wer);
        if (!wer) return;
        arbeit.delete(wer);
        const dauer = typeof d.dauerMs === "number" ? Math.round(d.dauerMs / 1000) : null;
        const kosten = typeof d.kostenUsd === "number" ? d.kostenUsd : null;
        notiere(
          wer,
          [
            "fertig",
            dauer !== null
              ? `nach ${dauer < 90 ? `${dauer} s` : `${Math.round(dauer / 60)} min`}`
              : "",
            kosten !== null
              ? `für ${kosten.toLocaleString("de-DE", { style: "currency", currency: "USD", maximumFractionDigits: 2 })}`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
        melde({ art: "bediensteter", was: "fertig", wer, text: "" });
        melde({ art: "arbeit" });
        neuerZustand();
        return;
      }
      case "alarm.ausgeloest": {
        notiere("Märkte", text(d.text));
        melde({ art: "arbeit" });
        return;
      }
      case "analyse.neu": {
        notiere("Analysen", `neu abgelegt: ${text(d.titel)}`);
        melde({ art: "arbeit" });
        return;
      }
      case "papier.ereignis": {
        notiere("Papierhandel", text(d.text));
        melde({ art: "arbeit" });
        return;
      }
      case "ui.zeige": {
        const t = text(d.tafel);
        if ((TAFELN as readonly string[]).includes(t))
          setze(V.tafel(verlauf, t as Tafel, umgebung()));
        return;
      }
      case "ui.verberge": {
        setze(V.tafelnWeg(verlauf));
        return;
      }
    }
  });

  // Offline erst nach einer Schonfrist: beim Öffnen ist der Strom einen Moment lang noch nicht
  // verbunden, und ein Orb, der dabei jedes Mal kurz erlischt, meldete einen Ausfall, den es
  // nicht gibt.
  let offlineUhr: ReturnType<typeof setTimeout> | null = null;
  const beiStatus = (status: string): void => {
    if (status === "open") {
      if (offlineUhr !== null) globalThis.clearTimeout(offlineUhr);
      offlineUhr = null;
      if (lage.offline) {
        lage.offline = false;
        neuerZustand();
      }
      return;
    }
    if (lage.offline || offlineUhr !== null) return;
    offlineUhr = globalThis.setTimeout(() => {
      offlineUhr = null;
      lage.offline = true;
      neuerZustand();
    }, OFFLINE_NACH_MS);
  };
  const statusAbo = opt.bus.onStatus(beiStatus);
  beiStatus(opt.bus.status);

  const micAbo = opt.mic.subscribe((state) => {
    lage.mikrofon = state === "listening";
    neuerZustand();
  });

  // ------------------------------------------------------- Rückfragen
  const holeFragen = async (): Promise<void> => {
    try {
      const antwort = await opt.api.get<OffeneAntwort>("/channels/web/pending");
      if (weg) return;
      setze(V.gleicheFragenAb(verlauf, antwort.pending ?? [], umgebung()));
    } catch {
      // Kein Gateway oder keine Berechtigung — das sagt der Zustand „offline" bzw. die Tür.
    }
  };
  // Während eines eigenen Zugs oft (Kuro fragt vielleicht gleich), sonst selten: Rückfragen
  // kommen auch aus Hintergrundaufträgen, lange nach dem Zug, der sie auslöste.
  let fragenTakt = 0;
  const fragenUhr = globalThis.setInterval(() => {
    fragenTakt++;
    if (lage.unterwegs || lage.zugLaeuft || fragenTakt % 6 === 0) void holeFragen();
  }, 1500);
  void holeFragen();

  // Wurde Kuros Gespräch archiviert, während diese Seite zu war (nachts, oder auf einem anderen
  // Gerät), gehört der gespeicherte Verlauf zum alten. Maßgeblich ist, seit wann Kuros jetzige
  // Sitzung läuft; ohne Sitzung gehört nichts Fertiges mehr hierher.
  void opt.api
    .get<GespraecheAntwort>("/integrations/gespraeche")
    .then((a) => {
      if (weg || !a || !("lage" in a)) return;
      const seit = a.lage?.seit ? Date.parse(a.lage.seit) : Number.NaN;
      if (!a.lage) setze(V.abSeit(verlauf, Number.POSITIVE_INFINITY));
      else if (Number.isFinite(seit)) setze(V.abSeit(verlauf, seit - SITZUNG_SPIELRAUM_MS));
    })
    .catch(() => undefined);

  // --------------------------------------------------------- Postfach
  // Beim Öffnen liegen im Postfach des Web-Kanals oft Reste früherer Sitzungen. Die werden
  // einmal abgeholt und verworfen; erst was danach kommt, ist ein Nachtrag für dieses Gespräch.
  let postfachBereit = false;
  void opt.api
    .get<PostfachAntwort>("/channels/web/outbox")
    .catch(() => undefined)
    .finally(() => {
      postfachBereit = true;
    });
  const postfachUhr = globalThis.setInterval(async () => {
    if (!postfachBereit || lage.unterwegs) return;
    try {
      const p = await opt.api.get<PostfachAntwort>("/channels/web/outbox");
      for (const zustellung of p.deliveries ?? []) {
        if (zustellung.message.kind === "reply" && zustellung.message.text) {
          setze(V.nachtrag(verlauf, zustellung.message.text, umgebung()));
        }
      }
    } catch {
      // Kein Gateway — der Zustand sagt es.
    }
  }, 4000);

  // ------------------------------------------------------ Bedienstete
  // Ein Fenster, das mitten in einem Auftrag aufgeht, soll ihn sehen. Die Ereignisse davor hat
  // es verpasst — der Gateway weiß trotzdem, wer gerade arbeitet.
  void opt.api
    .get<{ laufende: Array<{ wer: string; stand: string; begonnen: number }> }>(
      "/integrations/haus",
    )
    .then(({ laufende }) => {
      if (weg) return;
      for (const l of laufende) {
        arbeit.set(l.wer, { seit: l.begonnen, stand: l.stand, auftrag: null });
        melde({ art: "bediensteter", was: "beginnt", wer: l.wer, text: "" });
        melde({ art: "bediensteter", was: "stand", wer: l.wer, text: l.stand });
      }
      if (laufende.length > 0) {
        melde({ art: "arbeit" });
        neuerZustand();
      }
    })
    .catch(() => undefined);

  return {
    get verlauf() {
      return verlauf;
    },
    get zustand() {
      return zustand;
    },
    get detail() {
      return detail;
    },
    get arbeit() {
      return arbeit;
    },
    get chronik() {
      return chronik;
    },
    get unterwegs() {
      return lage.unterwegs;
    },
    async sende(roh) {
      const text = roh.trim();
      if (!text || lage.unterwegs) return;
      lage.unterwegs = true;
      setze(V.frage(verlauf, text, umgebung()));
      neuerZustand();
      try {
        const antwort = await opt.api.post<NachrichtAntwort>("/channels/web/messages", {
          content: text,
        });
        const reply = antwort.delivered?.find((d) => d.kind === "reply")?.text;
        if (antwort.status === "failed") {
          const grund = antwort.reason ?? reply ?? "Der Zug ist gescheitert.";
          fehlertext = grund;
          lage.fehlerBis = Date.now() + FEHLER_STEHT_MS;
          // Den Text trägt der Strom meist schon; sonst kommt er hier.
          if (!V.letzteAntwort(verlauf)?.text)
            setze(V.scheitert(verlauf, reply ?? grund, umgebung()));
        } else if (reply) {
          setze(V.antwort(verlauf, reply, umgebung()));
        }
      } catch (error) {
        const meldung = error instanceof Error ? error.message : String(error);
        fehlertext = meldung;
        lage.fehlerBis = Date.now() + FEHLER_STEHT_MS;
        setze(V.scheitert(verlauf, meldung, umgebung()));
      } finally {
        lage.unterwegs = false;
        setze(V.abgeschlossen(verlauf));
        melde({ art: "fertig" });
        neuerZustand();
        void holeFragen();
      }
    },
    gesprochen(text) {
      const knapp = text.trim();
      if (!knapp) return;
      setze(V.frage(verlauf, knapp, umgebung(), true));
    },
    nachtrag(text) {
      setze(V.nachtrag(verlauf, text, umgebung()));
    },
    async antworte(askId, option) {
      setze(V.beantwortet(verlauf, askId, option.label));
      try {
        const antwort = await opt.api.post<NachrichtAntwort & PostfachAntwort>(
          "/channels/web/answers",
          { askId, choiceId: option.id },
        );
        for (const z of antwort.deliveries ?? []) {
          if (z.message.kind === "reply" && z.message.text) {
            setze(V.nachtrag(verlauf, z.message.text, umgebung()));
          }
        }
      } catch (error) {
        // Die Antwort kam nicht an — die Frage ist wieder offen, und der Grund steht darunter.
        const meldung = error instanceof Error ? error.message : String(error);
        setze({
          eintraege: verlauf.eintraege.map((e) =>
            e.rueckfrage?.askId === askId
              ? { ...e, rueckfrage: { ...e.rueckfrage, antwort: null } }
              : e,
          ),
        });
        setze(
          V.scheitert(
            verlauf,
            `Die Antwort „${option.label}" kam nicht an: ${meldung}`,
            umgebung(),
          ),
        );
      } finally {
        void holeFragen();
      }
    },
    leere() {
      setze(V.leer());
    },
    abonniere(fn) {
      hoerer.add(fn);
      return () => {
        hoerer.delete(fn);
      };
    },
    destroy() {
      weg = true;
      globalThis.clearInterval(takt);
      globalThis.clearInterval(fragenUhr);
      globalThis.clearInterval(postfachUhr);
      if (offlineUhr !== null) globalThis.clearTimeout(offlineUhr);
      busAbo();
      statusAbo();
      micAbo();
      hoerer.clear();
    },
  };
}
