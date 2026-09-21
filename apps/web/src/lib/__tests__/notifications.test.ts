import { beforeEach, describe, expect, test, vi } from "vitest";

// lib/notifications는 window·localStorage에 기대므로 node 환경에 최소한의 흉내를 둔다.
function fakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

const listeners = new Map<string, Set<() => void>>();
const fakeWindow = {
  localStorage: fakeStorage(),
  addEventListener: (type: string, fn: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  },
  removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  dispatchEvent: (event: { type: string }) => {
    listeners.get(event.type)?.forEach((fn) => fn());
    return true;
  },
};
vi.stubGlobal("window", fakeWindow);
vi.stubGlobal("Event", class { constructor(public type: string) {} });

const mod = await import("../notifications");

describe("notifications store", () => {
  beforeEach(() => {
    fakeWindow.localStorage = fakeStorage();
    listeners.clear();
  });

  test("keeps newest first, drops duplicates and caps at 50 per account", () => {
    for (let i = 0; i < 55; i += 1) {
      mod.pushNotification("acct", { id: `n${i}`, ts: i, tone: "info", title: `t${i}` });
    }
    mod.pushNotification("acct", { id: "n54", ts: 999, tone: "info", title: "dup" });
    const items = mod.listNotifications("acct");
    expect(items).toHaveLength(50);
    expect(items[0].id).toBe("n54");
    expect(items[0].title).toBe("t54");
    expect(mod.listNotifications("other")).toEqual([]);
  });

  test("unread is everything after the last read mark", () => {
    mod.pushNotification("acct", { id: "a", ts: 100, tone: "up", title: "a" });
    expect(mod.lastReadAt("acct")).toBe(0);
    vi.spyOn(Date, "now").mockReturnValue(150);
    mod.markAllRead("acct");
    expect(mod.lastReadAt("acct")).toBe(150);
    mod.pushNotification("acct", { id: "b", ts: 200, tone: "up", title: "b" });
    const unread = mod.listNotifications("acct").filter((item) => item.ts > mod.lastReadAt("acct"));
    expect(unread.map((item) => item.id)).toEqual(["b"]);
    vi.restoreAllMocks();
  });

  test("notifies same-tab listeners on every change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const off = mod.onNotificationsChange(listener);
    mod.pushNotification("acct", { id: "x", ts: 1, tone: "warn", title: "x" });
    mod.clearNotifications("acct");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    mod.markAllRead("acct");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(mod.listNotifications("acct")).toEqual([]);
  });
});
