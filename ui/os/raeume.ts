/**
 * Die Räume von Kuro OS und ihre Teile (Konzept: bau/kuro-os-konzept.md), ohne DOM.
 * Adressen: `#/kuro`, `#/handel/strategien`, `#/brain/brain/<Notizpfad>`. ⌘/Strg + 1–5 wechselt.
 */

export const RAEUME = ["kuro", "handel", "brain", "post", "studium"] as const;
export type Raum = (typeof RAEUME)[number];

export const RAUM_NAME: Record<Raum, string> = {
  kuro: "Kuro",
  handel: "Handel",
  brain: "Brain",
  post: "Post",
  studium: "Studium",
};

export const TEILE = {
  kuro: [],
  handel: ["maerkte", "strategien", "analysen"],
  brain: ["brain"],
  post: ["post", "kalender"],
  studium: ["recherche"],
} as const satisfies Record<Raum, readonly string[]>;

export type Teil = (typeof TEILE)[keyof typeof TEILE][number];

export const TEIL_NAME: Record<Teil, string> = {
  maerkte: "Märkte",
  strategien: "Strategien",
  analysen: "Analysen",
  brain: "Brain",
  post: "Post",
  recherche: "Recherche",
  kalender: "Kalender",
};

export interface Ort {
  raum: Raum;
  teil: Teil | null;
  /** Nur im Brain: die offene Notiz. */
  notiz: string | null;
}

function istTeil(raum: Raum, teil: string | undefined): teil is Teil {
  return (TEILE[raum] as readonly string[]).includes(teil ?? "");
}

/** Liest die Adresse; ein fehlender Teil wird der zuletzt gewählte, sonst der erste. */
export function liesOrt(hash: string, zuletzt: Partial<Record<Raum, Teil>> = {}): Ort {
  const [kopf = "", teil, ...rest] = hash.replace(/^#\/?/, "").split("/");
  const raum = (RAEUME as readonly string[]).includes(kopf) ? (kopf as Raum) : "kuro";
  if (raum === "kuro") return { raum, teil: null, notiz: null };
  const t = istTeil(raum, teil) ? teil : (zuletzt[raum] ?? (TEILE[raum][0] as Teil));
  const notiz =
    t === "brain" && rest.length > 0 ? decodeURIComponent(rest.join("/")) || null : null;
  return { raum, teil: t, notiz: notiz?.endsWith(".md") ? notiz : null };
}

export function schreibeOrt(o: Ort): string {
  if (o.raum === "kuro" || !o.teil) return `#/${o.raum}`;
  const notiz =
    o.teil === "brain" && o.notiz
      ? `/${o.notiz
          .split("/")
          .map((t) => encodeURIComponent(t))
          .join("/")}`
      : "";
  return `#/${o.raum}/${o.teil}${notiz}`;
}

/** ⌘1 … ⌘5 in der Reihenfolge der Räume. */
export function raumFuerTaste(taste: string): Raum | null {
  const n = Number(taste);
  return Number.isInteger(n) && n >= 1 && n <= RAEUME.length ? RAEUME[n - 1] : null;
}

/** Wohin eine Fachansicht mit `navigate(route)` will. `null`: in das Blatt (System, Einstellungen). */
export function ortFuerRoute(route: string): Ort | "blatt-system" | "blatt-einstellungen" | null {
  const ziel: Record<string, Ort> = {
    praesenz: { raum: "kuro", teil: null, notiz: null },
    trading: { raum: "handel", teil: "maerkte", notiz: null },
    strategien: { raum: "handel", teil: "strategien", notiz: null },
    analysen: { raum: "handel", teil: "analysen", notiz: null },
    mail: { raum: "post", teil: "post", notiz: null },
    calendar: { raum: "post", teil: "kalender", notiz: null },
    research: { raum: "studium", teil: "recherche", notiz: null },
  };
  if (route === "system") return "blatt-system";
  if (route === "settings") return "blatt-einstellungen";
  return ziel[route] ?? null;
}

/** Der gemerkte Teil je Raum aus dem Seitenspeicher; Fremdes und Veraltetes fällt weg. */
export function liesGemerkt(json: string | null): Partial<Record<Raum, Teil>> {
  let roh: unknown;
  try {
    roh = JSON.parse(json ?? "{}");
  } catch {
    return {};
  }
  const gemerkt: Partial<Record<Raum, Teil>> = {};
  if (!roh || typeof roh !== "object") return gemerkt;
  for (const raum of RAEUME) {
    const teil = (roh as Record<string, unknown>)[raum];
    if (typeof teil === "string" && istTeil(raum, teil)) gemerkt[raum] = teil;
  }
  return gemerkt;
}

/** Wohin ein Wechsel gleitet: nach der Reihenfolge der Räume, im selben Raum nach den Teilen. */
export function richtung(von: Ort, nach: Ort): -1 | 0 | 1 {
  const r = RAEUME.indexOf(nach.raum) - RAEUME.indexOf(von.raum);
  if (r !== 0) return r > 0 ? 1 : -1;
  const teile = TEILE[nach.raum] as readonly string[];
  const t = teile.indexOf(nach.teil ?? "") - teile.indexOf(von.teil ?? "");
  return t > 0 ? 1 : t < 0 ? -1 : 0;
}
