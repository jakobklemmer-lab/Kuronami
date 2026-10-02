import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

/**
 * Die Postfächer — direkt über IMAP, ohne n8n dazwischen.
 *
 * Vorher lief Mail über n8n-Webhooks. Das war nicht nur eine Schicht zu viel, es lief auch
 * nicht: `mail-search` antwortete seit Tagen gar nicht, im Protokoll standen im Minutentakt
 * `N8nWebhookAbortedError`, und die Zugangsdaten für die fünf Konten waren nie eingetragen
 * worden. Eine Brücke über eine Brücke über ein Postfach, an dessen Ende kein Schlüssel steckt.
 *
 * Jetzt: IMAP und SMTP direkt. Ein Konto ist fünf Zeilen in der `.env`, ein Abruf dauert
 * Sekundenbruchteile statt in einen 30-Sekunden-Zeitüberlauf zu laufen.
 *
 * **Gelesen wird viel, geschrieben wenig.** Auflisten, lesen und einen Entwurf ablegen darf
 * die Korrespondenz allein. Verschicken darf sie nicht — dafür gibt es hier zwar einen Weg,
 * aber er liegt bei Kuro, und der fragt vorher (siehe `agent.ts`, `canUseTool`). Eine Mail,
 * die einmal draußen ist, holt niemand zurück.
 */

export interface Konto {
  /** Name, unter dem Jakob es kennt: „Privat", „Firma". */
  name: string;
  user: string;
  /** Passwort — nur bei Anbietern, die einfaches IMAP noch zulassen. */
  pass?: string;
  /**
   * Oder ein erteilter Google-Zugang.
   *
   * Der ist bei Gmail der einzige Weg: App-Passwörter sind für Jakobs Konten nicht einmal
   * anwählbar („die gesuchte Einstellung ist für Ihr Konto nicht verfügbar"), und Microsoft
   * hat einfaches IMAP ohnehin abgeschaltet. Der Zugang wird einmal im Browser erteilt
   * (`/postfach/verbinden`), danach erneuert sich die Freigabe von selbst.
   */
  erneuerung?: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

/** Die Anwendung, unter der Kuronami bei Google fragt. Einmal in der Cloud Console angelegt. */
export interface GoogleAnwendung {
  id: string;
  geheimnis: string;
}

export function googleAnwendung(env: NodeJS.ProcessEnv = process.env): GoogleAnwendung | null {
  const id = env.GOOGLE_CLIENT_ID?.trim();
  const geheimnis = env.GOOGLE_CLIENT_SECRET?.trim();
  return id && geheimnis ? { id, geheimnis } : null;
}

/**
 * Eine frische Zugangsfreigabe aus der gespeicherten Erneuerung.
 *
 * Google gibt Freigaben mit einer Stunde Gültigkeit aus; ein Butler, der stündlich den Dienst
 * einstellt, wäre keiner. Deshalb wird bei jedem Zugriff eine frische geholt — das dauert
 * Millisekunden und spart die gesamte Buchhaltung über Ablaufzeiten.
 */
export async function freigabe(app: GoogleAnwendung, erneuerung: string): Promise<string> {
  const antwort = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.id,
      client_secret: app.geheimnis,
      refresh_token: erneuerung,
      grant_type: "refresh_token",
    }),
  });
  if (antwort.status >= 500) {
    throw new Error(`Google antwortet gerade nicht (HTTP ${antwort.status}) — später noch einmal.`);
  }
  if (!antwort.ok) {
    throw new Error(
      `Google verweigert den Zugang (HTTP ${antwort.status}). Vermutlich wurde die Freigabe entzogen — dann hilft nur, das Konto unter /postfach/verbinden neu zu verbinden.`,
    );
  }
  const daten = (await antwort.json()) as { access_token?: string };
  if (!daten.access_token) throw new Error("Google antwortete ohne Zugang.");
  return daten.access_token;
}

