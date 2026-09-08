import { describe, expect, it, vi } from "vitest";
import { HealthController } from "../health.controller";

function responseMock() {
  const response = { status: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("HealthController", () => {
  it("maps a ready report to HTTP 200", async () => {
    const readiness = vi.fn().mockResolvedValue({ status: "ok" });
    const controller = new HealthController({ readiness, liveness: vi.fn() } as never);
    const response = responseMock();

    await expect(controller.readiness(response as never)).resolves.toEqual({ status: "ok" });
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it("maps an unavailable primary dependency to HTTP 503", async () => {
    const readiness = vi.fn().mockResolvedValue({ status: "error" });
    const controller = new HealthController({ readiness, liveness: vi.fn() } as never);
    const response = responseMock();

    await expect(controller.healthCheck(response as never)).resolves.toEqual({ status: "error" });
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
