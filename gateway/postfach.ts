import { ImapFlow } from "imapflow";
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
  if (!antwort.ok) {
    throw new Error(
      `Google verweigert den Zugang (HTTP ${antwort.status}). Vermutlich wurde die Freigabe ` +
        `entzogen — dann hilft nur, das Konto unter /postfach/verbinden neu zu verbinden.`,
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
        `Für ${konto.name} liegt ein Google-Zugang vor, aber GOOGLE_CLIENT_ID und ` +
          `GOOGLE_CLIENT_SECRET fehlen in der Umgebung.`,
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
  await client.connect();
  try {
    return await was(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
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
  opts: { konto?: string; anzahl?: number; nurUngelesen?: boolean } = {},
): Promise<Kopf[]> {
  const anzahl = Math.min(Math.max(opts.anzahl ?? 15, 1), 50);
  const ergebnis: Kopf[] = [];

  for (const konto of kontoFinden(alle, opts.konto)) {
    const koepfe = await mitVerbindung(konto, async (client) => {
      const schloss = await client.getMailboxLock("INBOX");
      try {
        const box = client.mailbox;
        const gesamt = typeof box === "object" && box ? box.exists : 0;
        if (!gesamt) return [];

        const von = Math.max(1, gesamt - anzahl * 3 + 1);
        const gesammelt: Kopf[] = [];
        for await (const nachricht of client.fetch(`${von}:*`, {
          envelope: true,
          flags: true,
          bodyStructure: false,
          source: false,
        })) {
          const ungelesen = !nachricht.flags?.has("\\Seen");
          if (opts.nurUngelesen && !ungelesen) continue;
          const umschlag = nachricht.envelope;
          gesammelt.push({
            konto: konto.name,
            uid: nachricht.uid,
            von:
              umschlag?.from?.map((a) => a.name || a.address || "").join(", ") || "(unbekannt)",
            betreff: umschlag?.subject || "(kein Betreff)",
            am: umschlag?.date ? new Date(umschlag.date).toISOString() : "",
            ungelesen,
            anriss: "",
          });
        }
        return gesammelt.reverse().slice(0, anzahl);
      } finally {
        schloss.release();
      }
    });
    ergebnis.push(...koepfe);
  }

  // Über alle Konten hinweg nach Zeit sortieren: Jakob hat ein Postfach im Kopf, nicht fünf.
  return ergebnis.sort((a, b) => b.am.localeCompare(a.am)).slice(0, anzahl);
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
