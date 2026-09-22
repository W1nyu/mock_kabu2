import { Injectable } from "@nestjs/common";

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * 프로세스 안의 짧은 TTL 캐시 + single-flight. 대시보드가 열린 브라우저마다 같은 요약·지수·
 * 랭킹 쿼리를 15~30초마다 던지므로, 몇 초만 재사용해도 DB 부하가 접속 수에 비례해 늘지 않는다.
 * 같은 키의 계산이 진행 중이면 결과를 공유해 스파이크 때 중복 실행을 막는다.
 * 복제본 간 공유는 하지 않는다(값이 몇 초 안에 수렴하는 통계라 굳이 Redis를 거칠 이유가 없다).
 */
@Injectable()
export class MemoCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private sweepCounter = 0;

  async getOrCompute<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const task = compute()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        this.maybeSweep();
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  invalidate(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  /** 만료 항목이 쌓이지 않게 가끔 훑는다. 키 종류가 수십 개 수준이라 비용은 무시할 만하다. */
  private maybeSweep(): void {
    if (++this.sweepCounter % 200 !== 0) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
