import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AuthService, type JwtUser } from "./auth.service";
import { CurrentUser, JwtAuthGuard } from "./jwt-auth.guard";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post("signup")
  signup(@Body() body: { email: string; password: string; nickname: string }) {
    return this.auth.signup(body.email, body.password, body.nickname);
  }

  @Post("login")
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body.email, body.password);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtUser) {
    return user;
  }
}
