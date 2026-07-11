# mock kabu — 가상 투자·체결 엔진 (로컬 모의 거래소)

가상 자산을 사고파는 모의 거래소입니다. 지정가/시장가 주문 → 인메모리 오더북 매칭 → 정산까지 전 구간이 로컬에서 동작하며, 알고리즘 봇 10개(마켓메이커·노이즈·모멘텀)가 시장 참여자 역할을 해 호가창이 항상 살아 움직입니다. 잔액/보유자산 경합 구간에는 **락 전략 3종(낙관적/비관적/Redis 분산)** 이 구현되어 있고 환경변수로 전환할 수 있습니다.

기획: [docs/superpowers/specs/2026-07-11-virtual-exchange-design.md](docs/superpowers/specs/2026-07-11-virtual-exchange-design.md) (M1~M4 구간)

## 아키텍처

```
apps/web (Next.js :3000) ──REST/WebSocket──> apps/api (NestJS :4000)
                                              ├─ auth/account/order/market/admin 모듈
                                              ├─ outbox relayer ──> Redis Streams(orders)
                                              └─ 정산 컨슈머 <── Redis Streams(trades)
apps/matching-engine ── orders 스트림 소비 → 심볼별 오더북 매칭 → trades 발행
                        └─ 호가/체결 Redis Pub/Sub → api gateway → 브라우저 push
apps/bots ── 봇 계정 10개로 api REST 호출 (GBM 기준가 + 마켓메이커/노이즈/모멘텀)
docker-compose: PostgreSQL 16 + Redis 7
```

- **주문 → 체결 → 정산 흐름**: 주문 접수 시 잔액/보유 홀드(락 적용) + orders/outbox 동일 트랜잭션 → relayer가 Redis Streams 발행 → 매칭 엔진(single-writer)이 가격-시간 우선 매칭 → trade 이벤트 → 정산 컨슈머가 잔액·보유 갱신(락 적용) + 홀드 해제 → WebSocket push
- **멱등성**: 모든 이벤트에 `event_id`, 정산은 `processed_events` 테이블로 중복 소비 무시 (at-least-once)
- **DB 안전망**: `CHECK(balance >= 0)` 등 제약 + append-only `ledger_entries` 원장

## 요구 사항

- Node.js 22+ / pnpm (`npm i -g pnpm`)
- **Docker Desktop** (PostgreSQL/Redis 실행용, 무료)

## 실행 방법

```bash
pnpm install

# 1. 인프라 (PostgreSQL + Redis)
docker compose up -d

# 2. DB 마이그레이션 + 시드 (종목 5개, 봇 계정 10개)
pnpm db:migrate
pnpm db:seed

# 3. 전체 기동 (api + matching-engine + bots + web)
pnpm dev
```

→ http://localhost:3000 접속 → 회원가입(가상 현금 1,000만원 지급) → 종목 선택 → 매수/매도.

봇 계정: `bot1@bots.local` ~ `bot10@bots.local` / 비밀번호 `botpassword` (각 10억 + 종목별 5만 주)

## 락 전략 전환 (스펙 4.2)

`.env`의 `LOCK_STRATEGY`를 바꾸고 api를 재기동:

| 값 | 구현 |
|---|---|
| `optimistic` | `UPDATE ... WHERE version = ?` + 지수 백오프 재시도 (충돌 시 409) |
| `pessimistic` (기본) | `SELECT ... FOR UPDATE` 원시 SQL, 계좌 ID 오름차순 잠금, lock_timeout |
| `distributed` | Redis `SET NX PX` + Lua 해제 + **fencing token**으로 좀비 쓰기 방어 |

현재 전략·충돌/재시도 카운터는 http://localhost:3000/admin (동시성 실험 관전 모드)에서 실시간 확인.

## 검증

```bash
pnpm test                 # 오더북 매칭 + 락 전략 단위 테스트
pnpm check:consistency    # 원장 합계=잔액, 음수 잔액/보유 0건, 홀드 불변식 검사
```

## 프로젝트 구조

```
apps/
  api/              NestJS 모듈러 모놀리스 (auth·account·order·market·admin·gateway·정산)
  matching-engine/  순수 TS 프로세스 — 오더북(순수 함수) + Redis Streams 컨슈머
  bots/             시장 참여자 봇 (GBM 기준가, 마켓메이커 x5 / 노이즈 x4 / 모멘텀 x1)
  web/              Next.js — 대시보드·호가창·캔들차트·주문·이체·관전 모드
packages/
  shared/           타입·이벤트 스키마·상수 (종목, 스트림/채널 키)
  db/               Prisma 스키마(5개 스키마 논리 분리)·마이그레이션·시드·정합성 검사
  concurrency/      BalanceMutator 인터페이스 + 락 전략 3종 구현
```

## 이번 구현 범위 밖 (스펙의 후속 마일스톤)

k3d/Helm 배포 리허설(M5), k6 벤치마크 + Grafana(M6), isolation-lab 격리 수준 재현 테스트, AWS 스팟 배포(M7+)
