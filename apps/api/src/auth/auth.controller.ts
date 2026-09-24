import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { AuthService, type JwtUser } from "./auth.service";
import { LoginRateLimitGuard, SignupRateLimitGuard, TransferRateLimitGuard } from "./login-rate-limit.guard";
import { CurrentUser, JwtAuthGuard } from "./jwt-auth.guard";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post("signup")
  @UseGuards(SignupRateLimitGuard)
  signup(@Body() body: { nickname: string; password: string }) {
    return this.auth.signup(body.nickname, body.password);
  }

  @Post("login")
  @UseGuards(LoginRateLimitGuard)
  /** 사용자는 `{nickname, password}`. `{email, password}`는 봇·관리자 같은 시스템 계정용으로 남겨 둔다. */
  login(@Body() body: { nickname?: string; email?: string; password: string }) {
    return this.auth.login({ nickname: body.nickname, email: body.email }, body.password);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtUser) {
    return user;
  }

  /** 닉네임 변경. 응답의 새 token/user로 세션을 갱신할 것. */
  @Patch("me")
  @UseGuards(JwtAuthGuard)
  updateMe(@CurrentUser() user: JwtUser, @Body() body: { nickname: string }) {
    return this.auth.updateNickname(user.userId, body.nickname);
  }

  @Post("password")
  @UseGuards(JwtAuthGuard, TransferRateLimitGuard)
  changePassword(@CurrentUser() user: JwtUser, @Body() body: { currentPassword: string; newPassword: string }) {
    return this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
  }
}
