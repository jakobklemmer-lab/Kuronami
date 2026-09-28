/**
 * Die beiden Scalping-Videos nachrechnen — „EASY Scalping" (Williams-Fraktale an drei
 * Durchschnitten) und „BEST Scalping" (200er-EMA, RSI über 50, Engulfing-Kerze, Stop zwei
 * Kerzenlängen, Ziel 2:1) — über alle Zeitrahmen, Sitzungen und Märkte.
 *
 *   cd /opt/kuronami && pnpm nachrechnen:scalping
 *   Schalter: --intervalle 1m,5m · --maerkte binance:BTCUSDT,^GSPC · --ohne-sitzungen · --analyse
 */
import { BEST_SCALPING_VIDEO, SCALPING_VIDEO } from "../../gateway/kalibrierung.js";
import { rechneNach, schalter } from "../../gateway/nachrechnung.js";

await rechneNach({
  name: "scalping",
  regeln: [SCALPING_VIDEO, BEST_SCALPING_VIDEO],
  ...schalter(process.argv.slice(2)),
});
