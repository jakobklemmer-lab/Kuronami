import { describe, expect, it, vi } from "vitest";
import { AGENT_STATES, createMicStateStore } from "./state.js";

describe("MicStateStore", () => {
  it("startet bei idle, sofern nicht anders angegeben", () => {
    expect(createMicStateStore().state).toBe("idle");
  });

  it("übernimmt einen expliziten Startzustand", () => {
    expect(createMicStateStore("thinking").state).toBe("thinking");
  });

  it("set() ändert den Zustand und benachrichtigt Abonnenten", () => {
    const store = createMicStateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("speaking");
    expect(store.state).toBe("speaking");
    expect(listener).toHaveBeenCalledWith("speaking");
  });

  it("set() auf denselben Zustand benachrichtigt niemanden", () => {
    const store = createMicStateStore("idle");
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("idle");
    expect(listener).not.toHaveBeenCalled();
  });

  it("abbestellen beendet die Benachrichtigung", () => {
    const store = createMicStateStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set("executing");
    expect(listener).not.toHaveBeenCalled();
  });

  it("cycle() durchläuft alle sechs Zustände zyklisch in der vorgegebenen Reihenfolge", () => {
    const store = createMicStateStore("idle");
    const seen = [store.state];
    for (let i = 0; i < AGENT_STATES.length; i += 1) seen.push(store.cycle());
    expect(seen).toEqual([...AGENT_STATES, "idle"]);
  });

  it("toggleListening() schaltet von idle nach listening", () => {
    const store = createMicStateStore("idle");
    expect(store.toggleListening()).toBe("listening");
  });

  it("toggleListening() schaltet von listening zurück nach idle", () => {
    const store = createMicStateStore("listening");
    expect(store.toggleListening()).toBe("idle");
  });

  it("toggleListening() bricht aus jedem anderen Zustand nach idle ab", () => {
    for (const state of ["thinking", "speaking", "executing", "complete"] as const) {
      expect(createMicStateStore(state).toggleListening()).toBe("idle");
    }
  });
});
