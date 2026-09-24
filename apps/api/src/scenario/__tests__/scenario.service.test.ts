import { describe, expect, it, vi } from "vitest";
import { ScenarioService, firstFreeStart, parseScenario } from "../scenario.service";

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
  const prisma: Record<string, any> = {
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin }) },
    marketScenario: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: "s1", canceledAt: null, createdAt: new Date(NOW), ...data }),
      ),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  prisma.$transaction = vi.fn((run: (tx: unknown) => unknown) => run(prisma));
  return { service: new ScenarioService(prisma as never), prisma };
}

const at = (ms: number) => new Date(ms);

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

  it("finds the first free slot after every overlapping window", () => {
    const taken = [
      { startsAt: at(NOW + HOUR), endsAt: at(NOW + 2 * HOUR) },
      { startsAt: at(NOW + 2 * HOUR + 10 * 60_000), endsAt: at(NOW + 3 * HOUR) },
    ];
    // 30 minutes do not fit into the 10-minute gap, so both windows push it back.
    expect(firstFreeStart(NOW + HOUR + 60_000, 30 * 60_000, taken)).toBe(NOW + 3 * HOUR);
    // 10 minutes do fit into the gap.
    expect(firstFreeStart(NOW + HOUR + 60_000, 10 * 60_000, taken)).toBe(NOW + 2 * HOUR);
    // A window that ends before the request starts is ignored.
    expect(firstFreeStart(NOW + 4 * HOUR, HOUR, taken)).toBe(NOW + 4 * HOUR);
  });

  it("starts an overlapping scenario after the one already booked on the same symbol", async () => {
    const { service, prisma } = setup(true);
    prisma.marketScenario.findMany.mockResolvedValue([{ startsAt: at(NOW + HOUR), endsAt: at(NOW + 2 * HOUR) }]);
    const created = await service.create(
      "admin-id",
      "admin",
      valid({ startsAt: at(NOW + HOUR + 30 * 60_000).toISOString(), endsAt: at(NOW + 2 * HOUR + 30 * 60_000).toISOString() }),
      NOW,
    );
    expect(created.startsAt).toBe(at(NOW + 2 * HOUR).toISOString());
    expect(created.endsAt).toBe(at(NOW + 3 * HOUR).toISOString());
    expect(created.requestedStartsAt).toBe(at(NOW + HOUR + 30 * 60_000).toISOString());
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.marketScenario.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ canceledAt: null, symbols: { hasSome: ["TANU"] } }),
    }));
  });

  it("reports no shift when the requested window is free", async () => {
    const { service } = setup(true);
    const created = await service.create("admin-id", "admin", valid(), NOW);
    expect(created.requestedStartsAt).toBeNull();
    expect(created.startsAt).toBe(at(NOW + HOUR).toISOString());
  });

  it("deletes canceled or finished scenarios but refuses pending and running ones", async () => {
    const { service, prisma } = setup(true);
    const row = (overrides: Record<string, unknown>) => ({
      id: "s1", startsAt: at(NOW - 2 * HOUR), endsAt: at(NOW + HOUR), canceledAt: null, ...overrides,
    });

    prisma.marketScenario.findUnique.mockResolvedValueOnce(row({}));
    await expect(service.remove("admin-id", "s1", NOW)).rejects.toMatchObject({ status: 400 });

    prisma.marketScenario.findUnique.mockResolvedValueOnce(row({ canceledAt: at(NOW - HOUR) }));
    await expect(service.remove("admin-id", "s1", NOW)).resolves.toEqual({ id: "s1" });

    prisma.marketScenario.findUnique.mockResolvedValueOnce(row({ endsAt: at(NOW - HOUR) }));
    await expect(service.remove("admin-id", "s1", NOW)).resolves.toEqual({ id: "s1" });
    expect(prisma.marketScenario.delete).toHaveBeenCalledTimes(2);
  });
});
