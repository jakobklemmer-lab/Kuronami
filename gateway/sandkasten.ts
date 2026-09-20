import { execFileSync } from "node:child_process";
import type { CanUseTool, SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { WERKSTATT } from "../context/bedienstete.js";

/**
 * Der Sandkasten, in dem die Bediensteten arbeiten dürfen.
 *
 * Vorgeschichte: Bash war nie verboten, es war nur unbenutzbar. Die Bediensteten sahen es im
 * Katalog (eine `tools`-Liste regelt, was **ohne Rückfrage** läuft, sie blendet nichts aus),
 * versuchten es, und weil ihre Läufe kein `canUseTool` hatten, verlief jede Rückfrage im
 * Nichts: „This command requires approval". Am 2026-09-20 gingen so 21 von 193
 * Werkzeugaufrufen verloren — und ein Chartanalyst brauchte 279 Sekunden für eine Analyse,
 * von denen er die meiste Zeit gegen sein Werkzeug kämpfte statt gegen den Markt.
 *
 * Die Antwort ist nicht „Bash freigeben". **Der Gateway läuft als root**, und auf demselben
 * Rechner liegen `/opt/kuronami/.env` mit allen Schlüsseln und `~/.claude/.credentials.json`
 * mit Jakobs Abo. Dazu kommt, dass gerade die Handelsleute fremde Webseiten lesen: wer
 * Nachrichtenseiten durchsieht, führt Text aus fremder Hand in denselben Lauf, der den Befehl
 * absetzen würde. Ein freier Root-Shell wäre damit genau eine untergeschobene Zeile von den
 * Zugangsdaten entfernt.
 *
 * Deshalb: Bash ja, aber eingehegt.
 *
 *  - **Im Sandkasten, ohne Rückfrage** (`autoAllowBashIfSandboxed`). Was lokal rechnet —
 *    `python3`, `jq`, `awk`, `date` — läuft einfach.
 *  - **Kein Ausbruch.** `allowUnsandboxedCommands: false` macht `dangerouslyDisableSandbox`
 *    wirkungslos; die boerse hat genau das am 2026-09-20 um 16:04:30 versucht.
 *  - **Netz nur auf eine feste Liste**, hart abgewiesen statt nachgefragt. Kursdaten kommen
 *    ohnehin über das Werkzeug `kurse`; Bash braucht das Netz für nichts.
 *  - **Geheimnisse sind weg**, nicht nur ungern gesehen: die `.env` und die Zugangsdaten sind
 *    im Sandkasten nicht lesbar, und die Schlüssel stehen den Befehlen auch nicht in der
 *    Umgebung zur Verfügung — der Gateway startet mit `--env-file=.env`, sein ganzer
 *    Schlüsselbund steckt also in `process.env` und würde sonst vererbt.
 *  - **Geschrieben wird nur im Arbeitsbereich.**
 *
 * `failIfUnavailable: true` ist Absicht: fehlt der Sandkasten (kein `bwrap`), sollen die
 * Läufe scheitern und nicht klaglos als root weiterlaufen. Bei einem Haushalt, der Geld
 * bewegt, ist ein Ausfall die bessere Störung.
 */

/** Woher Bash im Sandkasten Daten ziehen darf. Alles andere wird abgewiesen. */
const ERLAUBTE_DOMAENEN = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

/**
 * Umgebungsvariablen, die im Sandkasten nicht stehen dürfen.
 *
 * Nicht von Hand gepflegt, sondern aus `process.env` abgeleitet — die `.env` wächst, und eine
 * Liste, die man nachtragen muss, ist nach dem dritten neuen Schlüssel falsch. Alles, was nach
 * Geheimnis aussieht, fliegt raus; im Zweifel eins zu viel.
 */
const GEHEIM_MUSTER = /(KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIAL|WEBHOOK|DSN|SESSION|CLIENT_ID)/i;

function geheimeVariablen(): Array<{ name: string; mode: "deny" }> {
  return Object.keys(process.env)
    .filter((name) => GEHEIM_MUSTER.test(name))
    .map((name) => ({ name, mode: "deny" as const }));
}

/** Dateien, die im Sandkasten nicht lesbar sind — auch nicht versehentlich. */
const GEHEIME_DATEIEN = [
  "/opt/kuronami/.env",
  "/root/.claude/.credentials.json",
  "/root/.claude.json",
];

const GESPERRT_ZUM_LESEN = [
  "/opt/kuronami/.env",
  "/opt/kuronami/.env.*",
  "/root/.claude",
  "/root/.ssh",
  "/root/.docker",
  "/root/.config",
  "/opt/kuronami/memory",
];

export interface SandkastenOptionen {
  /**
   * Weitere Domänen für diesen einen Bediensteten.
   *
   * Die Bauabteilung braucht Paketquellen, der Handelstisch nicht. Wer mehr darf, sagt es
   * hier — und es steht dann an genau einer Stelle, statt dass die Liste für alle wächst.
   */
  zusatzDomaenen?: readonly string[];
}

export function sandkasten(optionen: SandkastenOptionen = {}): SandboxSettings {
  return {
    enabled: true,
    // Lieber ein Fehlschlag als ein Befehl, der ungeschützt als root läuft.
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [...ERLAUBTE_DOMAENEN, ...(optionen.zusatzDomaenen ?? [])],
      // Deterministisch abweisen statt fragen: eine Rückfrage, die niemand beantwortet, ist
      // genau die Sackgasse, die hier abgeschafft wird.
      strictAllowlist: true,
    },
    filesystem: {
      allowWrite: [WERKSTATT],
      denyRead: GESPERRT_ZUM_LESEN,
    },
    credentials: {
      files: GEHEIME_DATEIEN.map((path) => ({ path, mode: "deny" as const })),
      envVars: geheimeVariablen(),
    },
  };
}

