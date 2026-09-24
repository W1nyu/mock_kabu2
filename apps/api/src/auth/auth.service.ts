import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { PrismaClient } from "@mock-kabu/db";
import { ADMIN_NICKNAME, NICKNAME_RULE_MESSAGE, SIGNUP_BONUS, isValidNickname, normalizeNickname } from "@mock-kabu/shared";
import * as bcrypt from "bcryptjs";
import { PRISMA } from "../core/tokens";

export interface JwtUser {
  userId: string;
  accountId: string;
  nickname: string;
  isAdmin: boolean;
}

/** 로그인 식별자. 사용자는 닉네임, 봇·관리자 같은 시스템 계정은 내부 이메일로 들어온다. */
export interface LoginIdentifier {
  nickname?: string;
  email?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private prisma: PrismaClient,
    private jwt: JwtService,
  ) {}

  /** 닉네임+비밀번호만으로 가입한다. 이메일은 받지 않는다(시스템 계정만 내부 이메일을 가진다). */
  async signup(nickname: string, password: string) {
    const name = normalizeNickname(nickname);
    if (!isValidNickname(name)) throw new BadRequestException(NICKNAME_RULE_MESSAGE);
    if (name.toLowerCase() === ADMIN_NICKNAME) throw new ConflictException("사용할 수 없는 닉네임입니다");
    if (!password || password.length < 4) throw new BadRequestException("비밀번호는 4자 이상이어야 합니다");
    await this.assertNicknameFree(name);

    const passwordHash = await bcrypt.hash(password, 10);
    const bonus = BigInt(SIGNUP_BONUS);

    const { user, account } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { passwordHash, nickname: name } }).catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException("이미 사용 중인 닉네임입니다");
        throw error;
      });
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

    return this.issueToken({ userId: user.id, accountId: account.id, nickname: user.nickname, isAdmin: false });
  }

  async login(identifier: LoginIdentifier, password: string) {
    const nickname = normalizeNickname(identifier.nickname);
    const email = typeof identifier.email === "string" ? identifier.email.trim() : "";
    const user = nickname
      ? await this.prisma.user.findUnique({ where: { nickname } })
      : email
        ? await this.prisma.user.findUnique({ where: { email } })
        : null;
    if (!user) throw new UnauthorizedException("닉네임 또는 비밀번호가 올바르지 않습니다");
    const ok = await bcrypt.compare(password ?? "", user.passwordHash);
    if (!ok) throw new UnauthorizedException("닉네임 또는 비밀번호가 올바르지 않습니다");

    const account = await this.prisma.account.findUnique({ where: { userId: user.id } });
    if (!account) throw new UnauthorizedException("계좌가 없습니다");

    return this.issueToken({ userId: user.id, accountId: account.id, nickname: user.nickname, isAdmin: user.isAdmin });
  }

  /** 닉네임 변경 = 로그인 ID 변경. 새 토큰을 발급해 클라이언트가 세션의 닉네임을 갱신할 수 있게 한다. */
  async updateNickname(userId: string, nickname: string) {
    const name = normalizeNickname(nickname);
    if (!isValidNickname(name)) throw new BadRequestException(NICKNAME_RULE_MESSAGE);
    if (name.toLowerCase() === ADMIN_NICKNAME) throw new ConflictException("사용할 수 없는 닉네임입니다");
    const current = await this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (current?.isAdmin) throw new BadRequestException("관리자 닉네임은 변경할 수 없습니다");
    await this.assertNicknameFree(name, userId);
    const user = await this.prisma.user
      .update({ where: { id: userId }, data: { nickname: name } })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException("이미 사용 중인 닉네임입니다");
        throw error;
      });
    const account = await this.prisma.account.findUnique({ where: { userId: user.id } });
    if (!account) throw new UnauthorizedException("계좌가 없습니다");
    return this.issueToken({ userId: user.id, accountId: account.id, nickname: user.nickname, isAdmin: user.isAdmin });
  }

  /** 대소문자만 다른 닉네임도 막는다(유니크 인덱스는 정확히 같은 문자열만 잡는다). */
  private async assertNicknameFree(nickname: string, exceptUserId?: string) {
    const taken = await this.prisma.user.findFirst({
      where: { nickname: { equals: nickname, mode: "insensitive" }, ...(exceptUserId ? { NOT: { id: exceptUserId } } : {}) },
      select: { id: true },
    });
    if (taken) throw new ConflictException("이미 사용 중인 닉네임입니다");
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 4) throw new BadRequestException("새 비밀번호는 4자 이상이어야 합니다");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("사용자를 찾을 수 없습니다");
    const ok = await bcrypt.compare(currentPassword ?? "", user.passwordHash);
    if (!ok) throw new UnauthorizedException("현재 비밀번호가 올바르지 않습니다");
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { ok: true };
  }

  private issueToken(payload: JwtUser) {
    const token = this.jwt.sign({ sub: payload.userId, ...payload }, payload.isAdmin ? { expiresIn: "1h" } : undefined);
    return { token, user: payload };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
