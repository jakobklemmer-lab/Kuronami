import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  type Bedingung,
  type Strategie,
  StrategieFehler,
  backtest,
  formatiereBacktest,
} from "./backtest.js";
import { formatiereGegenprobe, nachbarschaft, pruefeVariante, urteile } from "./gegenprobe.js";
import {
  CHART_INTERVALS,
  type ChartInterval,
  type MarketsClient,
  createYahooMarkets,
} from "./integrations/markets.js";
import { formatiereVerlauf } from "./kurse.js";
import { PapierFehler, type Papierhandel, papierKennzahlen } from "./papierhandel.js";
import {
  ReplayFehler,
  formatiereKerzen,
  formatiereStand,
  handeln,
  hole,
  schreibeTagebuch,
  sichtbar,
  starte,
  stellGlatt,
  weiter,
} from "./replay.js";
import { formatiereRueckblick, werteIdeeAus } from "./rueckblick.js";
import type { StrategienArchiv } from "./strategien.js";

/**
 * Das Labor des Handelstischs: Vergangenheit ohne Zukunft, Rückblick auf alte Ideen,
 * Backtest von Strategien, Ablage des Geprüften.
 *
 * Warum es diesen Server gibt, in Jakobs Worten: „Das Wichtigste ist, dass ich zu 100 % darauf
 * vertrauen kann, was mir das Markets-Team meldet. Das bedeutet, dass sie die Möglichkeit haben
 * müssen, alles nachrechnen zu können, alles verlässlich prüfen zu können… Auch wichtig wäre
 * das Entwickeln und Backtesten von schlüssigen Strategien."
 *
 * Er ist **vom Gesindehaus getrennt** und steht nur dem Handelstisch offen. Kuro soll ihn nicht
 * kennen: ein Butler, der selbst Strategien backtestet, ist kein Butler mehr — und jedes
 * Werkzeugschema in seinem Katalog kostet bei jeder Nachricht Token.
 */

export interface LaborDeps {
  markets?: MarketsClient;
  /** Wohin die Replay-Tagebücher geschrieben werden. Ohne Pfad wird keins geschrieben. */
  workdir?: string;
  /** Ohne Archiv gibt es die drei Ablage-Werkzeuge nicht. */
  strategien?: StrategienArchiv;
  /** Wer gerade arbeitet — steht als Urheber an einer abgelegten Strategie. */
  wer?: string;
  /** Der Papierhandel. Ohne ihn fehlen die beiden Betriebs-Werkzeuge. */
  papier?: Papierhandel;
  /** Darf dieser Lauf den Papierhandel **starten**? Lesen darf jeder, der ihn hat. */
  darfStarten?: boolean;
}

const TAG = /^\d{4}-\d{2}-\d{2}$/;

function unix(datum: string): number {
  return Math.floor(new Date(`${datum}T00:00:00Z`).getTime() / 1000);
}

function heute(): string {
  return new Date().toISOString().slice(0, 10);
}

function tagVon(unixSekunden: number): string {
  return new Date(unixSekunden * 1000).toISOString().slice(0, 10);
}

/** Das Zod-Schema einer Bedingung — dieselbe Form wie `Bedingung` in `backtest.ts`. */
const indikator = z.object({
  art: z
    .enum([
      "kurs",
      "wert",
      "sma",
      "ema",
      "rsi",
      "atr",
      "hoch",
      "tief",
      "stdabw",
      "macd",
      "macd_signal",
      "macd_histogramm",
      "adx",
      "di_plus",
      "di_minus",
      "stoch_k",
      "stoch_d",
      "bollinger_oben",
      "bollinger_mitte",
      "bollinger_unten",
      "bollinger_breite",
      "obv",
    ])
    .describe(
      "Trend: sma, ema, macd, macd_signal, macd_histogramm, adx (mit di_plus/di_minus). " +
        "Momentum: rsi, stoch_k, stoch_d. Volatilität: atr, stdabw, bollinger_oben/mitte/unten/breite. " +
        "Volumen: obv (fehlt bei Indizes und Devisen). Dazu kurs (die Kerze selbst), wert (eine Zahl), " +
        "hoch/tief (rollendes Hoch/Tief ohne die aktuelle Kerze).",
    ),
  periode: z.number().int().positive().max(500).optional(),
  periode2: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("MACD langsam (26), Glättung %K (3)."),
  periode3: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("MACD-Signal (9), Glättung %D (3)."),
  faktor: z
    .number()
    .positive()
    .max(10)
    .optional()
    .describe("Bandabstand der Bollinger-Bänder (2)."),
  feld: z.enum(["open", "high", "low", "close"]).optional(),
  wert: z.number().optional(),
});

