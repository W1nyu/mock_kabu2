import { Module } from "@nestjs/common";
import { GatewayModule } from "../gateway/gateway.module";
import { BracketService } from "./bracket.service";
import { ConditionalOrderController } from "./conditional-order.controller";
import { ConditionalOrderService } from "./conditional-order.service";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { OutboxRelayer } from "./outbox.relayer";

@Module({
  imports: [GatewayModule],
  controllers: [OrderController, ConditionalOrderController],
  providers: [OrderService, OutboxRelayer, ConditionalOrderService, BracketService],
  exports: [OutboxRelayer],
})
export class OrderModule {}
