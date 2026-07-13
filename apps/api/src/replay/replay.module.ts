import { Module } from "@nestjs/common";
import { AlphaVantageDailyProvider } from "./alpha-vantage-daily.provider";
import { LocalCsvReplayProvider } from "./local-csv.provider";
import { ReplayController } from "./replay.controller";
import {
  REPLAY_ALPHA_VANTAGE_PROVIDER,
  REPLAY_LOCAL_CSV_PROVIDER,
  ReplayService,
} from "./replay.service";

@Module({
  controllers: [ReplayController],
  providers: [
    ReplayService,
    {
      provide: REPLAY_ALPHA_VANTAGE_PROVIDER,
      useFactory: () => new AlphaVantageDailyProvider(process.env.ALPHA_VANTAGE_API_KEY),
    },
    {
      provide: REPLAY_LOCAL_CSV_PROVIDER,
      useFactory: () => new LocalCsvReplayProvider(process.env.REPLAY_HISTORICAL_CSV_DIR),
    },
  ],
})
export class ReplayModule {}