/**
 * Trägt der Sandkasten auf diesem Rechner überhaupt?
 *
 * Er braucht `bwrap`, `socat` — und die Erlaubnis, **verschachtelte** Benutzer-Namensräume
 * anzulegen. Am dritten Punkt scheitert es auf diesem Host: Ubuntu setzt
 * `kernel.apparmor_restrict_unprivileged_userns = 1`, und die Sandkasten-Laufzeit bekommt
 * dann beim Anlegen ihrer Abschottung „nested userns is capability-restricted". Einfache
 * bwrap-Aufrufe gehen, verschachtelte nicht.
 *
 * Die Prüfung steht hier, weil davon eine **Sicherheitsentscheidung** abhängt und keine
 * Bequemlichkeit: ohne tragenden Sandkasten bekommt das Personal kein Bash. Der Gateway läuft
 * als root — ein Befehl ohne Abschottung wäre ein Root-Befehl, ausgelöst von einem Modell, das
 * fremde Webseiten liest. Lieber ein Bediensteter, der nicht rechnen kann.
 *
 * Wird der Schalter umgelegt (`sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`,
 * dauerhaft über `/etc/sysctl.d/`), schaltet sich Bash beim nächsten Start von selbst frei.
 * Einmal geprüft und gemerkt: das ist eine Eigenschaft des Rechners, keine des Auftrags.
 */
let gemerkteLage: { ok: boolean; grund: string } | null = null;

export function sandkastenLage(): { ok: boolean; grund: string } {
  if (gemerkteLage) return gemerkteLage;
  gemerkteLage = pruefeSandkasten();
  return gemerkteLage;
}

function pruefeSandkasten(): { ok: boolean; grund: string } {
  if (process.env.KURO_SANDKASTEN === "aus") {
    return { ok: false, grund: "über KURO_SANDKASTEN=aus abgeschaltet" };
  }
  for (const werkzeug of ["bwrap", "socat"]) {
    try {
      execFileSync("which", [werkzeug], { stdio: "ignore" });
    } catch {
      return { ok: false, grund: `${werkzeug} ist nicht installiert (apt install ${werkzeug})` };
    }
  }
  try {
    // Genau der Fall, an dem die Laufzeit hängenbleibt: ein Namensraum im Namensraum.
    execFileSync(
      "bwrap",
      [
        "--unshare-user",
        "--ro-bind",
        "/",
        "/",
        "bwrap",
        "--unshare-user",
        "--ro-bind",
        "/",
        "/",
        "/bin/true",
      ],
      { stdio: "ignore", timeout: 10_000 },
    );
  } catch {
    return {
      ok: false,
      grund:
        "verschachtelte Benutzer-Namensräume sind gesperrt " +
        "(kernel.apparmor_restrict_unprivileged_userns=1)",
    };
  }
  return { ok: true, grund: "trägt" };
}

