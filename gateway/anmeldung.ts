import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Die Anmeldung der Oberfläche: **ein** Benutzer, ein Passwort, keine Registrierung.
 *
 * Bis hierher wies sich der Browser mit dem Betreiber-Token aus (`GATEWAY_WEB_TOKEN`, von Hand
 * in `localStorage` gelegt). Das reicht, solange niemand die Adresse kennt — die Oberfläche
 * steht aber unter einer öffentlichen URL, und Jakobs Satz dazu war: „damit nicht jeder, der
 * zufällig den Link hat, darauf zugreifen kann."
 *
 * **Warum kein Registrierungsweg existiert.** Es gibt genau einen Nutzer dieses Hauses. Eine
 * Registrierung wäre keine Funktion, sondern ein zweiter Eingang — und ein Eingang, den niemand
 * benutzt, wird auch von niemandem beobachtet. Wer einen zweiten Zugang braucht, legt ihn in der
 * `.env` an; das ist eine Handlung auf dem Server und damit eine Entscheidung, keine Anmeldemaske.
 *
 * **Warum das Passwort nur als Hash auf der Platte liegt.** `WEB_LOGIN_HASH` trägt scrypt mit
 * eigenem Salz. Wer die Datei liest, hat damit nicht das Passwort — und weil Jakob dasselbe
 * Passwort vielleicht anderswo benutzt, ist das der Unterschied, der zählt. Im Quelltext steht
 * es nirgends.
 *
 * **Warum die Sitzung signiert und nicht gespeichert ist.** Der Gateway startet bei jeder
 * Codeänderung neu. Eine Sitzungsliste im Arbeitsspeicher hieße: nach jedem Neustart wieder
 * anmelden. Ein signiertes Ticket übersteht den Neustart, kostet keine Tabelle — und wer den
 * Betreiber-Token wechselt, wirft damit alle Tickets um, weil er der Signierschlüssel ist.
 */

/** scrypt-Parameter. N=16384 kostet etwa 100 ms — für eine Anmeldung nichts, fürs Raten viel. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 32;

/** Wie lange ein Sitzungsticket gilt. 30 Tage: lang genug, um nicht zu nerven. */
export const SITZUNG_GUELTIG_MS = 30 * 24 * 60 * 60 * 1000;

/** `scrypt$N$r$p$salz$hash`, alles base64. Das Format steht mit in der Zeichenkette, damit ein
 * späterer Parameterwechsel alte Hashes nicht stillschweigend falsch prüft. */
