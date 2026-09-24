import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth.service";

describe("reserved administrator identity", () => {
  it("rejects registration and renaming to admin before a seed account exists", async () => {
    const prisma = { user: { findFirst: vi.fn(), findUnique: vi.fn() } };
    const auth = new AuthService(prisma as never, {} as never);
    await expect(auth.signup("ADMIN", "ordinary-password")).rejects.toMatchObject({ status: 409 });
    await expect(auth.updateNickname("ordinary-user", "admin")).rejects.toMatchObject({ status: 409 });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("keeps the seeded administrator nickname fixed", async () => {
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: true }), findFirst: vi.fn() } };
    const auth = new AuthService(prisma as never, {} as never);
    await expect(auth.updateNickname("admin-user", "another-name")).rejects.toMatchObject({ status: 400 });
  });
});
