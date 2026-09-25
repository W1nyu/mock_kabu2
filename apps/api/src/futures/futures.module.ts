import { Module } from "@nestjs/common";
import { OrderModule } from "../order/order.module";
import { FuturesSettlementService } from "./futures-settlement.service";
import { AccountFuturesController, FuturesController, InternalFuturesController } from "./futures.controller";
import { FuturesService } from "./futures.service";

@Module({
  imports: [OrderModule],
  controllers: [FuturesController, AccountFuturesController, InternalFuturesController],
  providers: [FuturesService, FuturesSettlementService],
})
export class FuturesModule {}
