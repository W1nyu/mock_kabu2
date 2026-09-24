import { Controller, Get, Header, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { maintenanceWindow, upcomingManualMaintenance } from "../common/maintenance-window";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("maintenance")
  @Header("Cache-Control", "no-store")
  maintenance() {
    const upcoming = upcomingManualMaintenance();
    return {
      ...maintenanceWindow(),
      // 아직 시작 전인 임시 점검 — 웹이 미리 배너로 알린다.
      upcoming: upcoming
        ? { startAt: new Date(upcoming.startAt).toISOString(), endAt: new Date(upcoming.endAt).toISOString(), message: upcoming.message }
        : null,
    };
  }

  /** Default platform health check: only route traffic when data stores are ready. */
  @Get()
  @Header("Cache-Control", "no-store")
  healthCheck(@Res({ passthrough: true }) response: Response) {
    return this.respondReady(response);
  }

  @Get("ready")
  @Header("Cache-Control", "no-store")
  readiness(@Res({ passthrough: true }) response: Response) {
    return this.respondReady(response);
  }

  /** End-to-end order-path readiness, including matching and settlement workers. */
  @Get("trading")
  @Header("Cache-Control", "no-store")
  tradingReadiness(@Res({ passthrough: true }) response: Response) {
    return this.respondTradingReady(response);
  }

  /** Process liveness intentionally does not depend on PostgreSQL or Redis. */
  @Get("live")
  @Header("Cache-Control", "no-store")
  liveness() {
    return this.health.liveness();
  }

  private async respondReady(response: Response) {
    const report = await this.health.readiness();
    response.status(report.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  private async respondTradingReady(response: Response) {
    const report = await this.health.tradingReadiness();
    response.status(report.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
