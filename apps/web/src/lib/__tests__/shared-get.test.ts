import { afterEach, describe, expect, it, vi } from "vitest";
import { sharedGet } from "../api";

function stubFetch(responses: (() => Response)[]) {
  const fetchMock = vi.fn(async () => responses.shift()!());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sharedGet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("merges concurrent requests for the same public path into one fetch", async () => {
    const fetchMock = stubFetch([() => new Response(JSON.stringify([{ symbol: "KABU" }]), { status: 200 })]);
    const [a, b] = await Promise.all([sharedGet("/market/symbols?t=merge"), sharedGet("/market/symbols?t=merge")]);
    expect(a).toEqual([{ symbol: "KABU" }]);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches again after the ttl and does not keep a failed request", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch([
      () => new Response("{}", { status: 500 }),
      () => new Response(JSON.stringify([1]), { status: 200 }),
      () => new Response(JSON.stringify([2]), { status: 200 }),
    ]);
    await expect(sharedGet("/market/symbols?t=ttl")).rejects.toThrow();
    expect(await sharedGet("/market/symbols?t=ttl")).toEqual([1]);
    vi.advanceTimersByTime(2_500);
    expect(await sharedGet("/market/symbols?t=ttl")).toEqual([2]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
