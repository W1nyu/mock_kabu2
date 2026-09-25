import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { everyVisible } from "../visible-interval";

/** node 환경이라 탭 가시성만 흉내 낸다. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const setVisibility = (state: "visible" | "hidden") => {
    doc.visibilityState = state;
    for (const fn of listeners) fn();
  };
  return { doc, setVisibility, listeners };
}

describe("everyVisible", () => {
  let env: ReturnType<typeof fakeDocument>;
  beforeEach(() => {
    vi.useFakeTimers();
    env = fakeDocument();
    vi.stubGlobal("document", env.doc);
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("polls while visible, sends nothing while hidden, and catches up once on return", () => {
    const fn = vi.fn();
    const stop = everyVisible(fn, 1_000);

    vi.advanceTimersByTime(3_000);
    expect(fn).toHaveBeenCalledTimes(3);

    env.setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(3);

    env.setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(4);

    stop();
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(env.listeners.size).toBe(0);
  });

  it("does not fire an extra call when the tab was hidden only briefly between ticks", () => {
    const fn = vi.fn();
    everyVisible(fn, 1_000);
    vi.advanceTimersByTime(400);
    env.setVisibility("hidden");
    env.setVisibility("visible");
    expect(fn).not.toHaveBeenCalled();
  });
});
