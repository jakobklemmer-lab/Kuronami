import type { Express, Request, Response } from "express";
import { googleAnwendung } from "./postfach.js";

/**
 * Ein Postfach verbinden — einmal im Browser, statt Zugangsdaten abzutippen.
 *
 * Der Umweg ist nötig, weil Gmail keinen einfacheren zulässt: App-Passwörter sind für Jakobs
 * Konten nicht anwählbar („die gesuchte Einstellung ist für Ihr Konto nicht verfügbar", was
 * an fehlender Zwei-Faktor-Bestätigung oder an einer Workspace-Vorgabe liegt), und Microsoft
 * hat einfaches IMAP ganz abgeschaltet. Bleibt der Weg über eine Zustimmung im Browser.
 *
 * **Kuronami bekommt dabei einen eigenen Zugang, nicht n8ns.** Die dort hinterlegten Zugänge
 * ließen sich zwar entschlüsseln, aber sie gehören einer Anwendung, die hier gerade
 * abgeschafft wird — ein Postfach, das an n8n hängt, wäre genau die Abhängigkeit, die wir
 * loswerden wollen.
 *
 * Der Ablauf: Jakob ruft `/postfach/verbinden` auf, stimmt bei Google zu, landet auf
 * `/postfach/zurueck`, und bekommt dort die Zeile, die in die `.env` gehört. Bewusst **keine**
 * automatische Ablage: ein Prozess, der sich seine eigene Konfiguration umschreibt, ist
 * schwerer nachzuvollziehen als eine Zeile, die man selbst einfügt — und ein Neustart macht
 * ohnehin sichtbar, ob sie richtig steht.
 */

/** Lesen, Schreiben von Entwürfen, Versenden. Nicht mehr — kein Löschen, keine Kontodaten. */
const BEREICHE = ["https://mail.google.com/"].join(" ");

function rueckadresse(req: Request): string {
  const konfiguriert = process.env.POSTFACH_RUECKADRESSE?.trim();
  if (konfiguriert) return konfiguriert;
  // Hinter Caddy steht der echte Hostname in den Weiterleitungs-Kopfzeilen; ohne sie
  // (lokaler Aufruf) tut es der Host aus der Anfrage.
  const schema = req.header("x-forwarded-proto") ?? req.protocol;
  const host = req.header("x-forwarded-host") ?? req.header("host") ?? "localhost:3000";
  return `${schema}://${host}/postfach/zurueck`;
}

