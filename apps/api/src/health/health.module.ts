import { Module } from "@nestjs/common";
import { CoreModule } from "../core/core.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [CoreModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
