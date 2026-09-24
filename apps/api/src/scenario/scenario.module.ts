import { Module } from "@nestjs/common";
import { AdminScenarioController, InternalScenarioController } from "./scenario.controller";
import { ScenarioService } from "./scenario.service";

@Module({
  controllers: [AdminScenarioController, InternalScenarioController],
  providers: [ScenarioService],
})
export class ScenarioModule {}
