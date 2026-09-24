import { Module } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";
import { TransferRateLimitGuard } from "../auth/login-rate-limit.guard";
import { EquitySnapshotService } from "./equity-snapshot.service";

@Module({
  imports: [GatewayModule],
  controllers: [AccountController],
  providers: [AccountService, EquitySnapshotService, TransferRateLimitGuard],
  exports: [AccountService],
})
export class AccountModule {}
