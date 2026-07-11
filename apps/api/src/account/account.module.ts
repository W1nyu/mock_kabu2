import { Module } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";
import { SettlementConsumer } from "./settlement.consumer";

@Module({
  imports: [GatewayModule],
  controllers: [AccountController],
  providers: [AccountService, SettlementConsumer],
  exports: [AccountService],
})
export class AccountModule {}
