import type { Express, NextFunction, Request, Response } from "express";
import { AlarmFehler, type AlarmeAblage } from "./alarme.js";
import type { AnalysenArchiv } from "./analysen.js";
import { StrategieFehler } from "./backtest.js";
import { type Chartdaten, IndikatorFehler, istIntervall, leseIndikatoren } from "./chartdaten.js";
import { CrvEingabeFehler, formatiereCrv, rechneCrv } from "./crv.js";
import {
  type ChartInterval,
  type MarketChart,
  MarketDataError,
  type MarketsClient,
  isValidSymbol,
} from "./integrations/markets.js";
import type { Kerzenquelle } from "./kerzen.js";
import type { Papierhandel } from "./papierhandel.js";
import { PrognoseFehler, type Prognosenbuch } from "./prognosen.js";
import { strategieImChart } from "./strategie-chart.js";
import type { StrategienArchiv } from "./strategien.js";
import { ZeichnungFehler, type ZeichnungenAblage } from "./zeichnungen.js";

/**
 * Die Wege des Charts in den Märkten (2026-09-27). Eigene Datei, weil es acht sind und sie
 * zusammengehören: Kerzen und Kennzahlen lesen, Zeichnungen und Alarme ablegen, eine Idee
 * durchrechnen und ins Prognosebuch legen. Der Rand bleibt Rand — geprüft wird im Modul
 * dahinter, hier wird nur ausgepackt und übersetzt.
 */

export interface ChartRoutenDeps {
  chartdaten?: Chartdaten;
  markets?: MarketsClient;
  zeichnungen?: ZeichnungenAblage;
  alarme?: AlarmeAblage;
  /** Das Prognosebuch sitzt im Motor; gefragt wird erst beim Aufruf. */
  prognosen?: () => Prognosenbuch | undefined;
  /** Die Archive des Handelstischs — für „Kuros Arbeit" im Chart. */
  strategien?: () => StrategienArchiv | undefined;
  analysen?: () => AnalysenArchiv | undefined;
  papier?: () => Papierhandel | undefined;
  /** Dieselbe Kerzenquelle wie im Labor, damit ein Neulauf auf denselben Kerzen steht. */
  kerzenquelle?: Kerzenquelle;
}

/** `yahoo:^GDAXI` und `^GDAXI` sind derselbe Wert; `binance:BTCUSDT` ist ein anderer. */
function gleichesSymbol(a: string, b: string): boolean {
  const ohne = (x: string) => x.replace(/^yahoo:/i, "").toUpperCase();
  return ohne(a) === ohne(b);
}

/**
 * Was eine Analyse im Chart zeigen kann (2026-09-27).
 *
 * Eine Analyse ist Fließtext und trägt kein Symbol. Aber sie ist das Ergebnis **eines Laufs**,
 * und was dieser Lauf abgelegt hat — Ideen im Prognosebuch, Strategien im Archiv —, trägt
 * eins. Die Verbindung ist das Zeitfenster des Laufs (Ablage minus Dauer bis Ablage) und der
 * Verfasser, nicht eine Deutung des Textes. Die Idee vom 22.09. um 06:39:38 stammt so aus dem
 * Lauf, der um 06:39 seine Analyse ablegte; ein `analyseId` stand nicht darin, weil die Idee
 * während des Laufs entsteht und die Analyse erst an seinem Ende.
 *
 * Nur wenn der Lauf nichts abgelegt hat, wird im Titel nach einem Yahoo-Kürzel gesucht —
 * „Bitcoin (BTC-USD)" —, und das nur in eindeutiger Form.
 */
export function bezugDerAnalyse(
  analyse: { id: string; zeit: string; wer: string; dauerMs: number; titel: string },
  prognosen: readonly {
    id: string;
    angelegt: string;
    von: string;
    symbol: string;
    analyseId?: string;
  }[],
  strategien: readonly { id: string; zeit: string; symbol: string }[],
): { symbol: string | null; prognosen: string[]; strategien: string[] } {
  const ende = Date.parse(analyse.zeit);
  const anfang = ende - Math.max(analyse.dauerMs, 0) - 60_000;
  const imLauf = (zeit: string) => {
    const t = Date.parse(zeit);
    return Number.isFinite(t) && t >= anfang && t <= ende + 60_000;
  };
  const ideen = prognosen.filter(
    (p) =>
      p.analyseId === analyse.id || (!p.analyseId && p.von === analyse.wer && imLauf(p.angelegt)),
  );
  const regeln = strategien.filter((s) => imLauf(s.zeit));
  let symbol: string | null = ideen[0]?.symbol ?? regeln[0]?.symbol ?? null;
  if (!symbol) {
    const treffer =
      /(\^[A-Z0-9.]{2,10}|\b[A-Z0-9]{2,6}-(?:USD|EUR)\b|\b[A-Z]{1,3}=F\b|\b[A-Z]{6}=X\b)/.exec(
        analyse.titel,
      );
    symbol = treffer?.[1] ?? null;
  }
  return { symbol, prognosen: ideen.map((p) => p.id), strategien: regeln.map((s) => s.id) };
}

