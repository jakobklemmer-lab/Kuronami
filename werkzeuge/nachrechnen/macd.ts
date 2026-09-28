/**
 * MACD aus „BEST MACD Trading Strategy [86% Win Rate]" nachrechnen — über alle Zeitrahmen,
 * Sitzungen und Märkte. Dazu die Gegenprobe mit der SMA 200, weil das Video offenlässt, ob der
 * 200er-Durchschnitt eine EMA oder eine SMA ist.
 *
 *   cd /opt/kuronami && pnpm nachrechnen:macd
 *   Schalter: --intervalle 15m,1h · --maerkte binance:BTCUSDT,^GSPC · --ohne-sitzungen · --analyse
 */
import { MACD_MIT_SMA, MACD_VIDEO } from "../../gateway/kalibrierung.js";
import { rechneNach, schalter } from "../../gateway/nachrechnung.js";

await rechneNach({
  name: "macd",
  regeln: [
    MACD_VIDEO,
    { ...MACD_VIDEO, titel: `${MACD_VIDEO.titel} — Gegenprobe SMA 200`, teile: MACD_MIT_SMA },
  ],
  ...schalter(process.argv.slice(2)),
});
