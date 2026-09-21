import { Injectable } from "@nestjs/common";

export type BackgroundStatus = Record<string, unknown>;

/**
 * API 프로세스 안에서 도는 백그라운드 작업(조건부 주문 감시자, 자산 스냅샷 등)의 상태 게시판.
 * 각 서비스가 부팅 시 자기 상태 getter를 등록하고, 헬스 체크가 한 번에 읽는다.
 * Health 모듈이 개별 서비스 모듈을 import하지 않게 하는 얇은 간접층이다.
 */
@Injectable()
export class BackgroundStatusRegistry {
  private readonly providers = new Map<string, () => BackgroundStatus>();

  register(name: string, provider: () => BackgroundStatus): void {
    this.providers.set(name, provider);
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  snapshot(): Record<string, BackgroundStatus> {
    const out: Record<string, BackgroundStatus> = {};
    for (const [name, provider] of this.providers) {
      try {
        out[name] = provider();
      } catch (error) {
        out[name] = { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    }
    return out;
  }
}
