import { REFERENCE_ASSETS, fromReferenceUnits, type ReferenceCode } from "@mock-kabu/shared";
import type { ApiClient } from "./client";
import { templateById } from "./news/catalog";
import type { NewsItem, NewsSink } from "./news/types";
import { ReferencePriceModel } from "./reference-model";

const TICK_MS = 1_000;

/** 시장 전체 기사를 기초자산 충격으로 옮기는 뉴스 전송 대상. */
export class ReferenceNewsSink implements NewsSink {
  constructor(private readonly model: ReferencePriceModel) {}

  publish(item: NewsItem): void {
    if (item.scope !== "MACRO") return;
    const template = templateById(item.templateId);
    if (!template?.macroChannel || !template.macroDirection) return;
    // 종목별 충격은 베타가 곱해진 값이라, 평균을 기사 자체의 강도로 쓴다.
    const strength = item.impact.reduce((sum, impact) => sum + impact.strength, 0) / Math.max(1, item.impact.length);
    this.model.applyNews({
      channel: template.macroChannel,
      direction: template.macroDirection,
      strength,
      commodity: item.slotValues.commodity ?? null,
    });
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
