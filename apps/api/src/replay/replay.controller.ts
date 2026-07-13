import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { REPLAY_RANGES, type ReplayRange, type ReplaySourcePreference } from "./replay.types";
import { ReplayService } from "./replay.service";

@Controller("replay")
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  @Get("datasets")
  datasets() {
    return {
      datasets: this.replay.datasets(),
      priceEncoding: "integer minor units (USD cents for the current catalog)",
      tradingIsolation:
        "Replay data is read-only. It does not add symbols, orders, trades, balances, or bot activity to the existing local exchange.",
    };
  }

  @Get("datasets/:datasetId/candles")
  candles(
    @Param("datasetId") datasetId: string,
    @Query("range") range?: string,
    @Query("source") source?: string,
  ) {
    return this.replay.candles(datasetId, parseRange(range), parseSource(source));
  }
}

function parseRange(value: string | undefined): ReplayRange {
  const range = value ?? "6mo";
  if (!(REPLAY_RANGES as readonly string[]).includes(range)) {
    throw new BadRequestException(`range must be one of: ${REPLAY_RANGES.join(", ")}`);
  }
  return range as ReplayRange;
}

function parseSource(value: string | undefined): ReplaySourcePreference {
  const source = value ?? "auto";
  if (source !== "auto" && source !== "fixture") {
    throw new BadRequestException("source must be auto or fixture");
  }
  return source;
}
