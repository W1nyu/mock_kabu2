import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { JwtUser } from "../auth/auth.service";
import { AccountService, type LeaderboardPeriod } from "./account.service";
import { EquitySnapshotService, type EquityRange } from "./equity-snapshot.service";

@Controller("account")
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(
    private account: AccountService,
    private equity: EquitySnapshotService,
  ) {}

  @Get()
  getAccount(@CurrentUser() user: JwtUser) {
    return this.account.getAccount(user.accountId);
  }

  @Get("holdings")
  getHoldings(@CurrentUser() user: JwtUser) {
    return this.account.getHoldings(user.accountId);
  }

  @Get("realized")
  getRealizedPnl(@CurrentUser() user: JwtUser, @Query("limit") limit?: string) {
    return this.account.getRealizedPnl(user.accountId, limit ? Number(limit) : undefined);
  }

  @Get("trades")
  getTrades(
    @CurrentUser() user: JwtUser,
    @Query("limit") limit?: string,
    @Query("symbol") symbol?: string,
  ) {
    return this.account.getTrades(user.accountId, limit ? Number(limit) : undefined, symbol || undefined);
  }

  /** 자산 추이. range=1d(1분)·1w(10분)·all(1시간) 버킷의 마지막 스냅샷. */
  @Get("equity")
  getEquity(@CurrentUser() user: JwtUser, @Query("range") range?: string) {
    const normalized: EquityRange = range === "1w" || range === "all" ? range : "1d";
    return this.equity.series(user.accountId, normalized);
  }

  @Get("leaderboard")
  getLeaderboard(@CurrentUser() user: JwtUser, @Query("limit") limit?: string, @Query("period") period?: string) {
    const normalized: LeaderboardPeriod = period === "today" || period === "week" ? period : "all";
    return this.account.getLeaderboard(user.accountId, limit ? Number(limit) : undefined, normalized);
  }

  /** KST 일별 성과 (종가 자산·전일 대비·실현손익). 최신순. */
  @Get("daily")
  getDaily(@CurrentUser() user: JwtUser, @Query("days") days?: string) {
    return this.equity.daily(user.accountId, days ? Number(days) : undefined);
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
