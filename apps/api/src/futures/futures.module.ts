import { Module } from "@nestjs/common";
import { OrderModule } from "../order/order.module";
import { FuturesRiskService } from "./futures-risk.service";
import { FuturesSettlementService } from "./futures-settlement.service";
import { AccountFuturesController, FuturesController, InternalFuturesController, OptionsController } from "./futures.controller";
import { FuturesService } from "./futures.service";
import { OptionsService } from "./options.service";

@Module({
  imports: [OrderModule],
  controllers: [FuturesController, OptionsController, AccountFuturesController, InternalFuturesController],
  providers: [FuturesService, OptionsService, FuturesSettlementService, FuturesRiskService],
})
export class FuturesModule {}
