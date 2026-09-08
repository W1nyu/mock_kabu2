import { describe, expect, it, vi } from "vitest";
import { CHANNELS, NEWS_FEED_SCOPE } from "@mock-kabu/shared";
import { RealtimeGateway } from "../realtime.gateway";

function socket(accountId = "account-1") {
  const rooms = new Set<string>();
  return {
    id: `socket-${accountId}`,
    data: { accountId },
    rooms,
    join: vi.fn((channel: string) => rooms.add(channel)),
    leave: vi.fn((channel: string) => rooms.delete(channel)),
  };
}

function redisSubscriber() {
  return {
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(0),
  };
}

describe("RealtimeGateway room authorization", () => {
  it("joins only active public market rooms and the caller's own account room", () => {
    const sub = redisSubscriber();
    const gateway = new RealtimeGateway(sub as never, {} as never, {} as never);
    const client = socket();

    gateway.join(client as never, [
      "trades:KABU",
      "orderbook:MOCK",
      "trades:UNKNOWN",
      "orderbook:KABU:extra",
      "account:account-1",
      "account:account-2",
      "anything:KABU",
    ]);

    expect(client.join).toHaveBeenCalledTimes(3);
    expect(client.join).toHaveBeenCalledWith("trades:KABU");
    expect(client.join).toHaveBeenCalledWith("orderbook:MOCK");
    expect(client.join).toHaveBeenCalledWith("account:account-1");
    expect(sub.subscribe).toHaveBeenCalledWith(CHANNELS.account("account-1"));
  });

  it("treats news rooms as public, including the firehose scope", () => {
    const gateway = new RealtimeGateway(redisSubscriber() as never, {} as never, {} as never);
    const client = socket();

    gateway.join(client as never, [
      `news:${NEWS_FEED_SCOPE}`,
      "news:KABU",
      "news:UNKNOWN",
      "news:KABU:extra",
    ]);

    // The feed is public like trades and depth, but an unlisted symbol is not
    // a valid scope and a three-segment name is not a room at all.
    expect(client.join).toHaveBeenCalledTimes(2);
    expect(client.join).toHaveBeenCalledWith(`news:${NEWS_FEED_SCOPE}`);
    expect(client.join).toHaveBeenCalledWith("news:KABU");
  });

  it("bounds each room control message and ignores malformed payloads", () => {
    const gateway = new RealtimeGateway(redisSubscriber() as never, {} as never, {} as never);
    const client = socket();

    gateway.join(client as never, Array.from({ length: 40 }, () => "trades:KABU"));
    gateway.leave(client as never, { not: "an array" });

    expect(client.join).toHaveBeenCalledTimes(32);
    expect(client.leave).not.toHaveBeenCalled();
  });

  it("keeps one private Redis subscription for repeated joins and releases it after the final leave", async () => {
    const sub = redisSubscriber();
    const gateway = new RealtimeGateway(sub as never, {} as never, {} as never);
    const client = socket();

    gateway.join(client as never, ["account:account-1"]);
    gateway.join(client as never, ["account:account-1"]);
    expect(sub.subscribe).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    gateway.leave(client as never, ["account:account-1"]);

    expect(sub.unsubscribe).toHaveBeenCalledWith(CHANNELS.account("account-1"));
  });
});
