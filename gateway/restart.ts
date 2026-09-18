import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RestartDeps, RestartService } from "./server.js";

/**
 * Neustart der drei Dienste, für den Knopf in den Einstellungen (Nachtrag 2026-09-16).
 *
 * Bis hierher schrieb `/settings/api-keys` zwar in die `.env`, aber niemand las sie neu — die
 * Oberfläche verlangte einen Neustart und zeigte daneben einen toten Knopf. Diese Datei ist die
 * fehlende Hälfte.
 *
 * **`execFile` und keine Shell.** Kommando und Argumente stehen als feste Listen hier im
 * Quelltext; aus dem Browser kommt nur der Name eines der drei Dienste, und der wird gegen
 * `RESTART_SERVICES` geprüft, bevor er hier ankommt. Es gibt damit keinen Weg, über diese Route
 * etwas anderes auszuführen als genau diese drei Zeilen — auch nicht mit einem gestohlenen
 * Web-Token. Ein `exec` mit zusammengebauter Kommandozeile hätte genau diesen Weg geöffnet.
 *
 * **Warum der Voice-Dienst neu *angelegt* und nicht neu *gestartet* wird:** `docker compose
 * restart` benutzt die Umgebung des bestehenden Containers weiter. Ein in der `.env` geänderter
 * Anbieter-Schlüssel käme damit nie an — genau daran scheiterte der Deepgram-Wechsel am
 * 2026-09-16 zuerst. `up -d --force-recreate` liest `env_file` neu.
 */

const exec = promisify(execFile);

interface Command {
  readonly file: string;
  readonly args: readonly string[];
  /**
   * Der Auftrag räumt den eigenen Prozess mit ab. systemd beendet beim Stoppen die ganze
   * Control-Group der Unit — darin steckt auch das `systemctl`-Kind, das wir gerade gestartet
   * haben. Es stirbt also mitten im Lauf, und `execFile` meldet einen Fehlschlag für einen
   * Neustart, der in Wahrheit gerade stattfindet. Ohne diese Kennzeichnung stünde nach jedem
   * erfolgreichen Gateway-Neustart "fehlgeschlagen" im Log.
   */
  readonly selfTerminating?: boolean;
}

const COMMANDS: Record<RestartService, Command> = {
  // `--no-block`, weil der Gateway sich hier selbst neu startet: systemd nimmt den Auftrag an und
  // kehrt zurück, statt auf einen Prozess zu warten, den derselbe Auftrag gerade abräumt.
  gateway: {
    file: "systemctl",
    args: ["restart", "--no-block", "kuronami-gateway"],
    selfTerminating: true,
  },
  ui: { file: "systemctl", args: ["restart", "kuronami-ui"] },
  voice: {
    file: "docker",
    args: ["compose", "--profile", "voice", "up", "-d", "--force-recreate", "voice"],
  },
};

export interface SystemdRestartOptions {
  /** Arbeitsverzeichnis für `docker compose` — dort liegt die docker-compose.yml. Vorgabe: das
   * Verzeichnis, aus dem der Prozess läuft (systemd setzt `WorkingDirectory=/opt/kuronami`). */
  cwd?: string;
}

export function createSystemdRestart(options: SystemdRestartOptions = {}): RestartDeps {
  const cwd = options.cwd ?? process.cwd();
  return {
    async restart(service: RestartService): Promise<void> {
      const command = COMMANDS[service];
      console.log(`[gateway] Neustart ${service}: ${command.file} ${command.args.join(" ")}`);
      const running = exec(command.file, [...command.args], {
        cwd,
        // Ein Neustart, der länger als zwei Minuten braucht, ist kein Neustart mehr, sondern ein
        // Fehler, den der Aufrufer im Log sehen soll.
        timeout: 120_000,
      });

      if (command.selfTerminating) {
        // `--no-block` hat den Auftrag schon bei systemd abgelegt, bevor hier irgendetwas
        // schiefgehen kann. Was danach mit dem Kindprozess passiert, sagt nichts mehr über den
        // Neustart aus — es sagt nur, dass er greift.
        await running.catch(() => {
          console.log("[gateway] systemctl endete mit dem Prozess — der Neustart läuft.");
        });
        return;
      }

      await running;
    },
  };
}
