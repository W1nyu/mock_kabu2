import { Controller, Get, Inject } from "@nestjs/common";
import type { BalanceMutator } from "@mock-kabu/concurrency";
import { BALANCE_MUTATOR } from "../core/tokens";

/** 동시성 실험 관전 모드 (스펙 §6): 현재 락 전략과 충돌/재시도 카운터 노출 */
@Controller("admin")
export class AdminController {
  constructor(@Inject(BALANCE_MUTATOR) private mutator: BalanceMutator) {}

  @Get("lock-info")
  lockInfo() {
    return this.mutator.getCounters();
  }
}
