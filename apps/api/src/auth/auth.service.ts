import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { PrismaClient } from "@mock-kabu/db";
import { SIGNUP_BONUS } from "@mock-kabu/shared";
import * as bcrypt from "bcryptjs";
import { PRISMA } from "../core/tokens";

export interface JwtUser {
  userId: string;
  accountId: string;
  email: string;
  nickname: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    private jwt: JwtService,
  ) {}

  async signup(email: string, password: string, nickname: string) {
    if (!email?.includes("@") || !password || password.length < 4 || !nickname) {
      throw new BadRequestException("email/password(4자 이상)/nickname은 필수입니다");
    }
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException("이미 가입된 이메일입니다");

    const passwordHash = await bcrypt.hash(password, 10);
    const bonus = BigInt(SIGNUP_BONUS);

    const { user, account } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, passwordHash, nickname } });
      const account = await tx.account.create({
        data: { userId: user.id, balance: bonus },
      });
      await tx.ledgerEntry.create({
        data: {
          accountId: account.id,
          delta: bonus,
          balanceAfter: bonus,
          reason: "SIGNUP_BONUS",
        },
      });
      return { user, account };
    });

    return this.issueToken({
      userId: user.id,
      accountId: account.id,
      email: user.email,
      nickname: user.nickname,
    });
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다");

    const account = await this.prisma.account.findUnique({ where: { userId: user.id } });
    if (!account) throw new UnauthorizedException("계좌가 없습니다");

    return this.issueToken({
      userId: user.id,
      accountId: account.id,
      email: user.email,
      nickname: user.nickname,
    });
  }

  private issueToken(payload: JwtUser) {
    const token = this.jwt.sign({ sub: payload.userId, ...payload });
    return { token, user: payload };
  }
}
