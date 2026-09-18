/**
 * Zahlenformate der Marktansichten. Kurse haben je nach Instrument eine andere sinnvolle
 * Genauigkeit: ein Index bei 18.000 braucht keine Nachkommastellen mehr als zwei, ein Devisenkurs
 * bei 1,08 braucht vier, ein Kleinstwert unter 1 noch mehr. Eine Regel statt einer Tabelle je Typ.
 */

export function priceDigits(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return 2;
  if (abs >= 10) return 2;
  if (abs >= 1) return 3;
  if (abs >= 0.01) return 4;
  return 6;
}

export function formatPrice(price: number, currency = ""): string {
  const digits = priceDigits(price);
  const text = price.toLocaleString("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency ? `${text} ${currency}` : text;
}

/** Die absolute Veränderung in derselben Genauigkeit wie der Kurs, zu dem sie gehört — sonst
 * stünde neben „227,48" ein „+1,230". */
export function formatChange(change: number, changePct: number, price: number): string {
  const sign = change >= 0 ? "+" : "−";
  const abs = Math.abs(change);
  const digits = priceDigits(price);
  const absText = abs.toLocaleString("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${sign}${absText} (${formatPercent(changePct)})`;
}

export function formatPercent(changePct: number): string {
  const sign = changePct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(changePct).toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} %`;
}

/** Yahoos `quoteType` in ein Wort für die Trefferliste. */
export function describeQuoteType(type: string): string {
  switch (type) {
    case "EQUITY":
      return "Aktie";
    case "ETF":
      return "ETF";
    case "INDEX":
      return "Index";
    case "CRYPTOCURRENCY":
      return "Krypto";
    case "CURRENCY":
      return "Devise";
    case "FUTURE":
      return "Future";
    case "MUTUALFUND":
      return "Fonds";
    case "OPTION":
      return "Option";
    default:
      return type.length > 0 ? type.charAt(0) + type.slice(1).toLowerCase() : "";
  }
}
