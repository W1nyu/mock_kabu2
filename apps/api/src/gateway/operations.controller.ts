import { Controller, ForbiddenException, Get, Header, Req } from "@nestjs/common";
import type { Request } from "express";
import { RealtimeGateway } from "./realtime.gateway";

@Controller("internal/operations")
export class OperationsController {
  constructor(private readonly gateway: RealtimeGateway) {}

  @Get()
  @Header("Cache-Control", "no-store")
  snapshot(@Req() request: Request) {
    // Only docker exec -> container loopback. Never trust forwarded headers.
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
      throw new ForbiddenException();
    }
    return { timestamp: new Date().toISOString(), uptimeSeconds: process.uptime(),
      memory: process.memoryUsage(), realtime: this.gateway.connectionSnapshot() };
  }
}
