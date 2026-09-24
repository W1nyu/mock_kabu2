import { describe, expect, it, vi } from "vitest";
import { ScenarioService, parseScenario } from "../scenario.service";

const NOW = Date.parse("2026-09-25T00:00:00Z");
const HOUR = 60 * 60_000;

function valid(overrides: Record<string, unknown> = {}) {
  return {
    symbols: ["TANU"],
    direction: "DOWN",
    intensity: 2,
    startsAt: new Date(NOW + HOUR).toISOString(),
    endsAt: new Date(NOW + 4 * HOUR).toISOString(),
    ...overrides,
  };
}

function setup(isAdmin: boolean) {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin }) },
    marketScenario: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: "s1", canceledAt: null, createdAt: new Date(NOW), ...data }),
      ),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  return { service: new ScenarioService(prisma as never), prisma };
}

describe("market scenarios", () => {
  it("hides the feature from non-admin accounts with a 404 before touching scenarios", async () => {
    const { service, prisma } = setup(false);
    await expect(service.list("user-1")).rejects.toMatchObject({ status: 404 });
    await expect(service.create("user-1", "someone", valid(), NOW)).rejects.toMatchObject({ status: 404 });
    expect(prisma.marketScenario.findMany).not.toHaveBeenCalled();
    expect(prisma.marketScenario.create).not.toHaveBeenCalled();
  });

  it("stores a multi-symbol scenario for the admin with duplicates removed", async () => {
    const { service, prisma } = setup(true);
    const created = await service.create("admin-id", "admin", valid({ symbols: ["TANU", "NEKO", "TANU"] }), NOW);
    expect(created.symbols).toEqual(["TANU", "NEKO"]);
    expect(prisma.marketScenario.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ symbols: ["TANU", "NEKO"], direction: "DOWN", intensity: 2, createdBy: "admin" }),
    });
  });

  it.each([
    [{ symbols: [] }, "종목"],
    [{ symbols: ["NOPE"] }, "없는 종목"],
    [{ direction: "SIDEWAYS" }, "방향"],
    [{ intensity: 4 }, "강도"],
    [{ endsAt: new Date(NOW + HOUR + 60_000).toISOString() }, "5분"],
    [{ endsAt: new Date(NOW + 26 * HOUR).toISOString() }, "24시간"],
    [{ startsAt: new Date(NOW - HOUR).toISOString() }, "지났"],
    [{ startsAt: new Date(NOW + 8 * 24 * HOUR).toISOString(), endsAt: new Date(NOW + 8 * 24 * HOUR + HOUR).toISOString() }, "7일"],
  ])("rejects invalid input %o", (overrides, message) => {
    expect(() => parseScenario(valid(overrides), NOW)).toThrow(message);
  });

  it("only serves the bots with the internal token", async () => {
    const { service } = setup(true);
    await expect(service.internalActive("wrong", NOW)).rejects.toMatchObject({ status: 401 });
  });
});
