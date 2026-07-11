import { Module } from "@nestjs/common";
import { AccountModule } from "./account/account.module";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { CoreModule } from "./core/core.module";
import { GatewayModule } from "./gateway/gateway.module";
import { MarketModule } from "./market/market.module";
import { OrderModule } from "./order/order.module";

@Module({
  imports: [
    CoreModule,
    AuthModule,
    GatewayModule,
    AccountModule,
    OrderModule,
    MarketModule,
    AdminModule,
  ],
})
export class AppModule {}
