import { Injectable } from "@nestjs/common";

interface Entry {
  value: unknown;
  expiresAt: number;
  /** 이 시각까지는 만료됐어도 이전 값을 바로 돌려주고 뒤에서 다시 계산한다(stale-while-revalidate). */
  staleUntil: number;
}

export interface MemoOptions {
  /** 만료 뒤에도 이만큼은 이전 값을 즉시 돌려주고 백그라운드에서 갱신한다. 기본 0(기다림). */
  staleMs?: number;
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

  async getOrCompute<T>(key: string, ttlMs: number, compute: () => Promise<T>, options: MemoOptions = {}): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value as T;
    // 만료 직후라면 기다리게 하지 않는다 — 이전 값을 주고, 갱신은 single-flight로 한 번만 돌린다.
    if (hit && hit.staleUntil > now) {
      if (!this.inflight.has(key)) this.refresh(key, ttlMs, compute, options).catch(() => undefined);
      return hit.value as T;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    return this.refresh(key, ttlMs, compute, options);
  }

  private refresh<T>(key: string, ttlMs: number, compute: () => Promise<T>, options: MemoOptions): Promise<T> {
    const task = compute()
      .then((value) => {
        const expiresAt = Date.now() + ttlMs;
        this.entries.set(key, { value, expiresAt, staleUntil: expiresAt + (options.staleMs ?? 0) });
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
    for (const [key, entry] of this.entries) if (Math.max(entry.expiresAt, entry.staleUntil) <= now) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