/**
 * Konten aus der Umgebung lesen: `MAIL_1_NAME`, `MAIL_1_USER`, … durchnummeriert ab 1.
 *
 * Nummerierte Variablen statt einer JSON-Zeile, weil eine `.env` von Hand gepflegt wird und
 * ein verlorenes Komma in einem JSON-Blob eine unangenehme Fehlersuche ist.
 */
export function konten(env: NodeJS.ProcessEnv = process.env): Konto[] {
  const gefunden: Konto[] = [];
  for (let i = 1; i <= 20; i++) {
    const user = env[`MAIL_${i}_USER`]?.trim();
    const pass = env[`MAIL_${i}_PASS`]?.trim();
    const erneuerung = env[`MAIL_${i}_GOOGLE`]?.trim();
    // Eines von beidem genügt: ein Passwort oder ein erteilter Google-Zugang.
    if (!user || (!pass && !erneuerung)) continue;

    // Vorgabe Gmail: das ist der Fall, den Jakob fünfmal hat. Alles andere trägt er ein.
    const imap = (env[`MAIL_${i}_IMAP`]?.trim() || "imap.gmail.com:993").split(":");
    const smtp = (env[`MAIL_${i}_SMTP`]?.trim() || "smtp.gmail.com:465").split(":");

    gefunden.push({
      name: env[`MAIL_${i}_NAME`]?.trim() || user,
      user,
      ...(pass ? { pass } : {}),
      ...(erneuerung ? { erneuerung } : {}),
      imapHost: imap[0],
      imapPort: Number(imap[1] ?? 993),
      smtpHost: smtp[0],
      smtpPort: Number(smtp[1] ?? 465),
    });
  }
  return gefunden;
}

/** Eine Kopfzeile, wie sie in einer Übersicht steht. */
export interface Kopf {
  konto: string;
  uid: number;
  von: string;
  betreff: string;
  am: string;
  ungelesen: boolean;
  anriss: string;
}

function kontoFinden(alle: Konto[], name?: string): Konto[] {
  if (!name) return alle;
  const gesucht = name.trim().toLowerCase();
  const treffer = alle.filter(
    (k) => k.name.toLowerCase() === gesucht || k.user.toLowerCase() === gesucht,
  );
  return treffer.length > 0 ? treffer : alle;
}

/** Die Anmeldung für ein Konto: Passwort oder frisch geholte Google-Freigabe. */
async function anmeldung(
  konto: Konto,
): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (konto.erneuerung) {
    const app = googleAnwendung();
    if (!app) {
      throw new Error(
        `Für ${konto.name} liegt ein Google-Zugang vor, aber GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET fehlen in der Umgebung.`,
      );
    }
    return { user: konto.user, accessToken: await freigabe(app, konto.erneuerung) };
  }
  return { user: konto.user, pass: konto.pass };
}

