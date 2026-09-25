import { afterEach, describe, expect, it, vi } from "vitest";
import { ORDERBOOK_COALESCE_MS, RealtimeGateway } from "../realtime.gateway";

afterEach(() => vi.useRealTimers());

function gatewayWithRooms(rooms: Record<string, number>) {
  const gateway = new RealtimeGateway({} as never, {} as never, {} as never);
  const emitted: { room: string; data: unknown }[] = [];
  gateway.server = {
    sockets: {
      adapter: { rooms: new Map(Object.entries(rooms).map(([room, size]) => [room, { size }])) },
    },
    to: (room: string) => ({
      emit: (_event: string, payload: { data: unknown }) => emitted.push({ room, data: payload.data }),
    }),
  } as never;
  const relay = (channel: string, data: unknown) =>
    (gateway as unknown as { relayRedisMessage(c: string, m: string): void }).relayRedisMessage(
      `mock-kabu2:${channel}`,
      JSON.stringify(data),
    );
  return { emitted, relay };
}

describe("realtime relay", () => {
  it("skips channels nobody on this process is watching", () => {
    const { emitted, relay } = gatewayWithRooms({ "trades:MOCK": 0 });
    relay("trades:MOCK", { price: 1 });
    relay("trades:KABU", { price: 2 });
    expect(emitted).toHaveLength(0);
  });

  it("sends every trade, but collapses an orderbook burst to the first and the latest snapshot", () => {
    vi.useFakeTimers();
    const { emitted, relay } = gatewayWithRooms({ "trades:MOCK": 1, "orderbook:MOCK": 2 });

    for (let seq = 1; seq <= 3; seq++) relay("trades:MOCK", { seq });
    for (let seq = 1; seq <= 10; seq++) relay("orderbook:MOCK", { seq });

    expect(emitted.filter((e) => e.room === "trades:MOCK")).toHaveLength(3);
    expect(emitted.filter((e) => e.room === "orderbook:MOCK").map((e) => e.data)).toEqual([{ seq: 1 }]);

    vi.advanceTimersByTime(ORDERBOOK_COALESCE_MS);
    expect(emitted.filter((e) => e.room === "orderbook:MOCK").map((e) => e.data)).toEqual([{ seq: 1 }, { seq: 10 }]);

    // A quiet window ends the throttle, so the next snapshot goes out immediately again.
    vi.advanceTimersByTime(ORDERBOOK_COALESCE_MS * 2);
    relay("orderbook:MOCK", { seq: 11 });
    expect(emitted.filter((e) => e.room === "orderbook:MOCK").map((e) => e.data).at(-1)).toEqual({ seq: 11 });
  });
});
