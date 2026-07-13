import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { PrismaClient } from "@mock-kabu/db";
import { STREAMS } from "@mock-kabu/shared";
import type Redis from "ioredis";
import { PRISMA, REDIS } from "../core/tokens";

/**
 * Transactional Outbox relayer (스펙 3.2):
 * 주문 트랜잭션과 함께 커밋된 outbox 행을 Redis Streams로 발행한다.
 * "DB에는 커밋됐는데 이벤트는 유실" 문제를 차단한다.
 * 발행 후 마킹 사이에 크래시가 나면 중복 발행될 수 있으나(at-least-once),
 * 컨슈머가 eventId로 멱등 처리한다.
 */
@Injectable()
export class OutboxRelayer implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    @Inject(REDIS) private redis: Redis,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), 200);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.prisma.outbox.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: "asc" },
        take: 100,
      });
      for (const row of rows) {
        await this.redis.xadd(STREAMS.ORDERS, "*", "payload", JSON.stringify(row.payload));
        await this.prisma.outbox.update({
          where: { eventId: row.eventId },
          data: { publishedAt: new Date() },
        });
      }
    } catch (e) {
      console.error("[outbox] flush failed", e);
    } finally {
      this.busy = false;
    }
  }
}
