import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { LoginRateLimitGuard, SignupRateLimitGuard, PasswordRecheckRateLimitGuard } from "./login-rate-limit.guard";
import { jwtSecret } from "../env";

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: jwtSecret(),
      signOptions: { expiresIn: "7d" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, LoginRateLimitGuard, SignupRateLimitGuard, PasswordRecheckRateLimitGuard],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
