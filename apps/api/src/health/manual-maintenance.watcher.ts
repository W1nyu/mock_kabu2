import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { KEYS } from "@mock-kabu/shared";
import type Redis from "ioredis";
import { parseManualMaintenance, setManualMaintenance } from "../common/maintenance-window";
import { REDIS } from "../core/tokens";

const POLL_MS = 2_000;

/**
 * 운영자가 `KEYS.manualMaintenance`에 거는 임시 점검을 읽어 둔다. 주문 차단(assertTradingOpen)은
 * 동기 경로라 요청마다 Redis를 읽지 않고 이 값을 쓴다. Redis를 못 읽으면 마지막 값을 유지한다.
 *
 *   redis-cli SET mock-kabu2:maintenance:manual '{"startAt":"2026-09-24T10:30:00Z","endAt":"2026-09-24T11:00:00Z","message":"..."}' EX 7200
 *   redis-cli DEL mock-kabu2:maintenance:manual
 */
@Injectable()
export class ManualMaintenanceWatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManualMaintenanceWatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private last: string | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onModuleInit(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const raw = await this.redis.get(KEYS.manualMaintenance());
      if (raw === this.last) return;
      this.last = raw;
      const parsed = parseManualMaintenance(raw);
      setManualMaintenance(parsed);
      this.logger.log(parsed ? `manual maintenance ${new Date(parsed.startAt).toISOString()} ~ ${new Date(parsed.endAt).toISOString()}` : "manual maintenance cleared");
    } catch {
      // keep the previous state until Redis answers again
    }
  }
}
