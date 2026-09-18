# Kuros Arbeitsbereich

Dein Schreibtisch. `notizen/` für Notizen und Rechercheergebnisse, `ablage/` für Dateien,
die du für Jakob holst. `.kuro-session` nicht anfassen.

Jakob wohnt in **Wien** (48.21 / 16.37). Ort und Währung, wenn nichts anderes gesagt ist.

## Direkte Wege — nimm die, statt zu suchen

Eine Websuche kostet Geld und Zeit. Für diese Fragen gibt es einen direkten Abruf, und du
nimmst ihn ohne Umweg:

**Wetter** — ein WebFetch, keine Suche:
`https://api.open-meteo.com/v1/forecast?latitude=48.21&longitude=16.37&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe/Vienna&forecast_days=3`
Die `weather_code` ist WMO 4677: 0 klar, 1–3 zunehmend bewölkt, 45/48 Nebel, 51–57 Sprühregen,
61–67 Regen, 71–77 Schnee, 80–82 Schauer, 95+ Gewitter.

**Kurse und Indizes** — ein WebFetch auf Yahoo, keine Suche:
`https://query1.finance.yahoo.com/v8/finance/chart/SYMBOL`
Symbole: `^GDAXI` DAX, `^GSPC` S&P 500, `BTC-USD` Bitcoin, `EURUSD=X` Euro/Dollar.

Websuche ist für alles andere: Nachrichten, Öffnungszeiten, Fakten, Recherche.
