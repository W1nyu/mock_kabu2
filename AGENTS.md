# AGENTS.md — AI 에이전트 작업 가이드

이 저장소에서 작업하는 모든 AI 에이전트(Claude Code, Codex, Gemini CLI 등)를 위한 안내.

**먼저 읽을 것:** [HANDOFF.md](HANDOFF.md) — 최근 작업 상태·의도·다음 후보 작업. 프로젝트 개요·실행법은 [README.md](README.md).

## 프로젝트 구조

pnpm + turbo 모노레포. 로컬 모의 거래소:

- `apps/web` — Next.js 15 (:3100), Tailwind, lightweight-charts
- `apps/api` — NestJS (:4100), REST + socket.io 게이트웨이, 정산 컨슈머
- `apps/matching-engine` — Redis Streams 소비 → 오더북 매칭 (single-writer)
- `apps/bots` — 봇 10계정 상시 거래 (마켓메이커/노이즈/모멘텀)
- `packages/shared` — 타입·이벤트 스키마·채널 상수 / `packages/db` — Prisma / `packages/concurrency` — 락 전략 3종

## 명령어

```bash
pnpm infra:up             # mock_kabu2 전용 PostgreSQL + Redis (선행 필수)
pnpm dev                  # 전체 기동 (turbo)
pnpm test                 # 단위 테스트 (vitest)
pnpm check:consistency    # DB 정합성 검사
cd apps/web && npx tsc --noEmit   # 웹 타입체크
```

검증(런타임 관찰) 레시피: `.claude/skills/verify/SKILL.md`. 봇 계정 `bot1@bots.local` / `botpassword`, 종목 KABU·MOCK·NEKO·SAKU·TANU.

## 반드시 지킬 규칙

- **실시간 구독은 `apps/web/src/lib/socket.ts`의 `subscribe()`만 사용할 것.** socket.io는 단일 소켓·단일 `"message"` 이벤트로 모든 채널이 들어오므로, 직접 `socket.on("message")`을 달면 다른 채널 페이로드가 섞여 들어온다 (과거 NaN 차트 버그의 원인). `subscribe()`에 채널 필터와 refcount가 내장돼 있다.
- 웹은 HMR 즉시 반영, api/matching-engine/bots 수정은 `pnpm dev` 재시작 필요.
- UI 색 관례: 상승/매수=빨강, 하락/매도=파랑 (한국식). 숫자는 `tabular-nums`.
- 커밋 메시지: 한국어, `feat:`/`fix:`/`docs:` prefix.
- `error.md`는 사용자가 브라우저 에러를 붙여넣는 스크래치 파일 — 커밋·삭제하지 말 것 (.gitignore 처리됨).
- Windows 환경. git의 LF→CRLF 경고는 무해.
- 이벤트 멱등성 유지: 모든 이벤트에 `event_id`, 정산은 `processed_events`로 중복 무시. 이 불변식을 깨는 변경 금지.
