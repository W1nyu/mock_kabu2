import { Module } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { OutboxRelayer } from "./outbox.relayer";

@Module({
  imports: [GatewayModule],
  controllers: [OrderController],
  providers: [OrderService, OutboxRelayer],
})
export class OrderModule {}
