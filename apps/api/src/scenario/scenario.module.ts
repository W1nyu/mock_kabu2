import { Module } from "@nestjs/common";
import {
  AdminMarketCycleController,
  AdminScenarioController,
  InternalMarketCycleController,
  InternalScenarioController,
} from "./scenario.controller";
import { MarketCycleService } from "./market-cycle.service";
import { ScenarioService } from "./scenario.service";

@Module({
  controllers: [AdminScenarioController, InternalScenarioController, AdminMarketCycleController, InternalMarketCycleController],
  providers: [ScenarioService, MarketCycleService],
})
export class ScenarioModule {}
