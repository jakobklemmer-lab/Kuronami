/**
 * Einmalig am 28.09.2026: DEMA + SuperTrend (TradingLab, `g-PLctW8aU0`) als Strategie ablegen und
 * mit dem Werkzeug des Prüfers gegenprüfen.
 *
 * Herkunft: Die Nachrechnung aller Videos (28.09. mittags) und ihre Wiederholung ohne Kosten
 * zeigten eine Kante nur hier — auf Krypto, 1h, long. Gefunden wurde sie also in einem Suchlauf
 * über rund 1.200 Varianten, nicht vorher festgelegt. Abgelegt wird der Hauptweg des Videos
 * (SuperTrend dreht auf Kauf, Kurs über der DEMA 200): mit 0,30 % Kosten +0,14 R über 2.652
 * Handel auf sechs Märkten; der zweite Weg (Kreuzung der DEMA nach dem Signal) brachte nur
 * +0,06 R und ist nicht dabei.
 *
 * **Die Sichtgrenze ist heute, nicht die Sperrgrenze.** Die Suche hat alle Kurse bis gestern
 * gesehen; eine Schlussprobe auf April bis September wäre deshalb keine. Ihre Schlussprobe
 * beginnt am 28.09. und wächst mit jedem Tag — bei rund 400 Handeln im Jahr über die sechs
 * Märkte hat sie nach etwa vier Wochen die 30 Handel für ein Urteil.
 *
 *   npx tsx bau/supertrend-ablegen.ts
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { backtest, formatiereBacktest } from "../gateway/backtest.js";
import { SUPERTREND_VIDEO } from "../gateway/kalibrierung.js";
import { createKerzenquelle } from "../gateway/kerzen.js";
import { createLabor } from "../gateway/labor.js";
import { KRYPTO } from "../gateway/nachrechnung.js";
import { type UniversumVermerk, createStrategien } from "../gateway/strategien.js";
import { formatiereUniversum, ueberMaerkte } from "../gateway/universum.js";
import {
  createVersuchsbuch,
  formatiereVersuch,
  regelSchluessel,
  zAusIntervall,
  zWert,
} from "../gateway/versuche.js";

const WORKDIR = "/opt/kuronami/workspace";
const GESEHEN_BIS = "2026-09-28";
const VON = "2020-01-01";

const hauptweg = SUPERTREND_VIDEO.teile.find(
  (t) => t.strategie.richtung === "long" && t.teil.includes("SuperTrend-Signal"),
);
if (!hauptweg) throw new Error("Hauptweg nicht gefunden.");
const strategie = { ...hauptweg.strategie };

const quelle = createKerzenquelle({ workdir: WORKDIR });
const [heimat, ...weitere] = KRYPTO;
const reihen = [];
for (const symbol of KRYPTO) {
  const { kerzen } = await quelle.hole({
    symbol,
    intervall: "1h",
    vonUnix: Math.floor(Date.parse(`${VON}T00:00:00Z`) / 1000),
    bisUnix: Math.floor(Date.parse(`${GESEHEN_BIS}T00:00:00Z`) / 1000),
    nurSpeicher: true,
  });
  reihen.push({ symbol, kerzen });
}

const ergebnis = backtest(strategie, reihen[0].kerzen, { symbol: heimat, intervall: "1h" });
const universum = ueberMaerkte(strategie, reihen, { intervall: "1h" });
const vermerk: UniversumVermerk = {
  einstufung: universum.einstufung,
  maerkte: universum.gerechnet,
  gesamtHandel: universum.gesamtHandel,
  gemeinsamErwartungswertR: universum.gemeinsamErwartungswertR,
  ...(universum.gemeinsam ? { gemeinsam: universum.gemeinsam } : {}),
  begruendung: universum.begruendung,
};

const buch = createVersuchsbuch({ workdir: WORKDIR });
// Der Vergleich der beiden Einstiegswege einzeln — die Nachrechnung hatte sie nur zusammen.
await buch.zaehle({
  wer: "nachtrag",
  werkzeug: "nachtrag",
  schluessel: "nachtrag:supertrend-einstiegswege-2026-09-28",
  name: "SuperTrend Krypto 1h long: Hauptweg und DEMA-Kreuzung einzeln",
  varianten: 2,
});
const z = Math.max(
  zWert(ergebnis.handel.map((h) => h.r)),
  universum.gemeinsam ? zAusIntervall(universum.gemeinsamErwartungswertR, universum.gemeinsam) : 0,
);
const stand = await buch.zaehle({
  wer: "claude-code",
  werkzeug: "ablage",
  schluessel: regelSchluessel(strategie, KRYPTO, "1h"),
  name: strategie.name,
  varianten: 1,
  anzahl: universum.gesamtHandel,
  erwartungswertR: universum.gemeinsamErwartungswertR,
  z,
});

const archiv = createStrategien({ workdir: WORKDIR });
const kopf = await archiv.lege({
  name: `${strategie.name} — Krypto 1h`,
  wer: "claude-code",
  symbol: heimat,
  intervall: "1h",
  von: ergebnis.von,
  bis: ergebnis.bis,
  strategie,
  kennzahlen: ergebnis.gesamt,
  inSample: ergebnis.inSample,
  outOfSample: ergebnis.outOfSample,
  warnungstexte: ergebnis.warnungen,
  bericht: [
    formatiereBacktest(ergebnis),
    formatiereUniversum(universum),
    formatiereVersuch(stand, z),
  ].join("\n\n"),
  universum: vermerk,
  gesehenBis: GESEHEN_BIS,
  maerkte: weitere,
  versuch: { nr: stand.versuche, z, huerde: stand.huerde, haelt: z > stand.huerde },
});
await archiv.aendere(kopf.id, {
  notiz: [
    "Abgelegt von Claude Code am 28.09.2026 (bau/supertrend-ablegen.ts), auf Jakobs Wunsch: „SuperTrend durch den Prüfer und dann in den Papierhandel“.",
    "Gefunden in der Nachrechnung der TradingLab-Videos — in einem Suchlauf über rund 1.200 Varianten, nicht vorher festgelegt. Deshalb liegt die Sichtgrenze auf dem 28.09.: alle Kurse bis dahin sind gesehen, die Schlussprobe beginnt ab dann und hat nach etwa vier Wochen genug Handel.",
  ].join("\n\n"),
});
console.log(`Abgelegt als ${kopf.id} — Status ${kopf.status}.`);
console.log(formatiereVersuch(stand, z));

// Die Gegenprobe mit dem Werkzeug des Prüfers selbst, über einen MCP-Client — keine Nachbildung.
// Das MCP-SDK ist nur als Abhängigkeit des Agent-SDK installiert; geladen wird es von dort.
const ausSdk = createRequire(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
const { Client } = ausSdk("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = ausSdk("@modelcontextprotocol/sdk/inMemory.js");
const labor = createLabor({ workdir: WORKDIR, strategien: archiv, wer: "claude-code" });
const [clientSeite, serverSeite] = InMemoryTransport.createLinkedPair();
await labor.instance.connect(serverSeite);
const client = new Client({ name: "supertrend-ablegen", version: "1" });
await client.connect(clientSeite);
const antwort = await client.callTool({ name: "gegenprobe", arguments: { id: kopf.id } });
for (const teil of antwort.content as { type: string; text?: string }[]) console.log(teil.text);
await client.close();
