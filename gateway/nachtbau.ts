import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Die Beobachtungsseite für den Nachtbau (2026-09-27): was `bau/nachtbau.sh` gerade tut, was aus
 * `bau/PLAN.md` erledigt ist, die letzten Zeilen des Protokolls und der jüngste Bericht.
 *
 * Nur lesend. Der Nachtbau ist ein eigener systemd-Dienst (`kuronami-nachtbau.service`, geweckt
 * vom Timer um 00:30 Wien); von hier aus wird er weder gestartet noch angehalten.
 */

export interface NachtbauAufgabe {
  id: string;
  titel: string;
  status: string;
}

export interface NachtbauStand {
  /** ActiveState des Dienstes: active, activating, inactive, failed — oder „unbekannt". */
  dienst: string;
  /** Nächster Weckruf des Timers (ISO), falls systemd ihn nennt. */
  naechsterStart: string | null;
  aufgaben: NachtbauAufgabe[];
  protokoll: { datei: string; zeilen: string[] } | null;
  bericht: { datei: string; text: string } | null;
}

const PROTOKOLL_ZEILEN = 14;
const BERICHT_ZEICHEN = 8000;

/** Die Aufgaben aus `bau/PLAN.md`: je `## N<n> · Titel` (auch Teilaufgaben wie N17a) mit `- Status: …`. */
export function leseAufgaben(plan: string): NachtbauAufgabe[] {
  const aufgaben: NachtbauAufgabe[] = [];
  for (const block of plan.split(/^## /m).slice(1)) {
    const kopf = /^(N\d+[a-z]?)\s*·\s*(.+)$/.exec(block.split("\n", 1)[0] ?? "");
    if (!kopf?.[1] || !kopf[2]) continue;
    const status = /^- Status:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "offen";
    aufgaben.push({ id: kopf[1], titel: kopf[2].trim(), status });
  }
  return aufgaben;
}

async function juengste(ordner: string, endung: string): Promise<string | null> {
  try {
    const namen = (await readdir(ordner))
      .filter((n) => n.endsWith(endung) && n !== "README.md")
      .sort();
    return namen.at(-1) ?? null;
  } catch {
    return null;
  }
}

const exec = promisify(execFile);

async function systemd(einheit: string, eigenschaft: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "systemctl",
      ["show", einheit, "-p", eigenschaft, "--value", "--timestamp=unix"],
      { timeout: 3000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function nachtbauStand(wurzel: string): Promise<NachtbauStand> {
  const bau = path.join(wurzel, "bau");
  const plan = await readFile(path.join(bau, "PLAN.md"), "utf8").catch(() => "");
  const logName = await juengste(path.join(bau, "protokoll"), ".log");
  const berichtName = await juengste(path.join(bau, "berichte"), ".md");
  const [dienst, weckruf, log, bericht] = await Promise.all([
    systemd("kuronami-nachtbau.service", "ActiveState"),
    systemd("kuronami-nachtbau.timer", "NextElapseUSecRealtime"),
    logName ? readFile(path.join(bau, "protokoll", logName), "utf8").catch(() => null) : null,
    berichtName
      ? readFile(path.join(bau, "berichte", berichtName), "utf8").catch(() => null)
      : null,
  ]);
  const sekunden = /^@(\d+)$/.exec(weckruf ?? "")?.[1];
  return {
    dienst: dienst ?? "unbekannt",
    naechsterStart: sekunden ? new Date(Number(sekunden) * 1000).toISOString() : null,
    aufgaben: leseAufgaben(plan),
    protokoll:
      logName && log !== null
        ? {
            datei: logName,
            zeilen: log
              .split("\n")
              .filter((z) => z.trim())
              .slice(-PROTOKOLL_ZEILEN),
          }
        : null,
    bericht:
      berichtName && bericht !== null
        ? { datei: berichtName, text: bericht.slice(0, BERICHT_ZEICHEN) }
        : null,
  };
}
