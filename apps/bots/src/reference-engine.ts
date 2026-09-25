import { REFERENCE_ASSETS, fromReferenceUnits, type ReferenceCode } from "@mock-kabu/shared";
import type { ApiClient } from "./client";
import type { NewsItem, NewsSink } from "./news/types";
import { ReferencePriceModel } from "./reference-model";

const TICK_MS = 1_000;

/** 기사에 붙은 기초자산 충격(뉴스 생성기가 기사 숫자와 같은 식으로 계산)을 가격 모델에 옮기는 전송 대상. */
export class ReferenceNewsSink implements NewsSink {
  constructor(private readonly model: Pick<ReferencePriceModel, "applyMove">) {}

  publish(item: NewsItem): void {
    for (const move of item.referenceMoves ?? []) this.model.applyMove(move.code, move.move);
  }
}

/**
 * 기초자산 가격을 1초마다 만들어 API로 보낸다. 재시작하면 API에 남은 마지막 값에서 이어 간다.
 * 전송이 실패해도 가격 모델은 계속 돈다 — 다음 전송이 최신값을 보낸다.
 */
export async function startReferenceEngine(client: ApiClient): Promise<{ model: ReferencePriceModel; stop(): void }> {
  const initial: Partial<Record<ReferenceCode, number>> = {};
  try {
    const rows = await client.referenceOverview();
    for (const row of rows) {
      const def = REFERENCE_ASSETS.find((asset) => asset.code === row.code);
      if (def && row.value) initial[def.code] = fromReferenceUnits(row.value, def);
    }
  } catch (error) {
    console.warn("[reference] could not restore last prices; starting from anchors", error instanceof Error ? error.message : error);
  }

  const model = new ReferencePriceModel(undefined, initial);
  let last = Date.now();
  let failures = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    model.tick((now - last) / 1000);
    last = now;
    client
      .publishReference(now, model.snapshotUnits())
      .then(() => {
        failures = 0;
      })
      .catch((error) => {
        // 1초마다 도는 루프라 매번 찍지 않는다.
        if (failures++ % 30 === 0) {
          console.warn("[reference] publish failed", error instanceof Error ? error.message : error);
        }
      });
  }, TICK_MS);
  console.log(
    `[reference] started: ${REFERENCE_ASSETS.map((asset) => `${asset.code}=${model.value(asset.code).toFixed(asset.decimals)}`).join(", ")}`,
  );
  return { model, stop: () => clearInterval(timer) };
}
