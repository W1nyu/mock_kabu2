import { Module } from "@nestjs/common";
import { CoreModule } from "../core/core.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { ManualMaintenanceWatcher } from "./manual-maintenance.watcher";

@Module({
  imports: [CoreModule],
  controllers: [HealthController],
  providers: [HealthService, ManualMaintenanceWatcher],
})
export class HealthModule {}
