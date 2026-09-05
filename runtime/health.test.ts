import { describe, expect, it } from "vitest";

describe("runtime health", () => {
  it("is set up and runnable", () => {
    expect(1 + 1).toBe(2);
  });
});
