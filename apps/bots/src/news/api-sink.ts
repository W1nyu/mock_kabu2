import type { ApiClient } from "../client";
import { templateById } from "./catalog";
import type { NewsItem, NewsSink } from "./types";

/**
 * Records each story with the API so it can be persisted and broadcast.
 *
 * Publishing is fire-and-forget on purpose. The price effect has already been
 * applied in-process by the scheduler before the sink runs, so a failed POST
 * costs the feed one headline but never desynchronises the market from it.
 */
export class ApiNewsSink implements NewsSink {
  constructor(private readonly client: ApiClient) {}

  publish(item: NewsItem): void {
    const template = templateById(item.templateId);

    // A market-wide or industry story has one impact per symbol, each with its own
    // direction. The single recorded pair is the template's own reading plus
    // the average magnitude — enough to analyse later, and never shown to a user.
    const sentiment = template?.sentiment ?? item.impact[0]?.sentiment ?? "POSITIVE";
    const meanStrength =
      item.impact.reduce((sum, impact) => sum + impact.strength, 0) / Math.max(1, item.impact.length);

    void this.client
      .publishNews({
        externalId: item.id,
        parentExternalId: item.parentItemId,
        symbol: item.symbol,
        industry: item.industry,
        category: item.category,
        headline: item.headline,
        body: item.body,
        sentiment,
        impact: Math.round(meanStrength * 100),
        // 선물·원자재 화면의 관련 뉴스 필터 — 이 기사가 움직인 기초자산
        referenceCodes: [...new Set((item.referenceMoves ?? []).map((move) => move.code))],
        ...(item.translations ? { translations: item.translations } : {}),
      })
      .catch((error) => {
        console.error("[news] publish failed:", error instanceof Error ? error.message : error);
      });
  }
}
