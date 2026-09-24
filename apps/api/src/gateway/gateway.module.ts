import { Module } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway";
import { OperationsController } from "./operations.controller";

@Module({
  controllers: [OperationsController],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class GatewayModule {}