export function hashePasswort(passwort: string, salz = randomBytes(16)): string {
  const hash = scryptSync(passwort, salz, SCRYPT_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salz.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/** Vergleich in konstanter Zeit; ein kaputter Hash ist „stimmt nicht", nie ein Absturz. */
export function pruefePasswort(passwort: string, gespeichert: string): boolean {
  const teile = gespeichert.split("$");
  if (teile.length !== 6 || teile[0] !== "scrypt") return false;
  const [, n, r, p, salzB64, hashB64] = teile;
  const salz = Buffer.from(salzB64, "base64");
  const erwartet = Buffer.from(hashB64, "base64");
  if (salz.length === 0 || erwartet.length === 0) return false;
  let gerechnet: Buffer;
  try {
    gerechnet = scryptSync(passwort, salz, erwartet.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return gerechnet.length === erwartet.length && timingSafeEqual(gerechnet, erwartet);
}

function base64url(daten: Buffer | string): string {
  return Buffer.from(daten)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signiere(nutzlast: string, schluessel: string): string {
  return base64url(createHmac("sha256", schluessel).update(nutzlast).digest());
}

/**
 * Ein Sitzungsticket: `v1.<nutzlast>.<signatur>`.
 *
 * Die Nutzlast ist lesbar (Benutzername und Ablauf) und das ist kein Mangel — sie ist kein
 * Geheimnis, sie ist eine Behauptung. Was sie trägt, ist die Signatur.
 */
export function baueTicket(
  benutzer: string,
  schluessel: string,
  jetzt = Date.now(),
  gueltigMs = SITZUNG_GUELTIG_MS,
): string {
  const nutzlast = base64url(JSON.stringify({ u: benutzer, exp: jetzt + gueltigMs }));
  return `v1.${nutzlast}.${signiere(nutzlast, schluessel)}`;
}

/** Der Benutzer hinter einem gültigen Ticket, sonst `null`. Abgelaufen zählt als ungültig. */
export function pruefeTicket(
  ticket: string,
  schluessel: string,
  jetzt = Date.now(),
): string | null {
  const teile = ticket.split(".");
  if (teile.length !== 3 || teile[0] !== "v1") return null;
  const [, nutzlast, signatur] = teile;
  const erwartet = signiere(nutzlast, schluessel);
  if (signatur.length !== erwartet.length) return null;
  if (!timingSafeEqual(Buffer.from(signatur), Buffer.from(erwartet))) return null;
  try {
    const daten = JSON.parse(Buffer.from(nutzlast, "base64url").toString("utf8")) as {
      u?: unknown;
      exp?: unknown;
    };
    if (typeof daten.u !== "string" || typeof daten.exp !== "number") return null;
    if (daten.exp <= jetzt) return null;
    return daten.u;
  } catch {
    return null;
  }
}

/**
 * Die Bremse gegen das Durchprobieren.
 *
 * Ein Passwort an einer öffentlichen Adresse wird irgendwann durchprobiert. Nach fünf
 * Fehlversuchen wird gesperrt, und die Sperre verdoppelt sich — eine Minute, zwei, vier, bis
 * fünfzehn. Gezählt wird je Herkunft **und** insgesamt: ein Botnetz mit tausend Adressen käme
 * sonst an einer Grenze vorbei, die nur die einzelne Adresse kennt.
 *
 * Ein erfolgreicher Versuch löscht den Zähler dieser Herkunft. Der gemeinsame Zähler bleibt
 * bestehen — er ist die Notbremse, nicht die Tür.
 */
export interface Bremse {
  /** `null` = frei. Sonst die Millisekunden, die der Aufrufer noch warten muss. */
  gesperrtFuer(herkunft: string, jetzt?: number): number | null;
  merkeFehlschlag(herkunft: string, jetzt?: number): void;
  merkeErfolg(herkunft: string): void;
}

const FREIVERSUCHE = 5;
const SPERRE_START_MS = 60_000;
const SPERRE_MAX_MS = 15 * 60_000;
/** Ab so vielen Fehlversuchen über alle Herkünfte hinweg gilt die gemeinsame Sperre. */
const GEMEINSAM_FREI = 25;

export function createBremse(): Bremse {
  const zaehler = new Map<string, { fehl: number; bis: number }>();
  let gemeinsam = { fehl: 0, bis: 0 };

  function sperreAus(fehl: number): number {
    if (fehl <= FREIVERSUCHE) return 0;
    return Math.min(SPERRE_MAX_MS, SPERRE_START_MS * 2 ** (fehl - FREIVERSUCHE - 1));
  }

  return {
    gesperrtFuer(herkunft, jetzt = Date.now()) {
      const eigen = zaehler.get(herkunft);
      const bis = Math.max(eigen?.bis ?? 0, gemeinsam.bis);
      return bis > jetzt ? bis - jetzt : null;
    },
    merkeFehlschlag(herkunft, jetzt = Date.now()) {
      const eigen = zaehler.get(herkunft) ?? { fehl: 0, bis: 0 };
      eigen.fehl += 1;
      eigen.bis = jetzt + sperreAus(eigen.fehl);
      zaehler.set(herkunft, eigen);

      gemeinsam.fehl += 1;
      if (gemeinsam.fehl > GEMEINSAM_FREI) {
        gemeinsam.bis = jetzt + Math.min(SPERRE_MAX_MS, SPERRE_START_MS);
      }
    },
    merkeErfolg(herkunft) {
      zaehler.delete(herkunft);
      gemeinsam = { fehl: 0, bis: 0 };
    },
  };
}

export interface Anmeldung {
  /** Der eine Benutzername. */
  benutzer: string;
  /** Prüft Benutzer und Passwort und gibt ein frisches Ticket zurück — oder `null`. */
  melde(benutzer: string, passwort: string, jetzt?: number): string | null;
  /** Der Benutzer hinter einem Ticket, sonst `null`. */
  ticketGilt(ticket: string, jetzt?: number): string | null;
  bremse: Bremse;
}

export interface AnmeldungDeps {
  benutzer: string;
  /** Das Ergebnis von `hashePasswort` aus der `.env`. */
  hash: string;
  /** Signierschlüssel der Tickets — der Betreiber-Token. Wechselt er, gelten alle Tickets nicht mehr. */
  schluessel: string;
  bremse?: Bremse;
}

export function createAnmeldung(deps: AnmeldungDeps): Anmeldung {
  const bremse = deps.bremse ?? createBremse();
  return {
    benutzer: deps.benutzer,
    bremse,
    melde(benutzer, passwort, jetzt = Date.now()) {
      // Erst den Namen, dann das Passwort — beides in konstanter Zeit, damit ein falscher
      // Name nicht schneller abgelehnt wird als ein falsches Passwort.
      const nameStimmt =
        benutzer.length === deps.benutzer.length &&
        timingSafeEqual(Buffer.from(benutzer), Buffer.from(deps.benutzer));
      const passwortStimmt = pruefePasswort(passwort, deps.hash);
      if (!nameStimmt || !passwortStimmt) return null;
      return baueTicket(deps.benutzer, deps.schluessel, jetzt);
    },
    ticketGilt(ticket, jetzt = Date.now()) {
      const benutzer = pruefeTicket(ticket, deps.schluessel, jetzt);
      return benutzer === deps.benutzer ? benutzer : null;
    },
  };
}

/**
 * Baut die Anmeldung aus der Umgebung — oder gibt `null` zurück, wenn sie nicht eingerichtet ist.
 *
 * Ohne `WEB_LOGIN_USER`/`WEB_LOGIN_HASH` bleibt es beim alten Weg (Betreiber-Token von Hand).
 * Das ist kein stilles Aufweichen: `GET /auth/lage` sagt der Oberfläche, woran sie ist, und die
 * Startmeldung des Gateways sagt es dem Betreiber.
 */
export function anmeldungAusUmgebung(
  env: NodeJS.ProcessEnv = process.env,
  schluessel = env.GATEWAY_WEB_TOKEN ?? "",
): Anmeldung | null {
  const benutzer = env.WEB_LOGIN_USER?.trim() ?? "";
  const hash = env.WEB_LOGIN_HASH?.trim() ?? "";
  if (benutzer === "" || hash === "" || schluessel === "") return null;
  return createAnmeldung({ benutzer, hash, schluessel });
}
