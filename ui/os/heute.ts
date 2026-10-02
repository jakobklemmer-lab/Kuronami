import type { CalendarData, MailData } from "../integrations/types.js";
import type { NachtbauStand } from "../views/system.js";
import { uhrzeit } from "../welle/form.js";

/**
 * „Heute" im Raum Kuro: je Quelle ein Satz, wie ein Butler ihn sagen würde. Rein, damit jede
 * Formulierung ohne Browser prüfbar ist; geladen und gezeichnet wird in `kuro-raum.ts`.
 */

export type HeuteQuelle = "kalender" | "post" | "nachtbau" | "abo";

/** Was `/integrations/abo` liefert — nur, was der Satz braucht. */
export type AboDaten =
  | {
      verfuegbar: true;
      fenster: Array<{ id: string; prozent: number; zurueck: string | null; warnung: boolean }>;
    }
  | { verfuegbar: false; grund: string };

export const KALENDER_FEHLT =
  "Kalender noch nicht verbunden — App-Passwort in der .env (KALENDER_USER/KALENDER_PASS).";

const ZAHLWORT = [
  "null",
  "ein",
  "zwei",
  "drei",
  "vier",
  "fünf",
  "sechs",
  "sieben",
  "acht",
  "neun",
  "zehn",
  "elf",
  "zwölf",
];

/** Bis zwölf ausgeschrieben, darüber Ziffern; `eins` ist die Form für die Eins („ein", „einer"). */
export function zahlwort(n: number, eins = "ein"): string {
  if (n === 1) return eins;
  return ZAHLWORT[n] ?? String(n);
}

const gross = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const prozent = (p: number) => `${Math.round(p)} %`;

/** Aufzählung mit „und" vor dem letzten Glied. */
export function aufzaehlung(teile: readonly string[]): string {
  if (teile.length <= 1) return teile[0] ?? "";
  return `${teile.slice(0, -1).join(", ")} und ${teile.at(-1)}`;
}

/** „heute um 14:00", „gestern um 18:20", „morgen um 00:30", sonst „am 5. Oktober". */
export function tagUndZeit(d: Date, jetzt: Date): string {
  const tage = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate()).getTime()) /
      86_400_000,
  );
  const tag = tage === 0 ? "heute" : tage === -1 ? "gestern" : tage === 1 ? "morgen" : null;
  if (tag) return `${tag} um ${uhrzeit(d)}`;
  return `am ${d.toLocaleDateString("de-DE", { day: "numeric", month: "long" })}`;
}

/** „gerade eben", „vor einer Minute", „vor 3 Stunden", danach mit Tag und Uhrzeit. */
export function vorZeit(iso: string, jetzt: Date): string {
  const d = new Date(iso);
  const minuten = Math.floor((jetzt.getTime() - d.getTime()) / 60_000);
  if (Number.isNaN(minuten)) return "";
  if (minuten < 1) return "gerade eben";
  if (minuten < 60) return minuten === 1 ? "vor einer Minute" : `vor ${minuten} Minuten`;
  const stunden = Math.floor(minuten / 60);
  if (stunden < 12) return stunden === 1 ? "vor einer Stunde" : `vor ${stunden} Stunden`;
  return tagUndZeit(d, jetzt);
}

/** Ohne Zugang meldet der Gateway den fehlenden Eintrag in der .env, sonst den Fehler von CalDAV. */
function kalenderFehlt(k: CalendarData): boolean {
  return k.reason === null || k.reason.includes("KALENDER_USER");
}

export function kalenderSatz(k: CalendarData, jetzt: Date): string {
  if (!k.connected) {
    return kalenderFehlt(k) ? KALENDER_FEHLT : `Der Kalender antwortet nicht: ${k.reason}`;
  }
  const termine = [...k.events].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  if (termine.length === 0) return "Heute stehen keine Termine an.";
  const n = termine.length;
  const kopf = `${gross(zahlwort(n))} ${n === 1 ? "Termin" : "Termine"} heute`;
  const t = jetzt.getTime();
  const mitZeit = termine.filter((e) => !e.allDay);
  const laufend = mitZeit.find(
    (e) => new Date(e.startsAt).getTime() <= t && t < new Date(e.endsAt).getTime(),
  );
  const naechster = mitZeit.find((e) => new Date(e.startsAt).getTime() > t);
  const um = (e: { startsAt: string; title: string }) =>
    `um ${uhrzeit(new Date(e.startsAt))} — ${e.title}`;
  if (laufend) {
    const jetztSatz = `gerade ${laufend.title}, bis ${uhrzeit(new Date(laufend.endsAt))}`;
    return naechster ? `${kopf}: ${jetztSatz}; danach ${um(naechster)}.` : `${kopf}: ${jetztSatz}.`;
  }
  if (naechster) {
    return n === 1 ? `${kopf}, ${um(naechster)}.` : `${kopf}, der nächste ${um(naechster)}.`;
  }
  const ganztags = termine.filter((e) => e.allDay);
  if (ganztags.length === n) {
    return n === 1
      ? `Heute ganztägig: ${ganztags[0]?.title}.`
      : `${kopf}, alle ganztägig: ${aufzaehlung(ganztags.map((e) => e.title))}.`;
  }
  return n === 1 ? `${kopf}, schon vorbei.` : `${kopf}, alle schon vorbei.`;
}

