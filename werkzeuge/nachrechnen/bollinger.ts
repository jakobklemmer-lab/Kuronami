/**
 * Bollinger + RSI aus „Bollinger Band + RSI Trading Strategy That Actually Works" nachrechnen —
 * über alle Zeitrahmen, Sitzungen und Märkte. Das Video nennt keinen Stop; das Original läuft
 * mit einem Notstop weit weg (siehe `NOTSTOP_PROZENT`), deshalb ist dort „Ø R" winzig und die
 * Spalte „Ø %" in der CSV die ehrlichere. Dazu die Gegenprobe mit Stop am Swing der letzten 5 Kerzen.
 *
 *   cd /opt/kuronami && pnpm nachrechnen:bollinger
 *   Schalter: --intervalle 15m,1h · --maerkte binance:BTCUSDT,^GSPC · --ohne-sitzungen · --analyse
 */
import { BOLLINGER_MIT_SWINGSTOP, BOLLINGER_VIDEO } from "../../gateway/kalibrierung.js";
import { rechneNach, schalter } from "../../gateway/nachrechnung.js";

await rechneNach({
  name: "bollinger",
  regeln: [
    BOLLINGER_VIDEO,
    {
      ...BOLLINGER_VIDEO,
      titel: `${BOLLINGER_VIDEO.titel} — Gegenprobe Stop am Swing`,
      teile: BOLLINGER_MIT_SWINGSTOP,
    },
  ],
  ...schalter(process.argv.slice(2)),
});
