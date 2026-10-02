import { describe, expect, it } from "vitest";
import { ohneVorspann, sollNachtragen } from "./haus.js";

describe("sollNachtragen", () => {
  it("meldet einen abgebrochenen Auftrag nicht nach", () => {
    expect(sollNachtragen(true)).toBe(false);
    expect(sollNachtragen(false)).toBe(true);
  });
});

describe("ohneVorspann", () => {
  it("schneidet englische Arbeitssätze vor der Überschrift ab", () => {
    const text =
      "I have enough now for a solid assessment. Let me compile the report.\n\n## Bericht\n\nDer DAX steht bei 24.100.";
    expect(ohneVorspann(text)).toBe("## Bericht\n\nDer DAX steht bei 24.100.");
  });

  it("schneidet bis zum ersten deutschen Absatz", () => {
    expect(ohneVorspann("Perfect. Now I have all the data.\n\nSiemens hält die 200.")).toBe(
      "Siemens hält die 200.",
    );
  });

  it("lässt deutschen Text unverändert", () => {
    const text = "Der Auftrag ist erledigt.\n\nIn der Watchlist stehen drei Werte.";
    expect(ohneVorspann(text)).toBe(text);
  });

  it("lässt rein englischen Text ohne Überschrift unverändert", () => {
    const text = "I checked the mailbox. Let me know if you need more.";
    expect(ohneVorspann(text)).toBe(text);
  });
});