function seite(titel: string, inhalt: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titel}</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:48px 20px}
  h1{font-size:22px;font-weight:600;margin:0 0 16px}
  code,pre{font-family:ui-monospace,monospace;font-size:13px}
  pre{background:rgba(128,128,128,.12);padding:14px 16px;border-radius:8px;overflow-x:auto;
      white-space:pre-wrap;word-break:break-all}
  a.knopf{display:inline-block;padding:10px 18px;border-radius:8px;background:#1a73e8;
          color:#fff;text-decoration:none;font-weight:500}
  .leise{opacity:.72}
</style></head><body>${inhalt}</body></html>`;
}

export function postfachVerbindenRouten(app: Express): void {
  app.get("/postfach/verbinden", (req: Request, res: Response) => {
    const google = googleAnwendung();
    if (!google) {
      res.status(503).send(
        seite(
          "Noch nicht eingerichtet",
          `<h1>Es fehlt noch die Anwendung</h1>
           <p>Kuronami braucht eine eigene Google-Anwendung, unter der er um Zugang bittet.
           In der Google Cloud Console unter <em>APIs &amp; Dienste → Anmeldedaten</em> eine
           OAuth-Client-ID vom Typ <em>Webanwendung</em> anlegen, die Gmail-API aktivieren und
           als autorisierte Weiterleitungs-URI eintragen:</p>
           <pre>${rueckadresse(req)}</pre>
           <p>Die beiden Werte danach in die <code>.env</code>:</p>
           <pre>GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…</pre>
           <p class="leise">Danach das Gateway neu starten und diese Seite erneut aufrufen.</p>`,
        ),
      );
      return;
    }

    const ziel = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    ziel.searchParams.set("client_id", google.id);
    ziel.searchParams.set("redirect_uri", rueckadresse(req));
    ziel.searchParams.set("response_type", "code");
    ziel.searchParams.set("scope", BEREICHE);
    // Ohne beides gibt Google nur einen kurzlebigen Zugang und keine dauerhafte Erneuerung —
    // das Postfach wäre nach einer Stunde wieder zu.
    ziel.searchParams.set("access_type", "offline");
    ziel.searchParams.set("prompt", "consent");

    res.send(
      seite(
        "Postfach verbinden",
        `<h1>Postfach verbinden</h1>
         <p>Melden Sie sich mit dem Konto an, das Kuronami lesen soll. Sie können den Zugang
         jederzeit unter <em>myaccount.google.com → Sicherheit → Apps von Drittanbietern</em>
         wieder entziehen.</p>
         <p><a class="knopf" href="${ziel.toString()}">Bei Google anmelden</a></p>
         <p class="leise">Für jedes Postfach einmal — danach dieselbe Seite erneut aufrufen und
         das nächste Konto wählen.</p>`,
      ),
    );
  });

  app.get("/postfach/zurueck", async (req: Request, res: Response) => {
    const google = googleAnwendung();
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const fehler = typeof req.query.error === "string" ? req.query.error : null;

    if (fehler) {
      res.status(400).send(
        seite("Abgebrochen", `<h1>Abgebrochen</h1><p>Google meldet: <code>${fehler}</code></p>`),
      );
      return;
    }
    if (!google || !code) {
      res.status(400).send(seite("Fehlt etwas", "<h1>Es fehlt der Bestätigungscode.</h1>"));
      return;
    }

    try {
      const antwort = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: google.id,
          client_secret: google.geheimnis,
          redirect_uri: rueckadresse(req),
          grant_type: "authorization_code",
        }),
      });
      if (!antwort.ok) throw new Error(`Google antwortet mit HTTP ${antwort.status}`);

      const daten = (await antwort.json()) as { refresh_token?: string; access_token?: string };
      if (!daten.refresh_token) {
        throw new Error(
          "Google hat keine dauerhafte Erneuerung mitgeschickt. Das passiert, wenn dieses " +
            "Konto der Anwendung schon einmal zugestimmt hat — entziehen Sie den Zugang unter " +
            "myaccount.google.com und verbinden Sie erneut.",
        );
      }

      // Die Adresse gleich mit erfragen, damit Jakob nicht raten muss, welches Konto er
      // gerade verbunden hat — bei fünf Postfächern ist das keine Kleinigkeit.
      let adresse = "…";
      try {
        const profil = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          { headers: { authorization: `Bearer ${daten.access_token}` } },
        );
        if (profil.ok) adresse = ((await profil.json()) as { emailAddress?: string }).emailAddress ?? "…";
      } catch {
        // Nicht schlimm — die Zeile unten steht auch ohne Adresse.
      }

      const nummer = Number(process.env.POSTFACH_NAECHSTE_NUMMER ?? 1);
      res.send(
        seite(
          "Verbunden",
          `<h1>${adresse} ist verbunden</h1>
           <p>Diese Zeilen in die <code>.env</code> von Kuronami, mit einer freien Nummer:</p>
           <pre>MAIL_${nummer}_NAME=${adresse.split("@")[0]}
MAIL_${nummer}_USER=${adresse}
MAIL_${nummer}_GOOGLE=${daten.refresh_token}</pre>
           <p>Danach das Gateway neu starten. Für das nächste Postfach erneut
           <code>/postfach/verbinden</code> aufrufen und die Nummer hochzählen.</p>
           <p class="leise">Die Zeile ist ein Schlüssel zu Ihrem Postfach — behandeln Sie sie
           wie ein Passwort und schließen Sie diese Seite danach.</p>`,
        ),
      );
    } catch (error) {
      res.status(502).send(
        seite(
          "Misslungen",
          `<h1>Das hat nicht geklappt</h1>
           <p>${error instanceof Error ? error.message : String(error)}</p>`,
        ),
      );
    }
  });
}