const bedingung = z.object({
  links: indikator,
  vergleich: z.enum(["ueber", "unter", "kreuzt_ueber", "kreuzt_unter"]),
  rechts: indikator,
});

const strategieSchema = {
  name: z.string().min(3).max(80).describe("Sprechender Name, z. B. „Ausbruch 20 Tage, DAX“."),
  richtung: z.enum(["long", "short"]),
  einstieg: z
    .array(bedingung)
    .min(1)
    .max(4)
    .describe("Alle müssen zutreffen. Beispiel: Kurs kreuzt über SMA 50."),
  ausstieg: z
    .array(bedingung)
    .max(4)
    .optional()
    .describe("Eine genügt. Ohne Ausstiegsregel tragen Stop, Ziel und Zeitgrenze den Handel."),
  stopAtr: z.number().positive().max(20).optional().describe("Stop als Vielfaches des ATR(14)."),
  stopProzent: z.number().positive().max(90).optional().describe("Stop in Prozent vom Einstieg."),
  zielR: z.number().positive().max(50).optional().describe("Ziel als Vielfaches des Risikos."),
  zielProzent: z.number().positive().max(500).optional(),
  maxKerzen: z.number().int().positive().max(500).optional(),
  gebuehrProzent: z.number().min(0).max(5).optional().describe("Je Seite. Vorgabe 0,1."),
  schlupfProzent: z.number().min(0).max(5).optional().describe("Je Seite. Vorgabe 0,05."),
};

function text(inhalt: string, fehler = false) {
  return {
    content: [{ type: "text" as const, text: inhalt }],
    ...(fehler ? { isError: true } : {}),
  };
}