async function mitVerbindung<T>(konto: Konto, was: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: konto.imapHost,
    port: konto.imapPort,
    secure: konto.imapPort === 993,
    auth: await anmeldung(konto),
    // Die Bibliothek redet sonst in jeden Aufruf hinein; das Protokoll gehört dem Gateway.
    logger: false,
  });
  // Ohne Zuhörer beendet ein Socket-Fehler den ganzen Gateway (zweimal geschehen, 28.09. und
  // 01.10.). Der laufende Befehl scheitert trotzdem und meldet sich über sein Promise.
  client.on("error", (fehler: Error) => {
    console.warn(`[postfach] ${konto.name}: ${fehler.message}`);
  });
  await client.connect();
  try {
    return await was(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export function begrenzeAnzahl(anzahl: number | undefined, vorgabe: number): number {
  return Math.min(Math.max(Math.trunc(anzahl ?? vorgabe), 1), 50);
}

/** Bei Gmail die ganze Gmail-Suche („from:tradinglab older_than:2y"), sonst Absender oder Betreff. */
export function suchKriterium(konto: Konto, abfrage: string): SearchObject {
  return konto.imapHost === "imap.gmail.com"
    ? { gmraw: abfrage }
    : { or: [{ from: abfrage }, { subject: abfrage }] };
}

type Abruf = {
  uid: number;
  flags?: Set<string>;
  envelope?: {
    from?: { name?: string; address?: string }[];
    subject?: string;
    date?: Date | string;
  };
};

function kopfAus(konto: Konto, nachricht: Abruf): Kopf {
  const umschlag = nachricht.envelope;
  return {
    konto: konto.name,
    uid: nachricht.uid,
    von: umschlag?.from?.map((a) => a.name || a.address || "").join(", ") || "(unbekannt)",
    betreff: umschlag?.subject || "(kein Betreff)",
    am: umschlag?.date ? new Date(umschlag.date).toISOString() : "",
    ungelesen: !nachricht.flags?.has("\\Seen"),
    anriss: "",
  };
}

/** Kopfzeilen zu UIDs, ohne etwas als gelesen zu markieren. */
async function koepfeZu(client: ImapFlow, konto: Konto, uids: number[]): Promise<Kopf[]> {
  if (uids.length === 0) return [];
  const koepfe: Kopf[] = [];
  for await (const nachricht of client.fetch(
    uids,
    { envelope: true, flags: true, bodyStructure: false, source: false },
    { uid: true },
  )) {
    koepfe.push(kopfAus(konto, nachricht));
  }
  return koepfe.sort((a, b) => a.uid - b.uid);
}

/**
 * Suchen statt blättern: `liste` sieht nur die neuesten Nachrichten, ein Newsletter von vor
 * Monaten blieb so unauffindbar. Nur lesen; Treffer neueste zuerst.
 */
export async function suche(
  alle: Konto[],
  opts: { konto?: string; abfrage: string; anzahl?: number },
): Promise<Kopf[]> {
  const anzahl = begrenzeAnzahl(opts.anzahl, 20);
  const jeKonto = await Promise.all(
    kontoFinden(alle, opts.konto).map((konto) =>
      mitVerbindung(konto, async (client) => {
        const schloss = await client.getMailboxLock("INBOX");
        try {
          const uids =
            (await client.search(suchKriterium(konto, opts.abfrage), { uid: true })) || [];
          return await koepfeZu(client, konto, uids.slice(-anzahl));
        } finally {
          schloss.release();
        }
      }),
    ),
  );
  return jeKonto
    .flat()
    .sort((a, b) => b.am.localeCompare(a.am))
    .slice(0, anzahl);
}

/**
 * Die letzten Nachrichten eines oder aller Postfächer.
 *
 * Absichtlich **nur Kopfzeilen plus Anriss**: eine Sichtung braucht keinen Volltext, und
 * zwanzig vollständige Mails im Kontext eines Bediensteten wären teurer als der ganze
 * Vorgang wert ist.
 */
export async function liste(
  alle: Konto[],
  opts: { konto?: string; anzahl?: number; nurUngelesen?: boolean; vor?: number } = {},
): Promise<Kopf[]> {
  const anzahl = begrenzeAnzahl(opts.anzahl, 15);

  // **Parallel, nicht nacheinander.** Jedes Konto kostet eine Google-Freigabe, einen
  // TLS-Aufbau, eine Anmeldung und eine Fetch-Runde — hintereinander summiert sich das über
  // drei Postfächer auf 4,5 s, nebeneinander bleibt es bei 1,8 s (gemessen 2026-09-20). Die
  // Verbindungen gehen an drei verschiedene Server und stehen sich nicht im Weg; was danach
  // kommt (Sortieren, Kappen) braucht die Reihenfolge ohnehin nicht.
  const jeKonto = await Promise.all(
    kontoFinden(alle, opts.konto).map((konto) =>
      mitVerbindung(konto, async (client) => {
        const schloss = await client.getMailboxLock("INBOX");
        try {
          const box = client.mailbox;
          const gesamt = typeof box === "object" && box ? box.exists : 0;
          if (!gesamt) return [];

          // Blättern: nur, was älter ist als die genannte Nummer.
          if (opts.vor !== undefined) {
            if (opts.vor <= 1) return [];
            const uids = (await client.search({ uid: `1:${opts.vor - 1}` }, { uid: true })) || [];
            const koepfe = await koepfeZu(client, konto, uids.slice(-anzahl * 3));
            return koepfe
              .filter((k) => !opts.nurUngelesen || k.ungelesen)
              .reverse()
              .slice(0, anzahl);
          }
          const von = Math.max(1, gesamt - anzahl * 3 + 1);
          const gesammelt: Kopf[] = [];
          for await (const nachricht of client.fetch(`${von}:*`, {
            envelope: true,
            flags: true,
            bodyStructure: false,
            source: false,
          })) {
            const kopf = kopfAus(konto, nachricht);
            if (opts.nurUngelesen && !kopf.ungelesen) continue;
            gesammelt.push(kopf);
          }
          return gesammelt.reverse().slice(0, anzahl);
        } finally {
          schloss.release();
        }
      }),
    ),
  );

  // Über alle Konten hinweg nach Zeit sortieren: Jakob hat ein Postfach im Kopf, nicht fünf.
  return jeKonto
    .flat()
    .sort((a, b) => b.am.localeCompare(a.am))
    .slice(0, anzahl);
}

/** Eine Nachricht im Volltext. */
export async function lies(
  alle: Konto[],
  kontoName: string,
  uid: number,
): Promise<{ von: string; an: string; betreff: string; am: string; text: string }> {
  const [konto] = kontoFinden(alle, kontoName);
  if (!konto) throw new Error(`Kein Postfach namens „${kontoName}".`);

  return mitVerbindung(konto, async (client) => {
    const schloss = await client.getMailboxLock("INBOX");
    try {
      const roh = await client.download(String(uid), undefined, { uid: true });
      if (!roh?.content) throw new Error(`Nachricht ${uid} nicht gefunden.`);
      const geparst = await simpleParser(roh.content);
      return {
        von: geparst.from?.text ?? "",
        an: Array.isArray(geparst.to)
          ? geparst.to.map((t) => t.text).join(", ")
          : (geparst.to?.text ?? ""),
        betreff: geparst.subject ?? "",
        am: geparst.date?.toISOString() ?? "",
        // Nur Text: HTML-Gerüst kostet Kontext und trägt selten etwas bei.
        text: (geparst.text ?? "").slice(0, 20_000),
      };
    } finally {
      schloss.release();
    }
  });
}

/** Einen Entwurf im Postfach ablegen. Verschickt nichts. */
export async function entwurf(
  alle: Konto[],
  kontoName: string,
  an: string,
  betreff: string,
  text: string,
): Promise<string> {
  const [konto] = kontoFinden(alle, kontoName);
  if (!konto) throw new Error(`Kein Postfach namens „${kontoName}".`);

  const roh = await nodemailer
    .createTransport({ streamTransport: true, newline: "unix" })
    .sendMail({ from: konto.user, to: an, subject: betreff, text });

  // `streamTransport` liefert je nach Aufbau einen Strom oder schon fertige Bytes.
  const quelle = roh.message;
  const bytes: Buffer = Buffer.isBuffer(quelle)
    ? quelle
    : await new Promise((resolve, reject) => {
        const teile: Buffer[] = [];
        quelle.on("data", (d: Buffer) => teile.push(d));
        quelle.on("end", () => resolve(Buffer.concat(teile)));
        quelle.on("error", reject);
      });

  return mitVerbindung(konto, async (client) => {
    // Gmail nennt den Ordner „[Gmail]/Entwürfe", andere schlicht „Drafts". Erst suchen,
    // dann ablegen — ein fest verdrahteter Name schlüge beim zweiten Anbieter fehl.
    const ordner = await client.list();
    const ziel =
      ordner.find((o) => o.specialUse === "\\Drafts")?.path ??
      ordner.find((o) => /entw|draft/i.test(o.path))?.path ??
      "Drafts";
    await client.append(ziel, bytes, ["\\Draft"]);
    return `Entwurf liegt in „${ziel}" von ${konto.name}.`;
  });
}

/** Verschickt eine Nachricht. Nur über Kuro, und der fragt vorher. */
export async function sende(
  alle: Konto[],
  kontoName: string,
  an: string,
  betreff: string,
  text: string,
): Promise<string> {
  const [konto] = kontoFinden(alle, kontoName);
  if (!konto) throw new Error(`Kein Postfach namens „${kontoName}".`);

  const zugang = await anmeldung(konto);
  await nodemailer
    .createTransport({
      host: konto.smtpHost,
      port: konto.smtpPort,
      secure: konto.smtpPort === 465,
      auth: zugang.accessToken
        ? { type: "OAuth2", user: konto.user, accessToken: zugang.accessToken }
        : { user: konto.user, pass: zugang.pass },
    })
    .sendMail({ from: konto.user, to: an, subject: betreff, text });

  return `Verschickt an ${an} über ${konto.name}.`;
}

// ---------------------------------------------------------------------------
// Zwischenspeicher
// ---------------------------------------------------------------------------

/**
 * Der Zwischenspeicher für Übersichten — und warum er niemanden warten lässt.
 *
 * Ohne ihn baut jeder Seitenaufruf für jedes Konto eine IMAP-Verbindung neu auf: Google-
 * Freigabe holen, TLS, Anmelden, Kopfzeilen holen, Abmelden. Das dauert auch parallel noch
 * rund zwei Sekunden, und zwar bei **jedem** Öffnen und jedem Neuladen.
 *
 * Die erste Fassung (2026-09-18) legte das Ergebnis eine Minute lang ab. Das half beim
 * Klicken und half nicht beim Arbeiten: wer die Seite zwei Minuten später neu lädt — der
 * Normalfall —, traf immer auf einen kalten Speicher und sah wieder „Lädt …". Jakob am
 * 2026-09-20: „Ich will, wenn ich die Browser-Seite neu lade, direkt meine Mails sehen."
 *
 * Deshalb jetzt **veraltet ausliefern und im Hintergrund erneuern**: Wer fragt, bekommt den
 * letzten bekannten Stand sofort; ist er älter als `FRISCH_MS`, läuft nebenher ein neuer
 * Abruf, dessen Ergebnis die nächste Frage bedient. Gewartet wird nur ein einziges Mal —
 * wenn überhaupt noch nichts bekannt ist.
 *
 * Damit dieses eine Mal auch selten ist, hält `haltePostfaecherWarm` den Speicher warm,
 * solange jemand hinsieht. **Solange jemand hinsieht** ist dabei der Punkt: ein Dauerlauf
 * über Nacht wären 1.400 IMAP-Runden gegen Postfächer, in die niemand schaut.
 */
const FRISCH_MS = Number(process.env.POSTFACH_CACHE_MS ?? 60_000);
/**
 * Wie alt ein Stand höchstens werden darf, bevor doch wieder gewartet wird.
 *
 * Veraltet ausliefern heißt sonst: geht IMAP kaputt, sieht Jakob stundenlang dieselbe Liste
 * und merkt nichts. Jenseits dieser Grenze wird wieder auf den Abruf gewartet — und wenn der
 * scheitert, sieht er den Fehler, wie überall sonst (AGENTS.md: nie glätten).
 */
const HOECHSTALTER_MS = Number(process.env.POSTFACH_MAX_ALTER_MS ?? 15 * 60_000);
/** So lange nach der letzten Frage wird noch von selbst nachgesehen. */
const WARMHALTEN_MS = Number(process.env.POSTFACH_WARM_MS ?? 10 * 60_000);

interface Eintrag {
  /** Wann der abgelegte Stand entstand. */
  zeit: number;
  /** Der letzte bekannte Stand. `null`, solange noch nie einer ankam. */
  wert: Kopf[] | null;
  /** Ein Abruf, der gerade läuft — damit zwei Ansichten sich einen teilen. */
  laeuft: Promise<Kopf[]> | null;
}

type Übersicht = { konto?: string; anzahl?: number; nurUngelesen?: boolean };

const zwischenspeicher = new Map<string, Eintrag>();
/** Wann zuletzt jemand nach einer Übersicht gefragt hat. */
let letzteFrage = 0;

function schluesselFuer(opts: Übersicht): string {
  return JSON.stringify([opts.konto ?? "*", opts.anzahl ?? 15, opts.nurUngelesen ?? false]);
}

/** Startet einen Abruf, wenn nicht schon einer läuft, und gibt ihn zurück. */
function abrufen(alle: Konto[], opts: Übersicht, eintrag: Eintrag): Promise<Kopf[]> {
  if (eintrag.laeuft) return eintrag.laeuft;
  const lauf = liste(alle, opts)
    .then((koepfe) => {
      eintrag.wert = koepfe;
      eintrag.zeit = Date.now();
      return koepfe;
    })
    .finally(() => {
      eintrag.laeuft = null;
    });
  eintrag.laeuft = lauf;
  return lauf;
}

/**
 * Wie `liste`, aber aus dem Zwischenspeicher — und ohne Wartezeit, sobald einmal etwas da ist.
 */
export function listeGepuffert(alle: Konto[], opts: Übersicht = {}): Promise<Kopf[]> {
  letzteFrage = Date.now();
  const schluessel = schluesselFuer(opts);
  let eintrag = zwischenspeicher.get(schluessel);
  if (!eintrag) {
    eintrag = { zeit: 0, wert: null, laeuft: null };
    zwischenspeicher.set(schluessel, eintrag);
  }

  // Noch nie etwas gesehen: dann bleibt nur warten. Ein erfundener leerer Posteingang wäre
  // schlimmer als zwei Sekunden Geduld — er sähe aus wie „keine Post".
  if (eintrag.wert === null) return abrufen(alle, opts, eintrag);

  const alter = Date.now() - eintrag.zeit;
  // So alt, dass niemand mehr dafür geradestehen möchte: dann doch warten — und einen
  // Fehlschlag auch als Fehlschlag zeigen.
  if (alter >= HOECHSTALTER_MS) return abrufen(alle, opts, eintrag);

  // Etwas ist bekannt. Ist es alt, wird nebenher erneuert; ausgeliefert wird trotzdem sofort.
  if (alter >= FRISCH_MS) void abrufen(alle, opts, eintrag).catch(() => undefined);
  return Promise.resolve(eintrag.wert);
}

/**
 * Hält die Übersicht warm, solange jemand hinsieht.
 *
 * Der erste Abruf läuft sofort — damit der erste Blick nach einem Neustart des Gateways schon
 * auf etwas Fertiges trifft. Danach nur noch, wenn innerhalb von `WARMHALTEN_MS` überhaupt
 * jemand gefragt hat.
 */
export function haltePostfaecherWarm(
  alle: () => Konto[],
  opts: Übersicht = { anzahl: 30 },
): { stop(): void } {
  const einmal = (): void => {
    const konten = alle();
    if (konten.length === 0) return;
    const eintrag = zwischenspeicher.get(schluesselFuer(opts));
    // Nichts abrufen, in das niemand hineinsieht — außer beim allerersten Mal.
    if (eintrag && Date.now() - letzteFrage > WARMHALTEN_MS) return;
    void abrufen(konten, opts, eintrag ?? setzeLeer(schluesselFuer(opts))).catch((fehler) =>
      console.warn(
        "[postfach] Warmhalten misslungen:",
        fehler instanceof Error ? fehler.message : fehler,
      ),
    );
  };
  einmal();
  const timer = setInterval(einmal, FRISCH_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function setzeLeer(schluessel: string): Eintrag {
  const eintrag: Eintrag = { zeit: 0, wert: null, laeuft: null };
  zwischenspeicher.set(schluessel, eintrag);
  return eintrag;
}

/** Den Zwischenspeicher leeren — nach dem Versand, oder wenn der Nutzer ausdrücklich neu lädt. */
export function vergissUebersichten(): void {
  zwischenspeicher.clear();
}
