import { describe, expect, it } from "vitest";
import {
  cpuPercentBetween,
  createSystemSampler,
  formatBytesPerSecond,
  netBytesPerSecondBetween,
  parseNetDev,
} from "./system.js";

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000  1000    0    0    0     0          0         0  1000000  1000    0    0    0     0       0          0
  eth0: 5000000  4000    0    0    0     0          0         0  2000000  3000    0    0    0     0       0          0
docker0:  300000   200    0    0    0     0          0         0   100000   150    0    0    0     0       0          0
`;

describe("parseNetDev", () => {
  it("summiert RX und TX aller Schnittstellen außer lo", () => {
    expect(parseNetDev(NET_DEV)).toBe(5_000_000 + 2_000_000 + 300_000 + 100_000);
  });

  it("gibt 0 für leeren oder fremden Inhalt", () => {
    expect(parseNetDev("")).toBe(0);
    expect(parseNetDev("kein proc")).toBe(0);
  });
});

describe("cpuPercentBetween", () => {
  it("rechnet die belegte Zeit zwischen zwei Messpunkten", () => {
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(50);
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 0, total: 0 })).toBeNull();
  });
});

describe("netBytesPerSecondBetween", () => {
  it("teilt die Differenz durch die vergangene Zeit", () => {
    expect(netBytesPerSecondBetween({ bytes: 1000, atMs: 0 }, { bytes: 3000, atMs: 2000 })).toBe(
      1000,
    );
    expect(netBytesPerSecondBetween({ bytes: 1000, atMs: 0 }, { bytes: 3000, atMs: 0 })).toBeNull();
  });
});

describe("formatBytesPerSecond", () => {
  it("wählt die Einheit nach Größe", () => {
    expect(formatBytesPerSecond(512)).toBe("512 B/s");
    expect(formatBytesPerSecond(20 * 1024)).toBe("20 kB/s");
    expect(formatBytesPerSecond(2.5 * 1024 * 1024)).toBe("2.5 MB/s");
  });
});

describe("createSystemSampler", () => {
  it("meldet das Netz erst ab dem zweiten Messpunkt und übersteht ein fehlendes /proc", async () => {
    let bytes = 1000;
    const sampler = createSystemSampler(async () => {
      bytes += 4096;
      return `eth0: ${bytes} 1 0 0 0 0 0 0 ${bytes} 1 0 0 0 0 0 0`;
    });
    const first = await sampler.snapshot();
    expect(first.netBytesPerSecond).toBeNull();
    expect(first.ramPercent).toBeGreaterThan(0);
    expect(first.diskPercent).toBeGreaterThanOrEqual(0);
    // Zwei Messpunkte in derselben Millisekunde ergeben keine Rate (Division durch null
    // Sekunden, siehe `netBytesPerSecondBetween`) — das ist richtig so und war hier der
    // Grund für einen Test, der unter Last gelegentlich rot wurde. Also echte Zeit vergehen
    // lassen, statt die Rate ohne Zeitbasis zu erwarten.
    await new Promise((fertig) => setTimeout(fertig, 2));
    const second = await sampler.snapshot();
    expect(second.netBytesPerSecond).not.toBeNull();

    const without = createSystemSampler(async () => {
      throw new Error("ENOENT");
    });
    expect((await without.snapshot()).netBytesPerSecond).toBeNull();
  });
});
