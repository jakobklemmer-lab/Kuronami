/**
 * „Highly Profitable DEMA + SuperTrend Trading Strategy" nachrechnen — DEMA 200 als Filter,
 * SuperTrend(12, 3) als Signal und Stop, raus beim Gegensignal — über alle Zeitrahmen,
 * Sitzungen und Märkte. Das Video rechnet auf 15 Minuten an DOGE und LTC.
 *
 *   cd /opt/kuronami && pnpm nachrechnen:supertrend
 *   Schalter: --intervalle 15m,1h · --maerkte binance:DOGEUSDT,binance:LTCUSDT · --ohne-sitzungen · --analyse
 */
import { SUPERTREND_VIDEO } from "../../gateway/kalibrierung.js";
import { rechneNach, schalter } from "../../gateway/nachrechnung.js";

await rechneNach({
  name: "supertrend",
  regeln: [SUPERTREND_VIDEO],
  ...schalter(process.argv.slice(2)),
});
