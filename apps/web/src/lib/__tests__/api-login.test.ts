import { describe, expect, it } from "vitest";
import { requiresLogin } from "../api";

describe("requiresLogin", () => {
  it("covers the guarded account and order routes only", () => {
    expect(requiresLogin("/account")).toBe(true);
    expect(requiresLogin("/account/holdings")).toBe(true);
    expect(requiresLogin("/orders?limit=100")).toBe(true);
    expect(requiresLogin("/orders/conditional?symbol=MOCK")).toBe(true);
    // 공개 경로 — 로그인 없이도 서버가 응답한다.
    expect(requiresLogin("/market/symbols")).toBe(false);
    expect(requiresLogin("/admin/lock-info")).toBe(false);
    expect(requiresLogin("/accounting")).toBe(false);
  });
});