/** Nennt ein Text den Wert — als Kürzel oder als ganzes Wort seines Namens? */
export function erwaehnt(text: string, symbol: string, name: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(symbol.toLowerCase())) return true;
  const n = name.trim().toLowerCase();
  if (n.length < 2) return false;
  const muster = new RegExp(
    `(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
    "u",
  );
  return muster.test(t);
}

type Ausweis = (req: Request, res: Response) => unknown | null;

function zahlAus(wert: unknown): number | undefined {
  if (typeof wert === "number" && Number.isFinite(wert)) return wert;
  if (typeof wert === "string" && wert.trim() !== "") {
    const n = Number(wert);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Fehler, die der Aufrufer verursacht hat, als 400; fremde Dienste als 502; der Rest weiter. */
function fehler(error: unknown, res: Response, next: NextFunction): void {
  if (
    error instanceof IndikatorFehler ||
    error instanceof ZeichnungFehler ||
    error instanceof AlarmFehler ||
    error instanceof CrvEingabeFehler ||
    error instanceof PrognoseFehler ||
    error instanceof StrategieFehler
  ) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof MarketDataError) {
    res.status(502).json({ error: error.message });
    return;
  }
  next(error);
}

function fehlt(res: Response, was: string): void {
  res.status(404).json({ error: `${was} ist auf diesem Gateway nicht eingerichtet.` });
}

function symbolAus(req: Request, res: Response): string | null {
  const roh = req.query.symbol ?? req.body?.symbol;
  const symbol = typeof roh === "string" ? roh.trim() : "";
  if (!isValidSymbol(symbol)) {
    res.status(400).json({ error: `Ungültiges Symbol "${symbol}".` });
    return null;
  }
  return symbol;
}

export function chartRouten(app: Express, deps: ChartRoutenDeps, ausweis: Ausweis): void {
  app.get("/integrations/markets/kerzen", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.chartdaten) return fehlt(res, "Der Chart");
      const symbol = symbolAus(req, res);
      if (!symbol) return;
      const intervall = typeof req.query.intervall === "string" ? req.query.intervall : "1d";
      if (!istIntervall(intervall)) {
        res.status(400).json({ error: `Unbekannte Kerzengröße "${intervall}".` });
        return;
      }
      const indikatoren = leseIndikatoren(typeof req.query.ind === "string" ? req.query.ind : "");
      res.json(
        await deps.chartdaten.lade({
          symbol,
          intervall,
          indikatoren,
          ab: zahlAus(req.query.ab),
          bis: zahlAus(req.query.bis),
          anzahl: zahlAus(req.query.anzahl),
        }),
      );
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.get("/integrations/markets/kennzahlen", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.chartdaten) return fehlt(res, "Der Chart");
      const symbol = symbolAus(req, res);
      if (!symbol) return;
      res.json(await deps.chartdaten.kennzahlen(symbol));
    } catch (error) {
      fehler(error, res, next);
    }
  });

  // --------------------------------------------------------------------- Zeichnungen

  app.get("/integrations/markets/zeichnungen", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.zeichnungen) return fehlt(res, "Die Zeichnungsablage");
      const symbol = symbolAus(req, res);
      if (!symbol) return;
      res.json(await deps.zeichnungen.lies(symbol));
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.put("/integrations/markets/zeichnungen", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.zeichnungen) return fehlt(res, "Die Zeichnungsablage");
      const symbol = symbolAus(req, res);
      if (!symbol) return;
      res.json(await deps.zeichnungen.schreibe(symbol, req.body?.zeichnungen));
    } catch (error) {
      fehler(error, res, next);
    }
  });

  // --------------------------------------------------------------------- Alarme

  app.get("/integrations/markets/alarme", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.alarme) return fehlt(res, "Die Alarmablage");
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
      const alle = await deps.alarme.liste();
      res.json({ alarme: symbol ? alle.filter((a) => a.symbol === symbol) : alle });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.post("/integrations/markets/alarme", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.alarme || !deps.markets) return fehlt(res, "Die Alarmablage");
      const symbol = symbolAus(req, res);
      if (!symbol) return;
      const preis = zahlAus(req.body?.preis);
      if (preis === undefined) {
        res.status(400).json({ error: "preis (Zahl) ist erforderlich." });
        return;
      }
      // Die Richtung kommt aus dem Kurs von jetzt — also wird er hier geholt, nicht geglaubt.
      const { quotes } = await deps.markets.quotes([symbol]);
      const kurs = quotes[0]?.price;
      if (kurs === undefined) {
        res
          .status(502)
          .json({ error: `Kein aktueller Kurs für ${symbol} — ohne ihn keine Richtung.` });
        return;
      }
      const alarm = await deps.alarme.lege({
        symbol,
        name: typeof req.body?.name === "string" ? req.body.name.slice(0, 80) : quotes[0]?.name,
        preis,
        kurs,
        notiz: typeof req.body?.notiz === "string" ? req.body.notiz : undefined,
      });
      res.status(201).json(alarm);
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.delete("/integrations/markets/alarme/:id", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.alarme) return fehlt(res, "Die Alarmablage");
      const weg = await deps.alarme.loesche(req.params.id);
      if (!weg) {
        res.status(404).json({ error: "Diesen Alarm gibt es nicht." });
        return;
      }
      res.json({ geloescht: true });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.post("/integrations/markets/alarme/:id/scharf", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      if (!deps.alarme || !deps.markets) return fehlt(res, "Die Alarmablage");
      const alarm = (await deps.alarme.liste()).find((a) => a.id === req.params.id);
      if (!alarm) {
        res.status(404).json({ error: "Diesen Alarm gibt es nicht." });
        return;
      }
      const { quotes } = await deps.markets.quotes([alarm.symbol]);
      const kurs = quotes[0]?.price;
      if (kurs === undefined) {
        res.status(502).json({ error: `Kein aktueller Kurs für ${alarm.symbol}.` });
        return;
      }
      res.json(await deps.alarme.scharf(alarm.id, kurs));
    } catch (error) {
      fehler(error, res, next);
    }
  });

  // --------------------------------------------------------------------- CRV und Prognosen

  /**
   * Die Rechnung zur Positionsidee im Chart — dieselbe wie das Werkzeug `crv` des
   * Handelstischs, mit denselben Tageskerzen (sechs Monate) für ATR und 52-Wochen-Lage.
   * Jakobs Regel gilt auch hier: das CRV wird gerechnet, nicht geschätzt.
   */
  app.post("/integrations/markets/crv", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      const b = req.body ?? {};
      const ziele = Array.isArray(b.ziele) ? b.ziele.map(zahlAus) : [];
      const ergebnis = rechneCrv({
        richtung: b.richtung === "short" ? "short" : "long",
        einstieg: zahlAus(b.einstieg) ?? Number.NaN,
        stop: zahlAus(b.stop) ?? Number.NaN,
        ziele: ziele.map((z: number | undefined) => z ?? Number.NaN),
        kapital: zahlAus(b.kapital),
        risikoProzent: zahlAus(b.risikoProzent),
      });
      let chart: MarketChart | undefined;
      let hinweis: string | undefined;
      if (typeof b.symbol === "string" && isValidSymbol(b.symbol) && deps.markets) {
        try {
          chart = await deps.markets.chart(b.symbol, "6mo", "1d");
        } catch (error) {
          hinweis = `Kursverlauf nicht abrufbar: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      res.json({
        ergebnis,
        text: formatiereCrv(ergebnis, { chart }),
        ...(hinweis ? { hinweis } : {}),
      });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  app.get("/integrations/prognosen", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      const buch = deps.prognosen?.();
      if (!buch) return fehlt(res, "Das Prognosebuch");
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
      const alle = await buch.liste();
      const passend = symbol ? alle.filter((p) => p.symbol.toUpperCase() === symbol) : alle;
      // Der Stand kommt aus den Kerzen (`pruefe`), nicht aus einer gespeicherten Zeile — so
      // steht im Chart dasselbe, was die Akte des Analysten sagt.
      const mitStand = await Promise.all(
        passend.slice(-40).map(async (prognose) => {
          try {
            const benotung = await buch.pruefe(prognose.id);
            return { prognose, verlauf: benotung?.verlauf ?? null, noten: benotung?.noten ?? [] };
          } catch (error) {
            return {
              prognose,
              verlauf: null,
              noten: [],
              fehler: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      res.json({ prognosen: mitStand });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  /** Jakobs eigene Idee ins Prognosebuch — verfolgt von Code, benotet wie jede andere. */
  app.post("/integrations/prognosen", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      const buch = deps.prognosen?.();
      if (!buch) return fehlt(res, "Das Prognosebuch");
      const symbol = symbolAus(req, res);
      if (!symbol) return;
      const b = req.body ?? {};
      const ziele = (Array.isArray(b.ziele) ? b.ziele : [])
        .map(zahlAus)
        .filter((z: number | undefined): z is number => z !== undefined);
      const ausloeser = zahlAus(b.ausloeser);
      const stop = zahlAus(b.stop);
      if (ausloeser === undefined || stop === undefined || ziele.length === 0) {
        res
          .status(400)
          .json({ error: "ausloeser, stop und mindestens ein Ziel sind erforderlich." });
        return;
      }
      const text = (w: unknown, max: number) =>
        typeof w === "string" && w.trim() ? w.trim().slice(0, max) : undefined;
      const prognose = await buch.lege({
        von: "jakob",
        symbol,
        richtung: b.richtung === "short" ? "short" : "long",
        ausloeser,
        stop,
        ziele: ziele.slice(0, 3),
        ...(zahlAus(b.fristTage)
          ? { fristTage: Math.min(Math.max(zahlAus(b.fristTage) as number, 1), 365) }
          : {}),
        ...(text(b.these, 2000) ? { these: text(b.these, 2000) } : {}),
        ...(text(b.widerlegtWenn, 1000) ? { widerlegtWenn: text(b.widerlegtWenn, 1000) } : {}),
      });
      res.status(201).json(prognose);
    } catch (error) {
      fehler(error, res, next);
    }
  });

  // --------------------------------------------------------------------- Kuros Arbeit

  /**
   * Was das Haus zu einem Wert erarbeitet hat: Strategien auf diesem Wert, Analysen, die ihn
   * nennen, und laufender Papierhandel. Die Einzelideen kommen über `/integrations/prognosen`,
   * weil sie ihren Stand aus den Kerzen brauchen.
   */
  app.get("/integrations/markets/arbeit", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      const symbol = symbolAus(req, res);
      if (!symbol) return;
      const name = typeof req.query.name === "string" ? req.query.name.slice(0, 60) : "";
      const [strategien, analysen, papier] = await Promise.all([
        deps.strategien?.()?.liste(200) ?? [],
        deps.analysen?.()?.liste(200) ?? [],
        deps.papier?.()?.liste() ?? [],
      ]);
      res.json({
        strategien: strategien.filter((s) => gleichesSymbol(s.symbol, symbol)),
        analysen: analysen
          .filter((a) => erwaehnt(`${a.titel}\n${a.auftrag}`, symbol, name))
          .slice(0, 20),
        papier: papier
          .filter((k) => gleichesSymbol(k.symbol, symbol))
          .map((k) => ({
            strategieId: k.strategieId,
            name: k.name,
            seit: k.seit,
            handel: k.handel.length,
            offen: k.offen !== null,
            gesperrt: k.gesperrt,
          })),
      });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  /** Eine Strategie im Chart: ihre Handel, neu gerechnet, samt der Zeit seit der Ablage. */
  app.get("/integrations/strategien/:id/chart", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      const archiv = deps.strategien?.();
      if (!archiv || !deps.kerzenquelle) return fehlt(res, "Das Strategie-Archiv");
      const eintrag = await archiv.lies(req.params.id);
      if (!eintrag) {
        res.status(404).json({ error: "Diese Strategie gibt es nicht." });
        return;
      }
      const vonUnix = Math.floor(Date.parse(`${eintrag.von}T00:00:00Z`) / 1000);
      const geholt = await deps.kerzenquelle.hole({
        symbol: eintrag.symbol,
        intervall: eintrag.intervall as ChartInterval,
        vonUnix,
        bisUnix: Math.floor(Date.now() / 1000) + 86_400,
      });
      const bild = strategieImChart(eintrag, geholt.kerzen);
      const konto = (await deps.papier?.()?.liste())?.find((k) => k.strategieId === eintrag.id);
      res.json({
        ...bild,
        papier: konto
          ? { seit: konto.seit, handel: konto.handel, offen: konto.offen, gesperrt: konto.gesperrt }
          : null,
      });
    } catch (error) {
      fehler(error, res, next);
    }
  });

  /** Welcher Wert und welche Ideen und Strategien zu einer Analyse gehören — für „Im Chart zeigen". */
  app.get("/integrations/analysen/:id/bezug", async (req, res, next) => {
    try {
      if (!ausweis(req, res)) return;
      const archiv = deps.analysen?.();
      if (!archiv) return fehlt(res, "Das Analysen-Archiv");
      const analyse = await archiv.lies(req.params.id);
      if (!analyse) {
        res.status(404).json({ error: "Diese Analyse gibt es nicht." });
        return;
      }
      const [prognosen, strategien] = await Promise.all([
        deps.prognosen?.()?.liste() ?? [],
        deps.strategien?.()?.liste(200) ?? [],
      ]);
      res.json(bezugDerAnalyse(analyse, prognosen, strategien));
    } catch (error) {
      fehler(error, res, next);
    }
  });
}
