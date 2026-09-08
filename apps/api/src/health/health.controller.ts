import { Controller, Get, Header, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

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
