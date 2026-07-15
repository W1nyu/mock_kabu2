import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIQUIDITY_MIN_AVAILABLE_CASH,
  liquidityMinimumAvailableQty,
  liquidityReserves,
} from "../liquidity-reserve";
import { LiquidityService } from "../liquidity.service";

const originalBootstrapToken = process.env.LIQUIDITY_BOOTSTRAP_TOKEN;

afterEach(() => {
  if (originalBootstrapToken === undefined) delete process.env.LIQUIDITY_BOOTSTRAP_TOKEN;
  else process.env.LIQUIDITY_BOOTSTRAP_TOKEN = originalBootstrapToken;
});

function makeService() {
  const users = new Map<string, { id: string; isBot: boolean }>();
  const accounts = new Map<string, { id: string; userId: string }>();
  const holdingUpserts: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
  const ledgerCreates: Record<string, unknown>[] = [];

  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null),
      create: vi.fn(async ({ data }: { data: { email: string } }) => {
        const user = { id: `user:${data.email}`, isBot: true };
        users.set(data.email, user);
        return user;
      }),
    },
    account: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => accounts.get(where.userId) ?? null),
      create: vi.fn(async ({ data }: { data: { userId: string } }) => {
        const account = { id: `account:${data.userId}`, userId: data.userId };
        accounts.set(data.userId, account);
        return account;
      }),
    },
  };

  const mutator = {
    withAccountLock: vi.fn(async ([accountId]: string[], fn: (ctx: any) => Promise<unknown>) =>
      fn({
        accounts: { [accountId]: { id: accountId, balance: 0n, holdAmount: 0n, version: 0 } },
        updateAccount: vi.fn(async () => {}),
        tx: {
          ledgerEntry: {
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ledgerCreates.push(data)),
          },
          marketSymbol: {
            findUnique: vi.fn(async ({ where }: { where: { symbol: string } }) => ({
              symbol: where.symbol,
              lastPrice: 100,
            })),
          },
          holding: {
            findUnique: vi.fn(async () => null),
            upsert: vi.fn(async (args: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }) => {
              holdingUpserts.push(args);
            }),
          },
        },
      }),
    ),
  };

  return {
    service: new LiquidityService(prisma as never, mutator as never),
    prisma,
    holdingUpserts,
    ledgerCreates,
  };
}

describe("LiquidityService.ensureReserves", () => {
  it("assigns configured listings to deterministic reserves", () => {
    expect(liquidityReserves().map((reserve) => [reserve.symbol.symbol, reserve.email])).toEqual([
      ["MOCK", "bot16@bots.local"],
      ["KABU", "bot17@bots.local"],
      ["TANU", "bot18@bots.local"],
      ["SAKU", "bot19@bots.local"],
      ["NEKO", "bot20@bots.local"],
    ]);
  });

  it("scales the reserve inventory floor for a future low-priced listing and keeps overlap headroom", () => {
    // ₩100 needs 480,000 shares for one ₩48m side; three copies cover the
    // current ladder plus safe post-before-cancel replacement overlap.
    expect(liquidityMinimumAvailableQty(100)).toBe(1_440_000);
    // Current seeded symbols remain on the intentionally generous base floor.
    expect(liquidityMinimumAvailableQty(8_000)).toBe(50_000);
    expect(liquidityMinimumAvailableQty(300_000)).toBe(50_000);
  });

  it("creates only the clean dedicated reserve generation and gives each account only its owned symbol inventory", async () => {
    process.env.LIQUIDITY_BOOTSTRAP_TOKEN = "test-liquidity-token";
    const { service, holdingUpserts, ledgerCreates } = makeService();

    const result = await service.ensureReserves("test-liquidity-token");
    const reserves = liquidityReserves();

    expect(result.reserves.map((reserve) => reserve.email)).toEqual(reserves.map((reserve) => reserve.email));
    expect(result.reserves.every((reserve) => reserve.created)).toBe(true);
    expect(holdingUpserts).toHaveLength(reserves.length);
    expect(holdingUpserts.map((call) => call.create.symbol)).toEqual(
      reserves.map((reserve) => reserve.symbol.symbol),
    );
    expect(holdingUpserts.map((call) => call.create.accountId)).toEqual(
      reserves.map((reserve) => `account:user:${reserve.email}`),
    );
    expect(ledgerCreates).toHaveLength(reserves.length);
    expect(ledgerCreates.every((entry) => entry.reason === "LIQUIDITY_BOOTSTRAP")).toBe(true);
    expect(ledgerCreates.every((entry) => entry.balanceAfter === LIQUIDITY_MIN_AVAILABLE_CASH)).toBe(true);
  });

  it("refuses to adopt a non-bot user in a reserved email slot", async () => {
    process.env.LIQUIDITY_BOOTSTRAP_TOKEN = "test-liquidity-token";
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValueOnce({ id: "human-user", isBot: false });

    await expect(service.ensureReserves("test-liquidity-token")).rejects.toThrow(
      "liquidity reserve email belongs to a non-bot user",
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