/**
 * Der Gateway zählt die Ungelesenen unter den jüngsten Briefen, die er abruft (heute 30) —
 * darum nennt der Satz diese Grenze, statt eine Gesamtzahl zu behaupten.
 */
export function postSatz(m: MailData, jetzt: Date): string {
  const alle = m.messages.length;
  if (alle === 0) return "Im Postfach liegt nichts.";
  const ungelesen = m.messages.filter((b) => b.unread);
  const u = ungelesen.length;
  const letzte = alle === 1 ? "der letzte Brief" : `die letzten ${zahlwort(alle)} Briefe`;
  if (u === 0) return `${gross(letzte)} ${alle === 1 ? "ist" : "sind"} gelesen.`;
  const juengster = ungelesen
    .map((b) => b.receivedAt)
    .sort()
    .at(-1);
  const zeit = juengster ? vorZeit(juengster, jetzt) : "";
  if (u === alle) {
    const satz = alle === 1 ? "Der letzte Brief ist ungelesen" : `${gross(letzte)} sind ungelesen`;
    return zeit ? `${satz}, der jüngste kam ${zeit}.` : `${satz}.`;
  }
  const satz =
    u === 1
      ? `Einer der letzten ${zahlwort(alle)} Briefe ist ungelesen`
      : `${gross(zahlwort(u))} der letzten ${zahlwort(alle)} Briefe sind ungelesen`;
  if (!zeit) return `${satz}.`;
  return u === 1 ? `${satz}, er kam ${zeit}.` : `${satz}, der jüngste kam ${zeit}.`;
}

function ortsdatum(d: Date): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Die Aufgaben aus `bau/PLAN.md`, die am Tag von `jetzt` erledigt wurden — die Nacht davor. */
export function erledigtDieseNacht(s: NachtbauStand, jetzt: Date): string[] {
  const tag = ortsdatum(jetzt);
  return s.aufgaben
    .filter((a) => /^erledigt \((\d{4}-\d{2}-\d{2})/.exec(a.status)?.[1] === tag)
    .map((a) => a.id);
}

function kurzeListe(ids: readonly string[]): string {
  if (ids.length <= 4) return aufzaehlung(ids);
  return `${ids.slice(0, 3).join(", ")} und ${ids.length - 3} weitere`;
}

export function nachtbauSatz(s: NachtbauStand, jetzt: Date): string {
  const zeilen = s.protokoll?.zeilen ?? [];
  const erledigt = erledigtDieseNacht(s, jetzt);
  if (s.dienst === "active" || s.dienst === "activating") {
    const wartet = /warte bis (\d{1,2}:\d{2})/.exec(zeilen.at(-1) ?? "");
    if (wartet) return `Der Nachtbau wartet bis ${wartet[1]} auf das nächste Sitzungsfenster.`;
    const an = [...zeilen]
      .reverse()
      .map((z) => /---\s+(N\d+[a-z]*)\b.*\bbeginnt\b/.exec(z)?.[1])
      .find(Boolean);
    const titel = s.aufgaben.find((a) => a.id === an)?.titel;
    const woran = an ? ` an ${an}${titel ? ` — ${titel}` : ""}` : " gerade";
    const fertig = erledigt.length > 0 ? `; fertig sind ${kurzeListe(erledigt)}` : "";
    return `Der Nachtbau arbeitet${woran}${fertig}.`;
  }
  if (s.dienst === "failed") return "Der Nachtbau ist abgebrochen — das Protokoll steht im System.";
  if (erledigt.length > 0) return `Letzte Nacht erledigt: ${kurzeListe(erledigt)}.`;
  const start = s.naechsterStart ? new Date(s.naechsterStart) : null;
  return start && !Number.isNaN(start.getTime())
    ? `Der Nachtbau ruht; er beginnt ${tagUndZeit(start, jetzt)}.`
    : "Der Nachtbau ruht.";
}

export function aboSatz(a: AboDaten, jetzt: Date): { text: string; knapp: boolean } {
  if (!a.verfuegbar)
    return { text: `Der Stand des Abos ist nicht abrufbar: ${a.grund}`, knapp: false };
  const s = a.fenster.find((f) => f.id === "sitzung");
  const w = a.fenster.find((f) => f.id === "woche");
  if (!s && !w) return { text: "Das Abo nennt keine Grenzen.", knapp: false };
  const neu =
    s?.zurueck && new Date(s.zurueck).getTime() > jetzt.getTime()
      ? ` (neu um ${uhrzeit(new Date(s.zurueck))})`
      : "";
  const teile = [
    s ? `die Sitzung zu ${prozent(s.prozent)}${neu}` : "",
    w ? `die Woche zu ${prozent(w.prozent)}` : "",
  ].filter(Boolean);
  const knapp = [s, w].some((f) => f && (f.warnung || f.prozent >= 80));
  return { text: `Vom Abo ist ${aufzaehlung(teile)} verbraucht.`, knapp };
}