/**
 * Die Lauf-Optionen eines Bediensteten, soweit sie den Sandkasten betreffen.
 *
 * An einer Stelle, weil die Entscheidung „darf dieser Lauf Bash?" an zwei Ecken gebraucht wird
 * (Gesindehaus und Handelstisch) und an beiden **dieselbe** sein muss. Trägt der Sandkasten
 * nicht, fliegt Bash aus dem Katalog statt ungeschützt zu laufen.
 */
export function sandkastenOptionen(
  wer: string,
  tools: string[] | undefined,
  disallowedTools: string[] | undefined,
  zusatzDomaenen?: readonly string[],
): {
  allowedTools?: string[];
  disallowedTools?: string[];
  sandbox?: SandboxSettings;
  canUseTool: CanUseTool;
} {
  const lage = sandkastenLage();
  if (lage.ok) {
    return {
      ...(tools ? { allowedTools: tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      sandbox: sandkasten(zusatzDomaenen ? { zusatzDomaenen } : {}),
      canUseTool: absageStattSackgasse(wer),
    };
  }
  return {
    ...(tools ? { allowedTools: tools.filter((t) => t !== "Bash") } : {}),
    disallowedTools: [...new Set([...(disallowedTools ?? []), "Bash", "KillShell", "BashOutput"])],
    canUseTool: absageStattSackgasse(wer),
  };
}

/**
 * Was ein Bediensteter fragt, wenn der Sandkasten nicht reicht — und die Antwort darauf.
 *
 * Es gibt niemanden, der hier zustimmen könnte: der Bedienstete arbeitet im Hintergrund,
 * Jakob spricht mit dem Butler. Eine offene Rückfrage stünde also für immer. Statt sie
 * unbeantwortet verhungern zu lassen, kommt eine **Absage mit Begründung** zurück — die geht
 * ins Modell und lenkt es auf den richtigen Weg, statt dass es denselben Befehl dreimal
 * umformuliert. Genau dieses Umformulieren hat am 2026-09-20 die Läufe aufgebläht.
 */
export function absageStattSackgasse(wer: string): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "Bash") {
      const befehl = typeof input.command === "string" ? input.command : "";
      const lage = sandkastenLage();
      if (!lage.ok) {
        return {
          behavior: "deny",
          message: `Bash steht dir auf diesem Rechner nicht zur Verfügung: der Sandkasten trägt nicht (${lage.grund}), und ohne Abschottung läuft hier kein Befehl — der Dienst läuft als root. Kursdaten holst du mit \`verlauf\` aus dem Werkzeug \`kurse\`, das Chance-Risiko-Verhältnis mit \`crv\` — das ist ohnehin der einzig zulässige Weg zu dieser Zahl, mit oder ohne Bash. Webseiten mit WebFetch. Andere Nebenrechnungen beschreibst du, statt sie zu behaupten; versuche es nicht noch einmal.`,
        };
      }
      if (input.dangerouslyDisableSandbox === true) {
        return {
          behavior: "deny",
          message:
            "Nein — Befehle laufen ausschließlich im Sandkasten. Der Schalter ist wirkungslos; " +
            "formuliere den Befehl so, dass er ohne Netz und außerhalb der gesperrten Pfade auskommt.",
        };
      }
      return {
        behavior: "deny",
        message: `Dieser Befehl kommt nicht durch den Sandkasten: ${befehl.slice(0, 120)}\nKein Netzzugriff über Bash (kein curl, kein wget) und kein Zugriff außerhalb des Arbeitsbereichs. Kursdaten holst du mit \`verlauf\` aus dem Werkzeug \`kurse\`, Webseiten mit WebFetch. Rechnen, zählen und Dateien im Arbeitsbereich darfst du ohne Rückfrage — versuche es nicht noch einmal mit demselben Weg.`,
      };
    }
    return {
      behavior: "deny",
      message: `${toolName} steht dir nicht zur Verfügung, ${wer}. Arbeite mit den Werkzeugen deines Fachs und berichte, was damit möglich war.`,
    };
  };
}
