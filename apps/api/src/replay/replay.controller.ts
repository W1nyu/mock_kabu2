import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { REPLAY_RANGES, type ReplayRange } from "./replay.types";
import { ReplayService } from "./replay.service";

@Controller("replay")
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  @Get("datasets")
  datasets() {
    return {
      datasets: this.replay.datasets(),
      priceEncoding: "integer units at each dataset priceScale (for example USD cents or whole KRW)",
      tradingIsolation:
        "Replay data is read-only. It does not add symbols, orders, trades, balances, or bot activity to the existing local exchange.",
    };
  }

  @Get("datasets/:datasetId/candles")
  candles(
    @Param("datasetId") datasetId: string,
    @Query("range") range?: string,
  ) {
    return this.replay.candles(datasetId, parseRange(range));
  }
}

function parseRange(value: string | undefined): ReplayRange {
  const range = value ?? "6mo";
  if (!(REPLAY_RANGES as readonly string[]).includes(range)) {
    throw new BadRequestException(`range must be one of: ${REPLAY_RANGES.join(", ")}`);
  }
  return range as ReplayRange;
}
