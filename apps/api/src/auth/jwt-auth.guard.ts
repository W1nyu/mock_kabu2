import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { JwtUser } from "./auth.service";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers["authorization"];
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("인증 토큰이 필요합니다");
    }
    try {
      const payload = this.jwt.verify(header.slice(7));
      req.user = {
        userId: payload.userId ?? payload.sub,
        accountId: payload.accountId,
        email: payload.email,
        nickname: payload.nickname,
      } satisfies JwtUser;
      return true;
    } catch {
      throw new UnauthorizedException("유효하지 않은 토큰입니다");
    }
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): JwtUser => {
    return context.switchToHttp().getRequest().user;
  },
);
