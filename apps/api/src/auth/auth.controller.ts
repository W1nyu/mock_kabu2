import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { AuthService, type JwtUser } from "./auth.service";
import { LoginRateLimitGuard, SignupRateLimitGuard } from "./login-rate-limit.guard";
import { CurrentUser, JwtAuthGuard } from "./jwt-auth.guard";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post("signup")
  @UseGuards(SignupRateLimitGuard)
  signup(@Body() body: { email: string; password: string; nickname: string }) {
    return this.auth.signup(body.email, body.password, body.nickname);
  }

  @Post("login")
  @UseGuards(LoginRateLimitGuard)
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body.email, body.password);
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
  @UseGuards(JwtAuthGuard)
  changePassword(@CurrentUser() user: JwtUser, @Body() body: { currentPassword: string; newPassword: string }) {
    return this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
  }
}
