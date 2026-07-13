import { Controller, Headers, Post } from "@nestjs/common";
import { LiquidityService } from "./liquidity.service";

/** Internal endpoint used only by the local bots process before it logs in. */
@Controller("internal/liquidity")
export class LiquidityController {
  constructor(private liquidity: LiquidityService) {}

  @Post("ensure")
  ensure(@Headers("x-liquidity-bootstrap-token") token?: string) {
    return this.liquidity.ensureReserves(token);
  }
}

