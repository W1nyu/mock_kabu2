import { describe, expect, it, vi } from "vitest";
import { OperationsController } from "../operations.controller";
import { RealtimeGateway } from "../realtime.gateway";

describe("operator snapshots", () => {
  it("rejects proxy traffic even with spoofed loopback forwarding", () => {
    const snapshot = vi.fn();
    const controller = new OperationsController({ connectionSnapshot: snapshot } as never);
    expect(() => controller.snapshot({ socket: { remoteAddress: "172.18.0.4" },
      headers: { "x-forwarded-for": "127.0.0.1" } } as never)).toThrow();
    expect(snapshot).not.toHaveBeenCalled();
    expect(controller.snapshot({ socket: { remoteAddress: "::ffff:127.0.0.1" } } as never)).toHaveProperty("uptimeSeconds");
  });
  it("distinguishes tabs from unique authenticated accounts without exposing IDs", () => {
    const gateway = new RealtimeGateway({} as never, {} as never, {} as never);
    gateway.server = { sockets: { sockets: new Map([
      ["a", { data: { accountId: "private-id" } }], ["b", { data: { accountId: "private-id" } }],
      ["c", { data: {} }],
    ]) } } as never;
    const result = gateway.connectionSnapshot();
    expect(result).toMatchObject({ connectedSockets: 3, authenticatedSockets: 2,
      uniqueAuthenticatedAccounts: 1, anonymousSockets: 1 });
    expect(JSON.stringify(result)).not.toContain("private-id");
  });
});
