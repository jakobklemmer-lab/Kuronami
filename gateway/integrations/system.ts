import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";

/**
 * Echte Messwerte des Rechners, auf dem das Gateway läuft — für die System-Karte der
 * Startseite (Nachtrag 2026-09-16, Ablösung von `createMockSystemGaugesProvider`). Das
 * Gateway läuft als systemd-Dienst direkt auf dem Host, nicht im Container; `os`, `statfs`
 * und `/proc/net/dev` sehen also den echten Rechner.
 *
 * CPU und Netz sind **Raten** und brauchen zwei Messpunkte. Statt je Anfrage 200 ms zu warten,
 * behält der Sampler den letzten Stand und rechnet die Differenz zur vorigen Anfrage — beim
 * ersten Aufruf fällt CPU auf `loadavg` zurück und das Netz meldet 0, beim zweiten stimmt es.
 */

export interface CpuSample {
  idle: number;
  total: number;
}

export interface NetSample {
  /** Summe empfangener + gesendeter Bytes über alle Schnittstellen außer `lo`. */
  bytes: number;
  atMs: number;
}

export interface SystemSnapshot {
  cpuPercent: number;
  ramPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  diskPercent: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  /** Bytes je Sekunde, Empfang + Senden. `null`, wenn noch kein zweiter Messpunkt vorliegt. */
  netBytesPerSecond: number | null;
}

export function readCpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

/** Auslastung zwischen zwei Messpunkten in Prozent; `null`, wenn keine Zeit vergangen ist. */
export function cpuPercentBetween(previous: CpuSample, current: CpuSample): number | null {
  const total = current.total - previous.total;
  if (total <= 0) return null;
  const idle = current.idle - previous.idle;
  return clampPercent(((total - idle) / total) * 100);
}

/** Erster Messpunkt: die 1-Minuten-Last geteilt durch die Kernzahl, als grobe Näherung. */
export function cpuPercentFromLoad(): number {
  const count = Math.max(1, cpus().length);
  return clampPercent((loadavg()[0] / count) * 100);
}

/** `/proc/net/dev`: je Zeile Schnittstelle, dann 16 Zähler; Spalte 1 ist RX-Bytes, Spalte 9
 * TX-Bytes. `lo` zählt nicht — Loopback ist kein Netzverkehr. */
export function parseNetDev(contents: string): number {
  let bytes = 0;
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const iface = line.slice(0, separator).trim();
    if (iface === "lo") continue;
    const fields = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/);
    if (fields.length < 9) continue;
    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (Number.isFinite(rx)) bytes += rx;
    if (Number.isFinite(tx)) bytes += tx;
  }
  return bytes;
}

export function netBytesPerSecondBetween(previous: NetSample, current: NetSample): number | null {
  const seconds = (current.atMs - previous.atMs) / 1000;
  if (seconds <= 0) return null;
  return Math.max(0, (current.bytes - previous.bytes) / seconds);
}

export function formatBytesPerSecond(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} kB/s`;
  return `${Math.round(value)} B/s`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export interface SystemSampler {
  snapshot(): Promise<SystemSnapshot>;
}

/** Hält die letzten Messpunkte für CPU und Netz zwischen zwei Aufrufen. */
export function createSystemSampler(
  readNetDev: () => Promise<string> = () => readFile("/proc/net/dev", "utf8"),
): SystemSampler {
  let lastCpu: CpuSample | null = null;
  let lastNet: NetSample | null = null;

  return {
    async snapshot() {
      const cpu = readCpuSample();
      const cpuPercent =
        lastCpu !== null
          ? (cpuPercentBetween(lastCpu, cpu) ?? cpuPercentFromLoad())
          : cpuPercentFromLoad();
      lastCpu = cpu;

      let netBytesPerSecond: number | null = null;
      try {
        const net: NetSample = { bytes: parseNetDev(await readNetDev()), atMs: Date.now() };
        if (lastNet !== null) netBytesPerSecond = netBytesPerSecondBetween(lastNet, net);
        lastNet = net;
      } catch {
        // Kein /proc (anderes Betriebssystem) — das Netz bleibt einfach ohne Wert, der Rest
        // der Karte muss deswegen nicht leer bleiben.
      }

      const ramTotalBytes = totalmem();
      const ramUsedBytes = ramTotalBytes - freemem();
      const disk = await statfs("/");
      const diskTotalBytes = disk.blocks * disk.bsize;
      const diskUsedBytes = (disk.blocks - disk.bavail) * disk.bsize;

      return {
        cpuPercent,
        ramPercent: clampPercent((ramUsedBytes / ramTotalBytes) * 100),
        ramUsedBytes,
        ramTotalBytes,
        diskPercent: clampPercent((diskUsedBytes / diskTotalBytes) * 100),
        diskUsedBytes,
        diskTotalBytes,
        netBytesPerSecond,
      };
    },
  };
}
