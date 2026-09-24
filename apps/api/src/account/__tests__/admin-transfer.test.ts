import { describe, expect, it, vi } from "vitest";
import * as bcrypt from "bcryptjs";
import { AccountService } from "../account.service";

function setup(isAdmin: boolean) {
  const user = { id: "user-1", isAdmin, passwordHash: bcrypt.hashSync("private-test-secret", 4) };
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      findMany: vi.fn().mockResolvedValue([{ id: "user-2", nickname: "investor" }]),
      count: vi.fn().mockResolvedValue(1),
    },
    account: { findUnique: vi.fn().mockResolvedValue({ id: "account-2" }) },
  };
  const mutator = { strategy: "pessimistic", withAccountLock: vi.fn() };
  const service = new AccountService(prisma as never, mutator as never, { notifyAccount: vi.fn() } as never);
  return { service, prisma, mutator };
}

describe("admin transfers", () => {
  it("requires the stored password before touching any recipient or balance", async () => {
    const { service, prisma, mutator } = setup(true);
    await expect(service.transfer("account-1", "investor", 100, "user-1", "wrong"))
      .rejects.toMatchObject({ status: 403 });
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(mutator.withAccountLock).not.toHaveBeenCalled();
  });

  it("rejects amounts that cannot be represented exactly by JavaScript", async () => {
    const { service, mutator } = setup(true);
    await expect(service.transfer("account-1", "investor", Number.MAX_SAFE_INTEGER + 1, "user-1", "private-test-secret"))
      .rejects.toMatchObject({ status: 400 });
    expect(mutator.withAccountLock).not.toHaveBeenCalled();
  });

  it("allows only the persisted admin role to search non-bot recipients", async () => {
    const ordinary = setup(false);
    await expect(ordinary.service.adminRecipients("user-1", "inv"))
      .rejects.toMatchObject({ status: 403 });
    const admin = setup(true);
    expect(await admin.service.adminRecipients("user-1", "inv")).toEqual({ total: 1, rows: [{ id: "user-2", nickname: "investor" }] });
    expect(admin.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isBot: false, isAdmin: false, NOT: { nickname: { startsWith: "smoke-" } }, nickname: { contains: "inv", mode: "insensitive" } },
    }));
  });

  it("records one atomic distribution and returns the committed result on a retry", async () => {
    const { service, prisma } = setup(true);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(2).mockResolvedValueOnce(0),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([
        { id: "account-1", balance: 1000n, hold_amount: 0n },
        { id: "account-2", balance: 50n, hold_amount: 0n },
        { id: "account-3", balance: 75n, hold_amount: 0n },
      ]),
      account: { update: vi.fn().mockResolvedValue({}) },
      ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
      adminDistribution: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ accountId: "account-1", amountEach: 100n, recipientCount: 2, total: 200n }),
      },
    };
    Object.assign(prisma, { $transaction: vi.fn((fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) });
    const requestId = "7b62f9bb-bc7b-4ad4-a8f4-8ba1e9ee32a2";
    expect(await service.transferAll("account-1", "user-1", 100, "private-test-secret", requestId))
      .toMatchObject({ recipients: 2, total: "200", replay: false });
    expect(tx.account.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { balance: { decrement: 200n }, version: { increment: 1 } },
    }));
    expect(tx.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ delta: -200n, balanceAfter: 800n }),
    }));
    expect(await service.transferAll("account-1", "user-1", 100, "private-test-secret", requestId))
      .toMatchObject({ recipients: 2, total: "200", replay: true });
    expect(tx.account.update).toHaveBeenCalledTimes(1);
  });

  it("does not debit a distribution when the available balance cannot fund everyone", async () => {
    const { service, prisma } = setup(true);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([
        { id: "account-1", balance: 150n, hold_amount: 20n },
        { id: "account-2", balance: 0n, hold_amount: 0n },
        { id: "account-3", balance: 0n, hold_amount: 0n },
      ]),
      account: { update: vi.fn() },
      ledgerEntry: { create: vi.fn() },
    };
    Object.assign(prisma, { $transaction: vi.fn((fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) });
    await expect(service.transferAll("account-1", "user-1", 100, "private-test-secret", "7b62f9bb-bc7b-4ad4-a8f4-8ba1e9ee32a2"))
      .rejects.toMatchObject({ status: 422 });
    expect(tx.account.update).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });
});
