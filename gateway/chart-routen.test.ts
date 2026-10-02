import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlarme } from "./alarme.js";
import { createWebChannel } from "./channels/web.js";
import { createChartdaten } from "./chartdaten.js";
import type { GatewayDeps } from "./core.js";
import type { GatewayIdentity } from "./identity.js";
import type { MarketChart, MarketsClient } from "./integrations/markets.js";
import type { Prognose, Prognosenbuch } from "./prognosen.js";
import { createServer } from "./server.js";
import { createZeichnungen } from "./zeichnungen.js";

/**
 * Die Wege des Charts gegen den echten Server — mit einem Markt aus dem Arbeitsspeicher, einer
 * Ablage im Temp-Ordner und einem Prognosebuch, das nur mitschreibt. Geprüft wird, dass Rand,
 * Ausweis und Übersetzung der Fehler zusammenpassen; die Rechnungen prüfen ihre eigenen Tests.
 */

const TOKEN = "test-token";
const identity: GatewayIdentity = {
  userId: "kuronami",
  webToken: TOKEN,
  telegramSecret: "",
  telegramUserIds: [],
  voiceToken: "",
  voiceSessionToken: "",
};
const kopfzeilen = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** Eine Antwort als lose Form — die Typen prüft der Rest des Hauses, hier nur die Werte. */
// biome-ignore lint/suspicious/noExplicitAny: Antworten des Servers, geprüft über ihre Werte
type Lose = any;
const lies = async (r: Response): Promise<Lose> => (await r.json()) as Lose;

const t0 = 1_790_000_000;
const markets: MarketsClient = {
  search: async () => [],
  quotes: async (symbole) => ({
    quotes: symbole.map((symbol) => ({
      symbol,
      name: "DAX",
      currency: "EUR",
      exchange: "XETRA",
      price: 25408,
      change: 0,
      changePct: 0,
      spark: [],
    })),
    failed: [],
  }),
  chart: async (): Promise<MarketChart> => ({
    symbol: "^GDAXI",
    name: "DAX",
    currency: "EUR",
    exchange: "XETRA",
    price: 25408,
    change: 0,
    changePct: 0,
    spark: [],
    range: "6mo",
    interval: "1d",
    candles: Array.from({ length: 30 }, (_, i) => ({
      time: t0 + i * 86400,
      open: 25000,
      high: 25200,
      low: 24900,
      close: 25100,
    })),
  }),
  zeitraum: async (_s, von, bis, interval): Promise<MarketChart> => ({
    symbol: "^GDAXI",
    name: "DAX",
    currency: "EUR",
    exchange: "XETRA",
    price: 25408,
    change: 0,
    changePct: 0,
    spark: [],
    range: "",
    interval,
    candles: Array.from({ length: 400 }, (_, i) => ({
      time: t0 + i * 300,
      open: 100,
      high: 101,
      low: 99,
      close: 100 + (i % 5),
    })).filter((k) => k.time >= von && k.time < bis),
  }),
};

const gelegt: Prognose[] = [];
const buch = {
  lege: async (e: Omit<Prognose, "id" | "angelegt" | "fristTage">) => {
    const p = { ...e, id: "p1", angelegt: "2026-09-27T08:00:00Z", fristTage: 30 } as Prognose;
    gelegt.push(p);
    return p;
  },
  liste: async () => gelegt,
  pruefe: async () => null,
} as unknown as Prognosenbuch;

let server: Server;
let basis = "";

