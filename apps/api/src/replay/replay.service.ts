import { Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { findReplayDataset, REPLAY_DATASETS } from "./replay.catalog";
import {
  FIXED_REPLAY_CANDLE_COUNT,
  FIXED_REPLAY_DATA_FIXED_AT,
  FIXED_REPLAY_MAX_REPLAY_CANDLE_COUNT,
  FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT,
  fixedReplayCandlesFor,
} from "./fixed-replay-data";
import { replayRangeCandleCount, replayWindowCandleCount, selectReplayRange } from "./replay-range";
import type {
  ReplayCandlesResponse,
  ReplayCatalogEntry,
  ReplayRange,
} from "./replay.types";

// The detailed deterministic band implementation lives in @mock-kabu/shared's
// HybridReplayEngine. This only advertises the replay-page default.
const DEFAULT_HYBRID_MAX_DEVIATION_BPS = 500;

@Injectable()
export class ReplayService {
  datasets(): ReplayCatalogEntry[] {
    return REPLAY_DATASETS.map((dataset) => ({
      ...dataset,
      defaultRange: "6mo",
      preRollCandleCount: FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT,
      maxReplayCandleCount: FIXED_REPLAY_MAX_REPLAY_CANDLE_COUNT,
      maxCandleCount: FIXED_REPLAY_CANDLE_COUNT,
      notice:
        "항상 200개 사전 공개 일봉 뒤에 최대 1,095개를 재생하는 고정 연습 데이터입니다. API 키·네트워크·로컬 CSV에 따라 재생 결과가 바뀌지 않습니다.",
    }));
  }

  candles(datasetId: string, range: ReplayRange): ReplayCandlesResponse {
    const dataset = findReplayDataset(datasetId);
    if (!dataset) throw new NotFoundException(`Unknown replay dataset: ${datasetId}`);

    const candles = selectReplayRange(fixedReplayCandlesFor(dataset), range);
    const replayCandleCount = replayRangeCandleCount(range);
    const totalCandleCount = replayWindowCandleCount(range);
    if (candles.length !== totalCandleCount) {
      throw new InternalServerErrorException(
        `Fixed replay data must contain ${totalCandleCount} candles for ${range}.`,
      );
    }

    return {
      dataset: { ...dataset },
      interval: "1d",
      range,
      // Do not hand cache-owned objects to Nest serialization. This keeps a
      // caller-side mutation from changing a later replay response.
      candles: candles.map((candle) => ({ ...candle })),
      preRollCandleCount: FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT,
      replayCandleCount,
      totalCandleCount,
      source: {
        provider: "bundled-fixed-daily",
        label: "내장 고정 일봉 연습 데이터",
        sourceUrl: null,
        termsUrl: null,
        fixedAt: FIXED_REPLAY_DATA_FIXED_AT,
        notice:
          "모든 종목은 재현 가능한 1,295개 고정 일봉으로 구성됩니다. 선택한 범위에서는 앞의 200개가 먼저 공개되고, 이후 기간만큼만 재생합니다. 실시간·외부 과거 시세가 아니며, Alpha Vantage 키 유무에 따라 바뀌지 않습니다.",
      },
      hybrid: hybridHint(),
    };
  }
}

function hybridHint(): ReplayCandlesResponse["hybrid"] {
  return {
    supported: true,
    defaultMaxDeviationBps: DEFAULT_HYBRID_MAX_DEVIATION_BPS,
    description:
      "혼합 모드의 가상 봇은 고정 기준 경로 대비 ±5% 이내에서만 가격 압력을 더합니다. 이 API는 기존 거래소의 주문·봇·잔액을 바꾸지 않습니다.",
  };
}
