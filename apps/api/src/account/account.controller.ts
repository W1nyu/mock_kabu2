import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
import { AccountService } from "./account.service";

@Controller("account")
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private account: AccountService) {}

  @Get()
  getAccount(@CurrentUser() user: JwtUser) {
    return this.account.getAccount(user.accountId);
  }

  @Get("holdings")
  getHoldings(@CurrentUser() user: JwtUser) {
    return this.account.getHoldings(user.accountId);
  }

  @Get("ledger")
  getLedger(@CurrentUser() user: JwtUser, @Query("limit") limit?: string) {
    return this.account.getLedger(user.accountId, limit ? Number(limit) : undefined);
  }

  @Post("transfer")
  transfer(
    @CurrentUser() user: JwtUser,
    @Body() body: { toEmail: string; amount: number },
  ) {
    return this.account.transfer(user.accountId, body.toEmail, Number(body.amount));
  }
}
