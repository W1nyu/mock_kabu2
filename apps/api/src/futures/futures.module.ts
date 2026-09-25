import { Module } from "@nestjs/common";
import { AccountFuturesController, FuturesController } from "./futures.controller";
import { FuturesService } from "./futures.service";

@Module({
  controllers: [FuturesController, AccountFuturesController],
  providers: [FuturesService],
})
export class FuturesModule {}