export function createLabor(deps: LaborDeps = {}) {
  const markets = deps.markets ?? createYahooMarkets();

  const stichtag = tool(
    "stichtag",
    [
      "Den Kursverlauf **so sehen, wie er an einem vergangenen Tag aussah** — ohne alles, was",
      "danach kam.",
      "",
      "Dafür gedacht, eine Einschätzung zu einem vergangenen Zeitpunkt zu erarbeiten, die man",
      "anschließend mit `rueckblick` gegen den tatsächlichen Verlauf prüfen kann. Wer die Zukunft",
      "schon gesehen hat, kann sie nicht mehr ehrlich einschätzen — dieses Werkzeug schneidet sie",
      "deshalb ab, statt sich auf Selbstdisziplin zu verlassen.",
    ].join("\n"),
    {
      symbol: z.string().min(1).max(20).describe("Yahoo-Symbol, z. B. ^GDAXI, BTC-USD, AAPL."),
      bis: z.string().regex(TAG).describe("Stichtag, YYYY-MM-DD. Alles danach bleibt unsichtbar."),
      tage: z
        .number()
        .int()
        .min(5)
        .max(2000)
        .default(180)
        .describe("Wie viele Kalendertage davor mitkommen."),
      intervall: z.enum(CHART_INTERVALS).default("1d"),
    },
    async ({ symbol, bis, tage, intervall }) => {
      const ende = unix(bis);
      if (!Number.isFinite(ende)) return text(`„${bis}" ist kein Datum.`, true);
      try {
        const chart = await markets.zeitraum(
          symbol,
          ende - tage * 86_400,
          ende,
          intervall as ChartInterval,
        );
        return text(
          `Stand ${bis} (alles Spätere ist abgeschnitten):\n\n${formatiereVerlauf(chart)}`,
        );
      } catch (error) {
        return text(
          `Abruf fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
          true,
        );
      }
    },
    { annotations: { title: "Verlauf bis zu einem Stichtag", readOnlyHint: true } },
  );

  const rueckblick = tool(
    "rueckblick",
    [
      "Eine **einzelne Idee** gegen den tatsächlichen Verlauf prüfen: Ziel erreicht,",
      "ausgestoppt, oder nie eingestiegen — und wie nah es war.",
      "",
      "Du gibst Richtung, Einstieg, Stop, Ziele und ab wann die Idee galt. Zurück kommen das",
      "Ergebnis in R, die Dauer, der beste und der schlechteste Stand dazwischen (MFE/MAE).",
      "Der schlechteste Stand ist oft die eigentliche Auskunft: ein Ziel, das erst nach −0,9 R",
      "erreicht wurde, war eine knappe Sache und keine gute Idee.",
      "",
      "Für Einzelideen aus Nachrichtenlagen — nicht für Strategien. Die prüft `backtest`.",
    ].join("\n"),
    {
      symbol: z.string().min(1).max(20),
      richtung: z.enum(["long", "short"]),
      einstieg: z.number().positive(),
      stop: z.number().positive(),
      ziele: z.array(z.number().positive()).min(1).max(3),
      ab: z.string().regex(TAG).describe("Ab wann die Idee galt, YYYY-MM-DD."),
      bis: z.string().regex(TAG).optional().describe("Bis wann geprüft wird. Vorgabe: heute."),
      intervall: z.enum(CHART_INTERVALS).default("1d"),
    },
    async ({ symbol, richtung, einstieg, stop, ziele, ab, bis, intervall }) => {
      const ende = bis ?? heute();
      try {
        const chart = await markets.zeitraum(
          symbol,
          unix(ab),
          unix(ende) + 86_400,
          intervall as ChartInterval,
        );
        if (chart.candles.length === 0)
          return text("Für diesen Zeitraum kamen keine Kerzen.", true);
        const idee = { richtung, einstieg, stop, ziele } as const;
        const ergebnis = werteIdeeAus(idee, chart.candles);
        return text(
          formatiereRueckblick(idee, ergebnis, { symbol: chart.symbol, von: ab, bis: ende }),
        );
      } catch (error) {
        return text(
          `Abruf fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
          true,
        );
      }
    },
    { annotations: { title: "Alte Idee gegen den Verlauf prüfen", readOnlyHint: true } },
  );

  const backtestTool = tool(
    "backtest",
    [
      "Eine **Strategie** gegen echte Kerzen laufen lassen und ihre Kennzahlen bekommen:",
      "Nettoergebnis, Handel, Trefferquote, Erwartungswert in R, Profitfaktor, Rückschlag,",
      "Sharpe, Sortino — dazu Kaufen-und-Liegenlassen als Vergleich.",
      "",
      "Gerechnet wird wie im Strategy Tester bei TradingView: Signal auf der abgeschlossenen",
      "Kerze, Einstieg zur nächsten Eröffnung, und wenn Stop und Ziel in dieselbe Kerze fallen,",
      "zählt der Stop. Gebühren und Schlupf sind immer dabei.",
      "",
      "Der Zeitraum wird in zwei Teile berichtet: den, an dem du schraubst, und den, den du",
      "dabei nicht gesehen hast. Trägt der zweite nicht, ist die Strategie an die Vergangenheit",
      "angepasst — das steht dann als Vorbehalt im Ergebnis, und du nennst es im Bericht.",
      "",
      "Eine Strategie ohne Verlustbegrenzung wird abgewiesen.",
    ].join("\n"),
    {
      symbol: z.string().min(1).max(20),
      von: z.string().regex(TAG).describe("Beginn des Zeitraums, YYYY-MM-DD."),
      bis: z.string().regex(TAG).optional().describe("Ende. Vorgabe: heute."),
      ...strategieSchema,
    },
    async (eingabe) => {
      const { symbol, von, bis, ...rest } = eingabe;
      const ende = bis ?? heute();
      const intervallWahl = "1d";
      try {
        const chart = await markets.zeitraum(symbol, unix(von), unix(ende) + 86_400, "1d");
        const strategie = rest as unknown as Strategie;
        const ergebnis = backtest(strategie, chart.candles, {
          symbol: chart.symbol,
          intervall: intervallWahl,
        });
        return text(formatiereBacktest(ergebnis));
      } catch (error) {
        if (error instanceof StrategieFehler)
          return text(`Nicht gerechnet: ${error.message}`, true);
        return text(
          `Backtest fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
          true,
        );
      }
    },
    { annotations: { title: "Strategie backtesten", readOnlyHint: true } },
  );

  const replayStart = tool(
    "replay_start",
    [
      "Eine **Wiedergabe** beginnen: der Markt läuft ab einem vergangenen Tag noch einmal,",
      "Kerze für Kerze, und alles Spätere bleibt verdeckt — wie der Bar-Replay bei TradingView.",
      "",
      "Du bekommst den Vorlauf bis zum Starttag und eine Kennung. Danach gehst du mit",
      "`replay_weiter` vor, trägst erkannte Setups mit `replay_handeln` ins Tagebuch ein und",
      "siehst mit `replay_stand`, wie es steht. `replay_ende` schreibt das Tagebuch auf die",
      "Platte.",
      "",
      "Dafür gedacht, das eigene Urteil zu prüfen — nicht eine Regel. Regeln prüft `backtest`.",
    ].join("\n"),
    {
      symbol: z.string().min(1).max(20),
      ab: z.string().regex(TAG).describe("Starttag der Wiedergabe, YYYY-MM-DD."),
      vorlaufTage: z
        .number()
        .int()
        .min(30)
        .max(2000)
        .default(180)
        .describe("Wie viel Geschichte vor dem Starttag sichtbar ist."),
      bisTage: z
        .number()
        .int()
        .min(10)
        .max(1000)
        .default(180)
        .describe("Wie viele Tage nach dem Starttag geladen (aber verdeckt) werden."),
      intervall: z.enum(CHART_INTERVALS).default("1d"),
    },
    async ({ symbol, ab, vorlaufTage, bisTage, intervall }) => {
      const start = unix(ab);
      try {
        const chart = await markets.zeitraum(
          symbol,
          start - vorlaufTage * 86_400,
          start + bisTage * 86_400,
          intervall as ChartInterval,
        );
        const sitzung = starte(chart, ab);
        return text(
          [
            `Wiedergabe ${sitzung.id} · ${chart.symbol} (${chart.name}) · ${chart.interval}`,
            `Steht auf ${ab}. Alles danach ist verdeckt.`,
            "",
            "Datum  Open  High  Low  Close",
            formatiereKerzen(sichtbar(sitzung, 80)),
          ].join("\n"),
        );
      } catch (error) {
        if (error instanceof ReplayFehler) return text(error.message, true);
        return text(
          `Abruf fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
          true,
        );
      }
    },
    { annotations: { title: "Wiedergabe starten" } },
  );

  const replayWeiter = tool(
    "replay_weiter",
    "Die Wiedergabe um eine oder mehrere Kerzen vorspulen. Offene Handel werden dabei gegen " +
      "jede neue Kerze geprüft — Stop vor Ziel, wenn beide in dieselbe Kerze fallen.",
    {
      id: z.string().min(4).max(16),
      schritte: z.number().int().min(1).max(50).default(1),
    },
    async ({ id, schritte }) => {
      try {
        const sitzung = hole(id);
        const { neu, ereignisse } = weiter(sitzung, schritte);
        const zeilen = [
          `${neu.length} Kerze(n) aufgedeckt, jetzt auf ${neu.length > 0 ? tagVon(neu[neu.length - 1].time) : "unverändert"}.`,
        ];
        if (neu.length > 0) {
          zeilen.push("", "Datum  Open  High  Low  Close", formatiereKerzen(neu));
        }
        if (ereignisse.length > 0) zeilen.push("", ...ereignisse);
        return text(zeilen.join("\n"));
      } catch (error) {
        if (error instanceof ReplayFehler) return text(error.message, true);
        throw error;
      }
    },
    { annotations: { title: "Wiedergabe vorspulen" } },
  );

  const replayHandeln = tool(
    "replay_handeln",
    [
      "Ein erkanntes Setup als Handel ins Tagebuch eintragen.",
      "",
      "Eingestiegen wird zur **Eröffnung der nächsten Kerze** — zum Kurs also, den du bekämst,",
      "wenn du jetzt entscheidest. Zum Schlusskurs der Kerze zu kaufen, die du gerade siehst,",
      "wäre ein Vorsprung, den es nie gab.",
      "",
      "Die Begründung ist Pflicht: ein Tagebuch ohne sie sagt später nicht, warum es klappte.",
    ].join("\n"),
    {
      id: z.string().min(4).max(16),
      richtung: z.enum(["long", "short"]),
      stop: z.number().positive(),
      ziele: z.array(z.number().positive()).min(1).max(3),
      begruendung: z.string().min(10).max(400).describe("Was du siehst und warum du handelst."),
    },
    async ({ id, richtung, stop, ziele, begruendung }) => {
      try {
        const sitzung = hole(id);
        const handel = handeln(sitzung, { richtung, stop, ziele, begruendung });
        return text(
          `Handel ${handel.nummer} eingetragen: ${richtung} ab ${handel.einstieg.toFixed(4)} ` +
            `(Eröffnung ${tagVon(handel.einstiegZeit)}), Stop ${stop}, Ziele ${ziele.join(" / ")}.`,
        );
      } catch (error) {
        if (error instanceof ReplayFehler) return text(error.message, true);
        throw error;
      }
    },
    { annotations: { title: "Handel eintragen" } },
  );

  const replayGlatt = tool(
    "replay_glattstellen",
    "Den laufenden Handel von Hand schließen — zum Schlusskurs der aktuell sichtbaren Kerze.",
    { id: z.string().min(4).max(16) },
    async ({ id }) => {
      try {
        const handel = stellGlatt(hole(id));
        return text(
          `Handel ${handel.nummer} glattgestellt zu ${(handel.ausstieg ?? 0).toFixed(4)}: ${(handel.r ?? 0) >= 0 ? "+" : ""}${(handel.r ?? 0).toFixed(2)} R.`,
        );
      } catch (error) {
        if (error instanceof ReplayFehler) return text(error.message, true);
        throw error;
      }
    },
    { annotations: { title: "Handel glattstellen" } },
  );

  const replayStand = tool(
    "replay_stand",
    "Wo die Wiedergabe steht und was im Tagebuch steht — mit Trefferquote, Summe in R und " +
      "Profitfaktor über die abgeschlossenen Handel.",
    { id: z.string().min(4).max(16) },
    async ({ id }) => {
      try {
        return text(formatiereStand(hole(id)));
      } catch (error) {
        if (error instanceof ReplayFehler) return text(error.message, true);
        throw error;
      }
    },
    { annotations: { title: "Stand der Wiedergabe", readOnlyHint: true } },
  );

  const replayEnde = tool(
    "replay_ende",
    "Die Wiedergabe abschließen und das Tagebuch auf die Platte schreiben, damit Jakob es " +
      "später lesen kann. Danach ist die Kennung verbraucht.",
    { id: z.string().min(4).max(16) },
    async ({ id }) => {
      try {
        const sitzung = hole(id);
        const uebersicht = formatiereStand(sitzung);
        if (deps.workdir) {
          const datei = await schreibeTagebuch(sitzung, deps.workdir, deps.wer ?? "handelstisch");
          return text(`${uebersicht}\n\nTagebuch geschrieben: ${datei}`);
        }
        return text(`${uebersicht}\n\n(Kein Arbeitsbereich gesetzt — nichts geschrieben.)`);
      } catch (error) {
        if (error instanceof ReplayFehler) return text(error.message, true);
        throw error;
      }
    },
    { annotations: { title: "Wiedergabe abschließen" } },
  );

  const gegenprobe = tool(
    "gegenprobe",
    [
      "Eine **abgelegte** Strategie unter anderen Bedingungen nachrechnen: verschobene Perioden",
      "(±20 %), verdoppelte Kosten und, wenn du willst, andere Märkte und Zeitfenster.",
      "",
      "Das ist die eigentliche Prüfung. Ein zweites Urteil über dieselben Zahlen ist keine —",
      "eine Regel, die bei SMA 50 trägt und bei SMA 40 und SMA 60 zusammenfällt, ist an einen",
      "Zufall angepasst. Ein echter Effekt ist eine Hochebene, keine Nadelspitze.",
      "",
      "Zurück kommt eine Tabelle aller Varianten und die rechnerische Einstufung: robust,",
      "wackelig oder fragil. Die Einstufung bestimmst nicht du — du deutest sie.",
    ].join("\n"),
    {
      id: z
        .string()
        .regex(/^[0-9a-f]{12}$/)
        .describe("Kennung der abgelegten Strategie."),
      maerkte: z
        .array(z.string().min(1).max(20))
        .max(3)
        .optional()
        .describe("Zusätzliche Symbole, an denen dieselbe Regel geprüft wird."),
      von: z.string().regex(TAG).optional().describe("Anderes Zeitfenster: Beginn."),
      bis: z.string().regex(TAG).optional(),
    },
    async ({ id, maerkte, von, bis }) => {
      if (!deps.strategien)
        return text("Ohne Strategie-Archiv gibt es nichts nachzurechnen.", true);
      const eintrag = await deps.strategien.lies(id);
      if (!eintrag) return text(`Keine Strategie mit der Kennung ${id}.`, true);

      const beginn = von ?? eintrag.von;
      const ende = bis ?? eintrag.bis;
      const varianten = [
        { name: "Original", strategie: eintrag.strategie },
        ...nachbarschaft(eintrag.strategie),
      ];
      const symbole = [eintrag.symbol, ...(maerkte ?? [])];
      const ergebnisse = [];

      for (const symbol of symbole) {
        let kerzen: Awaited<ReturnType<typeof markets.zeitraum>>["candles"];
        try {
          kerzen = (await markets.zeitraum(symbol, unix(beginn), unix(ende) + 86_400, "1d"))
            .candles;
        } catch (error) {
          return text(
            `Kurse zu ${symbol} nicht abrufbar: ${error instanceof Error ? error.message : error}`,
            true,
          );
        }
        // Am fremden Markt zählt nur das Original: dort ginge es um die Regel, nicht um ihre
        // Parameter — und vier Varianten je Markt wären eine Zahlenwand ohne Mehrwert.
        const zuPruefen = symbol === eintrag.symbol ? varianten : [varianten[0]];
        for (const variante of zuPruefen) {
          ergebnisse.push(pruefeVariante(variante, kerzen, symbol));
        }
      }

      const urteilDavon = urteile(ergebnisse);
      return text(formatiereGegenprobe(eintrag.name, ergebnisse, urteilDavon));
    },
    { annotations: { title: "Strategie gegenprüfen", readOnlyHint: true } },
  );

  /**
   * Der Blick in den Betrieb. **Lesen darf jeder am Tisch, starten nur, wer es soll** — und
   * niemand darf hier eine Order auslösen: Ausführung ist Code (`papierhandel.ts`), nicht
   * Urteil. Der Agent sieht zu und berichtet.
   */
  function papierWerkzeuge(papier: Papierhandel) {
    const stand = tool(
      "papier_stand",
      "Wie die Strategien im Papierhandel laufen: Handel, Trefferquote, Erwartungswert im " +
        "Betrieb gegen den des Backtests — und ob ein Konto gesperrt wurde.",
      {},
      async () => {
        const konten = await papier.liste();
        if (konten.length === 0) return text("Im Papierhandel läuft nichts.");
        const zeilen = konten.map((k) => {
          const z = papierKennzahlen(k);
          const kopf = `${k.name} (${k.symbol}, seit ${k.seit.slice(0, 10)})${k.gesperrt ? " — GESPERRT" : ""}`;
          const zahlen =
            z.anzahl === 0
              ? k.offen
                ? "eine Position offen, noch kein abgeschlossener Handel"
                : k.wartetAufEinstieg
                  ? "Signal erkannt, wartet auf die nächste Eröffnung"
                  : "noch kein Signal"
              : `${z.anzahl} Handel, ${(z.trefferquote * 100).toFixed(0)} % Treffer, ${z.erwartungswertR.toFixed(2)} R je Handel (Backtest versprach ${k.erwartetR.toFixed(2)} R), Rückschlag ${z.maxDrawdownProzent.toFixed(1)} %`;
          return `${kopf}\n  ${zahlen}${k.gesperrt ? `\n  Grund: ${k.sperrgrund ?? "—"}` : ""}`;
        });
        return text(zeilen.join("\n\n"));
      },
      { annotations: { title: "Papierhandel ansehen", readOnlyHint: true } },
    );

    if (!deps.darfStarten) return [stand];

    return [
      stand,
      tool(
        "papier_start",
        [
          "Eine Strategie in den Papierhandel geben: sie läuft ab jetzt gegen den laufenden",
          "Markt, mit Buchgeld, ausgeführt von Code und nicht von dir.",
          "",
          "Nur Strategien mit dem Status `kandidat` — also geprüft und im ungesehenen Zeitraum",
          "bestanden. Der Betrieb fängt **heute** an und spielt keine Geschichte nach; die",
          "ersten Wochen sind die ersten ehrlichen Zahlen, die es zu dieser Regel gibt.",
        ].join("\n"),
        { id: z.string().regex(/^[0-9a-f]{12}$/) },
        async ({ id }) => {
          try {
            const konto = await papier.starte(id);
            return text(
              `„${konto.name}" läuft im Papierhandel (${konto.symbol}, seit ${konto.seit.slice(0, 10)}). Gesperrt wird von selbst bei 20 % Rückschlag, sechs Verlusten in Folge oder wenn der Betrieb deutlich hinter dem Backtest zurückbleibt.`,
            );
          } catch (error) {
            if (error instanceof PapierFehler) return text(error.message, true);
            return text(
              `Start fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
              true,
            );
          }
        },
        { annotations: { title: "In den Papierhandel geben" } },
      ),
    ];
  }

  /**
   * Die Ablage-Werkzeuge gibt es nur mit Archiv. Sie stehen in einer eigenen Funktion, damit
   * die Werkzeugliste **ein** Ausdruck bleibt: ein `push` auf ein Array, dessen Typ aus den
   * ersten Einträgen abgeleitet wurde, passt nicht zu Werkzeugen mit anderem Eingabeschema.
   */
  function archivWerkzeuge(archiv: StrategienArchiv) {
    return [
      tool(
        "strategie_ablegen",
        [
          "Eine **geprüfte** Strategie ins Archiv legen — mit ihrem Backtest-Ergebnis, nicht ohne.",
          "",
          "Der Status vergibt sich selbst aus den Kennzahlen: `kandidat` nur bei mindestens 30",
          "Handeln, positivem Erwartungswert in beiden Zeitabschnitten, Sharpe ab 1 und ohne",
          "offenen Vorbehalt. Alles andere ist `geprueft`, `verworfen` oder `entwurf`. Du kannst",
          "den Status nicht selbst setzen — sonst wäre er eine Meinung.",
          "",
          "Jakob sieht die Ablage in der Oberfläche unter „Strategien“ und entscheidet dort.",
        ].join("\n"),
        {
          symbol: z.string().min(1).max(20),
          von: z.string().regex(TAG),
          bis: z.string().regex(TAG).optional(),
          ...strategieSchema,
        },
        async (eingabe) => {
          const { symbol, von, bis, ...rest } = eingabe;
          const ende = bis ?? heute();
          try {
            const chart = await markets.zeitraum(symbol, unix(von), unix(ende) + 86_400, "1d");
            const strategie = rest as unknown as Strategie;
            const ergebnis = backtest(strategie, chart.candles, {
              symbol: chart.symbol,
              intervall: "1d",
            });
            const kopf = await archiv.lege({
              name: strategie.name,
              wer: deps.wer ?? "handelstisch",
              symbol: chart.symbol,
              intervall: "1d",
              von: ergebnis.von,
              bis: ergebnis.bis,
              strategie,
              kennzahlen: ergebnis.gesamt,
              inSample: ergebnis.inSample,
              outOfSample: ergebnis.outOfSample,
              warnungstexte: ergebnis.warnungen,
              bericht: formatiereBacktest(ergebnis),
            });
            return text(
              `Abgelegt als ${kopf.id} — Status **${kopf.status}**.\n\n${formatiereBacktest(ergebnis)}`,
            );
          } catch (error) {
            if (error instanceof StrategieFehler)
              return text(`Nicht abgelegt: ${error.message}`, true);
            return text(
              `Ablage fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
              true,
            );
          }
        },
        { annotations: { title: "Strategie ablegen" } },
      ),
      tool(
        "strategien",
        "Die abgelegten Strategien auflisten — Name, Symbol, Status, Kennzahlen. Sieh hier nach, " +
          "bevor du etwas Neues entwickelst: vielleicht ist die Idee schon geprüft und verworfen.",
        { grenze: z.number().int().min(1).max(50).default(20) },
        async ({ grenze }) => {
          const koepfe = await archiv.liste(grenze);
          if (koepfe.length === 0) return text("Noch keine Strategie abgelegt.");
          return text(
            koepfe
              .map((k) => {
                const z = k.kennzahlen;
                const zahlen = z
                  ? `${z.anzahl} Handel, ${(z.trefferquote * 100).toFixed(0)} % Treffer, ${z.erwartungswertR.toFixed(2)} R, Sharpe ${z.sharpe.toFixed(2)}`
                  : "ohne Prüfung";
                return `${k.id}  ${k.name} (${k.symbol}, ${k.von}–${k.bis}) — ${k.status}, ${zahlen}${k.warnungen > 0 ? `, ${k.warnungen} Vorbehalt(e)` : ""}`;
              })
              .join("\n"),
          );
        },
        { annotations: { title: "Strategien auflisten", readOnlyHint: true } },
      ),
      tool(
        "strategie_lesen",
        "Eine abgelegte Strategie im Wortlaut lesen — Regel, Kennzahlen, Vorbehalte, Jakobs Notiz.",
        { id: z.string().regex(/^[0-9a-f]{12}$/) },
        async ({ id }) => {
          const eintrag = await archiv.lies(id);
          if (!eintrag) return text(`Keine Strategie mit der Kennung ${id}.`, true);
          return text(
            [
              `${eintrag.name} (${eintrag.symbol}) — Status ${eintrag.status}`,
              eintrag.notiz ? `Jakobs Notiz: ${eintrag.notiz}` : "",
              "",
              "Regel:",
              JSON.stringify(eintrag.strategie, null, 2),
              "",
              eintrag.bericht,
            ]
              .filter((z) => z !== "")
              .join("\n"),
          );
        },
        { annotations: { title: "Strategie lesen", readOnlyHint: true } },
      ),
    ];
  }

  return createSdkMcpServer({
    name: "labor",
    version: "1",
    instructions:
      "Das Labor. Zwei Wege, eine Sache zu prüfen: `replay_start` spielt den Markt Kerze für " +
      "Kerze mit verdeckter Zukunft ab (dein Urteil auf dem Prüfstand, Tagebuch inklusive), " +
      "`backtest` rechnet eine Regel über Jahre durch (das Verfahren auf dem Prüfstand). Dazu " +
      "`stichtag` für den Blick von damals, `rueckblick` für eine einzelne alte Idee und " +
      "`strategie_ablegen` für Geprüftes. Kennzahlen kommen aus der Rechnung, nie aus dem Kopf.",
    tools: [
      stichtag,
      rueckblick,
      backtestTool,
      replayStart,
      replayWeiter,
      replayHandeln,
      replayGlatt,
      replayStand,
      replayEnde,
      gegenprobe,
      ...(deps.papier ? papierWerkzeuge(deps.papier) : []),
      ...(deps.strategien ? archivWerkzeuge(deps.strategien) : []),
    ],
  });
}

/** Die Werkzeugnamen für `allowedTools`. */
export const LABOR_TOOLS = [
  "mcp__labor__stichtag",
  "mcp__labor__rueckblick",
  "mcp__labor__backtest",
  "mcp__labor__gegenprobe",
  "mcp__labor__replay_start",
  "mcp__labor__replay_weiter",
  "mcp__labor__replay_handeln",
  "mcp__labor__replay_glattstellen",
  "mcp__labor__replay_stand",
  "mcp__labor__replay_ende",
  "mcp__labor__strategie_ablegen",
  "mcp__labor__strategien",
  "mcp__labor__strategie_lesen",
  "mcp__labor__papier_stand",
  "mcp__labor__papier_start",
];

/** Was ein Prüfer braucht, der keine Strategien ablegt. */
export const LABOR_PRUEFEN = LABOR_TOOLS.filter((t) => !t.includes("strategie_ablegen"));

export type { Bedingung };
