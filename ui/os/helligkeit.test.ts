import { describe, expect, it } from "vitest";
import { wirksam } from "./helligkeit.js";

describe("Helligkeit", () => {
  it("folgt der Wahl, bei „Wie das System“ dem Rechner", () => {
    expect(wirksam("dunkel", true)).toBe("dunkel");
    expect(wirksam("hell", false)).toBe("hell");
    expect(wirksam("system", true)).toBe("hell");
    expect(wirksam("system", false)).toBe("dunkel");
  });
});