beforeAll(async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "chart-routen-"));
  const app = createServer({
    gateway: { agent: { prognosen: buch } } as unknown as GatewayDeps,
    identity,
    web: createWebChannel(),
    markets,
    chartdaten: createChartdaten({ markets, jetzt: () => t0 + 400 * 300 }),
    zeichnungen: createZeichnungen({ workdir }),
    alarme: createAlarme({ workdir }),
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const adresse = server.address();
  basis = `http://127.0.0.1:${typeof adresse === "object" && adresse ? adresse.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("Kerzen", () => {
  it("verlangt einen Ausweis", async () => {
    const r = await fetch(`${basis}/integrations/markets/kerzen?symbol=%5EGDAXI&intervall=5m`);
    expect(r.status).toBe(401);
  });

  it("liefert Drahtkerzen mit Indikatoren", async () => {
    const r = await fetch(
      `${basis}/integrations/markets/kerzen?symbol=%5EGDAXI&intervall=5m&ind=sma:20&anzahl=100`,
      { headers: kopfzeilen },
    );
    expect(r.status).toBe(200);
    const j = await lies(r);
    expect(j.intervall).toBe("5m");
    expect(j.kerzen).toHaveLength(100);
    expect(j.kerzen[0]).toHaveLength(5);
    expect(j.indikatoren[0].id).toBe("sma:20");
    expect(j.mehr).toBe(true);
  });

  it("weist eine unbekannte Kerzengröße und einen unbekannten Indikator mit 400 ab", async () => {
    const a = await fetch(`${basis}/integrations/markets/kerzen?symbol=%5EGDAXI&intervall=2h`, {
      headers: kopfzeilen,
    });
    const b = await fetch(
      `${basis}/integrations/markets/kerzen?symbol=%5EGDAXI&intervall=1h&ind=zauber`,
      { headers: kopfzeilen },
    );
    expect([a.status, b.status]).toEqual([400, 400]);
  });
});

describe("Zeichnungen", () => {
  it("legt ab und liest zurück; Unsinn gibt 400", async () => {
    const put = await fetch(`${basis}/integrations/markets/zeichnungen?symbol=%5EGDAXI`, {
      method: "PUT",
      headers: kopfzeilen,
      body: JSON.stringify({ zeichnungen: [{ id: "h1", art: "horizontal", preis: 25600 }] }),
    });
    expect(put.status).toBe(200);
    const get = await lies(
      await fetch(`${basis}/integrations/markets/zeichnungen?symbol=%5EGDAXI`, {
        headers: kopfzeilen,
      }),
    );
    expect(get.zeichnungen).toEqual([{ id: "h1", art: "horizontal", preis: 25600 }]);
    const falsch = await fetch(`${basis}/integrations/markets/zeichnungen?symbol=%5EGDAXI`, {
      method: "PUT",
      headers: kopfzeilen,
      body: JSON.stringify({ zeichnungen: [{ id: "x", art: "zauber" }] }),
    });
    expect(falsch.status).toBe(400);
  });
});

describe("Alarme", () => {
  it("nimmt die Richtung aus dem Kurs von jetzt", async () => {
    const r = await fetch(`${basis}/integrations/markets/alarme`, {
      method: "POST",
      headers: kopfzeilen,
      body: JSON.stringify({ symbol: "^GDAXI", preis: 25000 }),
    });
    expect(r.status).toBe(201);
    const alarm = await lies(r);
    expect(alarm).toMatchObject({ richtung: "unter", kursBeimAnlegen: 25408, status: "aktiv" });
    const liste = await lies(
      await fetch(`${basis}/integrations/markets/alarme?symbol=%5Egdaxi`, { headers: kopfzeilen }),
    );
    expect(liste.alarme).toHaveLength(1);
    const weg = await fetch(`${basis}/integrations/markets/alarme/${alarm.id}`, {
      method: "DELETE",
      headers: kopfzeilen,
    });
    expect(weg.status).toBe(200);
  });
});

describe("CRV und Prognosen", () => {
  it("rechnet, und weist einen Stop auf der falschen Seite ab", async () => {
    const gut = await lies(
      await fetch(`${basis}/integrations/markets/crv`, {
        method: "POST",
        headers: kopfzeilen,
        body: JSON.stringify({
          symbol: "^GDAXI",
          richtung: "long",
          einstieg: 100,
          stop: 95,
          ziele: [110],
        }),
      }),
    );
    expect(gut.ergebnis.ziele[0].crv).toBe(2);
    expect(gut.text).toContain("2,00:1");
    const falsch = await fetch(`${basis}/integrations/markets/crv`, {
      method: "POST",
      headers: kopfzeilen,
      body: JSON.stringify({ richtung: "long", einstieg: 100, stop: 105, ziele: [110] }),
    });
    expect(falsch.status).toBe(400);
  });

  it("legt Jakobs Idee als seine ins Prognosebuch", async () => {
    const r = await fetch(`${basis}/integrations/prognosen`, {
      method: "POST",
      headers: kopfzeilen,
      body: JSON.stringify({
        symbol: "^GDAXI",
        richtung: "long",
        ausloeser: 25450,
        stop: 25200,
        ziele: [25950],
        von: "boerse",
      }),
    });
    expect(r.status).toBe(201);
    expect(gelegt[0]).toMatchObject({ von: "jakob", symbol: "^GDAXI", ziele: [25950] });
  });
});

describe("Preflight", () => {
  it("lässt jede Methode zu, die diese Wege benutzen — auch PUT", async () => {
    const r = await fetch(`${basis}/integrations/markets/zeichnungen?symbol=%5EGDAXI`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3001", "access-control-request-method": "PUT" },
    });
    expect(r.status).toBe(204);
    const erlaubt = r.headers.get("access-control-allow-methods") ?? "";
    for (const m of ["GET", "POST", "PUT", "DELETE"]) expect(erlaubt).toContain(m);
  });
});
