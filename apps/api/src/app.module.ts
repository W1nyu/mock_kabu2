import { Module } from "@nestjs/common";
import { AccountModule } from "./account/account.module";
import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { CoreModule } from "./core/core.module";
import { GatewayModule } from "./gateway/gateway.module";
import { HealthModule } from "./health/health.module";
import { LiquidityModule } from "./liquidity/liquidity.module";
import { MarketModule } from "./market/market.module";
import { NewsModule } from "./news/news.module";
import { ReferenceModule } from "./reference/reference.module";
import { FuturesModule } from "./futures/futures.module";
import { OrderModule } from "./order/order.module";
import { ReplayModule } from "./replay/replay.module";
import { ScenarioModule } from "./scenario/scenario.module";

@Module({
  imports: [
    CoreModule,
    HealthModule,
    AuthModule,
    GatewayModule,
    LiquidityModule,
    AccountModule,
    OrderModule,
    MarketModule,
    NewsModule,
    ReferenceModule,
    FuturesModule,
    ReplayModule,
    AdminModule,
    ScenarioModule,
  ],
})
export class AppModule {}
