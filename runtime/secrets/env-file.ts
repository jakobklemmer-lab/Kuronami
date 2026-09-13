import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Provider-Schlüssel aus der Oberfläche heraus setzbar (S32-Nachtrag): statt `.env` von Hand zu
 * editieren, trägt die Einstellungsseite (`ui/settings/view.ts`, Abschnitt "API-Keys") sie über
 * das Gateway ein. Diese Datei ist die einzige Stelle, die weiß, wie eine `.env`-Zeile aussieht
 * — `gateway/server.ts` kennt nur `readSecretStatus`/`upsertSecrets`, nie das Dateiformat selbst.
 *
 * **Absichtlich keine Umgebungsvariable wird ungefragt zugelassen.** Nur `KNOWN_SECRET_KEYS`
 * lässt sich schreiben — sonst wäre aus einer Handvoll Provider-Schlüsseln ein allgemeiner Weg
 * geworden, beliebige Umgebungsvariablen der Prozesse zu setzen.
 *
 * **Eine Änderung gilt erst nach einem Neustart** des jeweiligen Dienstes. Dieselbe Haltung wie
 * bei `voice/pipeline/config.py` (`config_from_env`) und `createAnthropicClient`
 * (`MissingApiKeyError`): Konfiguration wird beim Start gelesen und geprüft, nie mitten im
 * Betrieb nachgezogen — ein Fernsteuerungs-Endpunkt für einen Neustart fehlt bewusst noch
 * (`ui/settings/view.ts`, Abschnitt System, "Kein Fernsteuerungs-Endpunkt").
 */

export const KNOWN_SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "VOICE_SESSION_TOKEN",
  "VOICE_BRIDGE_TOKEN",
] as const;

export type SecretKey = (typeof KNOWN_SECRET_KEYS)[number];

export function isSecretKey(value: string): value is SecretKey {
  return (KNOWN_SECRET_KEYS as readonly string[]).includes(value);
}

export interface SecretStatus {
  set: boolean;
  /** Nie der volle Wert — nur die letzten vier Zeichen, zur Wiedererkennung im Browser. */
  preview: string | null;
}

/** `KEY=wert` einer Zeile, oder `null` für eine leere Zeile, einen Kommentar oder eine Zeile
 * ohne `=`. Zieht keine Anführungszeichen ab — `.env.example` schreibt Werte durchgehend ohne. */
function parseLine(line: string): { key: string; value: string } | null {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  return match ? { key: match[1], value: match[2] } : null;
}

/** Liest, ob die bekannten Schlüssel in einem `.env`-Inhalt gesetzt sind — nie den Wert selbst. */
export function readSecretStatus(
  contents: string,
  keys: readonly string[] = KNOWN_SECRET_KEYS,
): Record<string, SecretStatus> {
  const values = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const parsed = parseLine(line);
    if (parsed) values.set(parsed.key, parsed.value);
  }

  const status: Record<string, SecretStatus> = {};
  for (const key of keys) {
    const value = values.get(key) ?? "";
    status[key] =
      value.length > 0
        ? { set: true, preview: `…${value.slice(-4)}` }
        : { set: false, preview: null };
  }
  return status;
}

/**
 * Baut einen neuen `.env`-Inhalt: Zeilen bekannter, betroffener Schlüssel werden ersetzt, neue
 * Schlüssel ans Ende angehängt — Kommentare, Reihenfolge und jede andere Zeile bleiben
 * unverändert. Wirft, statt eine unbekannte Variable oder einen mehrzeiligen Wert klaglos
 * durchzureichen.
 */
export function upsertSecrets(contents: string, updates: Readonly<Record<string, string>>): string {
  for (const key of Object.keys(updates)) {
    if (!isSecretKey(key)) {
      throw new Error(
        `"${key}" ist kein bekannter Schlüssel — erlaubt sind ${KNOWN_SECRET_KEYS.join(", ")}.`,
      );
    }
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value.includes("\n")) {
      throw new Error(
        `Der Wert für "${key}" enthält einen Zeilenumbruch — das kann keine .env-Zeile sein.`,
      );
    }
  }

  const remaining = new Map(Object.entries(updates));
  const lines = contents.length > 0 ? contents.split("\n") : [];

  const next = lines.map((line) => {
    const parsed = parseLine(line);
    if (!parsed || !remaining.has(parsed.key)) return line;
    const value = remaining.get(parsed.key) as string;
    remaining.delete(parsed.key);
    return `${parsed.key}=${value}`;
  });

  // Eine einzelne abschließende Leerzeile (aus dem letzten `\n` beim Aufteilen) wird entfernt,
  // damit ein Anhängen nicht eine sichtbare Lücke vor den neuen Zeilen hinterlässt.
  if (next.length > 0 && next[next.length - 1] === "") next.pop();
  for (const [key, value] of remaining) next.push(`${key}=${value}`);

  return `${next.join("\n")}\n`;
}

/** Der Pfad der `.env`-Datei, aus der Umgebung oder explizit — Fabrik wie `artifactRootFromEnv`
 * (`runtime/artifacts/store.ts`), kein Modul-Singleton. Setzt keine Existenz voraus: `readEnvFile`
 * behandelt eine fehlende Datei als leeren Inhalt. */
export function envFilePathFromEnv(explicit = process.env.KURONAMI_ENV_FILE): string {
  return path.resolve(explicit && explicit.trim().length > 0 ? explicit : ".env");
}

export async function readEnvFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function writeEnvFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
}
