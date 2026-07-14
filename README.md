# mock kabu — 가상 투자·체결 엔진 (로컬 모의 거래소)

가상 자산을 사고파는 모의 거래소입니다. 지정가/시장가 주문 → 인메모리 오더북 매칭 → 정산까지 전 구간이 로컬에서 동작하며, 알고리즘 봇 10개(마켓메이커·소액개미·고래·노이즈·모멘텀)가 다양한 시장 참여자 역할을 해 호가창이 항상 살아 움직입니다. 잔액/보유자산 경합 구간에는 **락 전략 3종(낙관적/비관적/Redis 분산)** 이 구현되어 있고 환경변수로 전환할 수 있습니다.

기획: [docs/superpowers/specs/2026-07-11-virtual-exchange-design.md](docs/superpowers/specs/2026-07-11-virtual-exchange-design.md) (M1~M4 구간)

## 아키텍처

```
apps/web (Next.js :3100) ──REST/WebSocket──> apps/api (NestJS :4100)
                                              ├─ auth/account/order/market/admin 모듈
                                              ├─ outbox relayer ──> Redis Streams(orders)
                                              └─ 정산 컨슈머 <── Redis Streams(trades)
apps/matching-engine ── orders 스트림 소비 → 심볼별 오더북 매칭 → trades 발행
                        └─ 호가/체결 Redis Pub/Sub → api gateway → 브라우저 push
apps/bots ── 봇 계정 10개로 api REST 호출 (추세·변동성 군집 기준가 + 마켓메이커/소액개미/고래/노이즈/모멘텀)
docker-compose: PostgreSQL 16 + Redis 7
```

- **주문 → 체결 → 정산 흐름**: 주문 접수 시 잔액/보유 홀드(락 적용) + orders/outbox 동일 트랜잭션 → relayer가 Redis Streams 발행 → 매칭 엔진(single-writer)이 가격-시간 우선 매칭 → trade 이벤트 → 정산 컨슈머가 잔액·보유 갱신(락 적용) + 홀드 해제 → WebSocket push
- **멱등성**: 모든 이벤트에 `event_id`, 정산은 `processed_events` 테이블로 중복 소비 무시 (at-least-once)
- **DB 안전망**: `CHECK(balance >= 0)` 등 제약 + append-only `ledger_entries` 원장

## 요구 사항

- Node.js 22+ / pnpm (`npm i -g pnpm`)
- **Docker Desktop** (PostgreSQL/Redis 실행용, 무료)

## 실행 방법

### 최초 1회 — 환경 설정 + 첫 실행

```bash
# 1. 의존성 설치
pnpm install

# 2. 환경변수 파일 생성 (기본값 그대로 사용 가능)
cp .env.example .env
cp packages/db/.env.example packages/db/.env

# 3. 인프라 (PostgreSQL + Redis)
pnpm infra:up

# 4. DB 마이그레이션 + 시드 (종목 5개, 봇 계정 10개) — 최초 1회만
pnpm db:migrate
pnpm db:seed

# 5. 전체 기동 (api + matching-engine + bots + web)
pnpm dev
```

→ http://localhost:3100 접속 → 회원가입(가상 현금 1,000만원 지급) → 종목 선택 → 매수/매도.

### 실제 과거 시세 리플레이

상단 메뉴의 **실전 리플레이**(`/replay`)에서는 기존 KABU·MOCK 등 로컬 거래소와 분리된
가상 계좌로 AAPL·MSFT·NVDA의 과거 일봉을 한 봉씩 공개하며 연습할 수 있습니다.

- **실제 시세**: 봇 없이 과거 OHLCV 경로 그대로 재생합니다.
- **봇 혼합**: seed 기반의 가상 유동성 압력이 실제 기준 경로의 ±1/±2.5/±5% 범위 안에서만
  추가됩니다. 기존 `apps/bots`, 오더북, 주문, 계좌·정산에는 영향을 주지 않습니다.
- **기간·재생 속도**: 1개월부터 5년·10년·상장 이후 전체(`max`)까지의 일봉과 x0.25 / x0.5 / x1 / x2,
  한 봉 진행, 새 시나리오를 지원합니다.
- 기본 상태에서는 외부 시세를 자동 요청하지 않습니다. 사용자가 권한을 가진 로컬 CSV 또는
  `ALPHA_VANTAGE_API_KEY`를 명시적으로 설정했을 때만 실제 과거 일봉을 사용하며, AAPL은 작은
  MIT 라이선스 Plotly fixture를 오프라인 학습용으로 사용할 수 있습니다. 5년·10년·`max`는
  해당 범위를 제공할 권한이 있는 데이터 소스가 필요합니다.

온라인 실제 데이터와 오프라인 fixture의 범위·제약, 캐시와 혼합 모드의 봇 분리는
[실전 리플레이 데이터 가이드](docs/replay-data-guide.md)를 참고하세요.

봇 계정: `bot1@bots.local` ~ `bot10@bots.local` / 비밀번호 `botpassword` (각 10억 + 종목별 5만 주)

### 2번째 실행부터

DB 데이터는 Docker 볼륨에 보존되므로 마이그레이션/시드 없이 두 명령이면 됩니다:

```bash
pnpm infra:up          # mock_kabu2 전용 PostgreSQL + Redis 기동
pnpm dev               # 전체 앱 기동
```

### 종료 방법

```bash
# 1. 앱 종료: pnpm dev 실행 중인 터미널에서 Ctrl+C

# 2. 인프라 종료 (데이터는 볼륨에 유지됨)
pnpm infra:stop
```

```bash
wsl --shutdown   # vmmemWSL 종료
```


DB/Redis 데이터까지 완전히 초기화하려면:

```bash
docker compose --project-name mock-kabu2 down -v   # mock_kabu2 컨테이너 + 볼륨만 삭제
```


이후 다시 실행할 때는 최초 실행처럼 `pnpm infra:up` → `pnpm db:migrate` → `pnpm db:seed`부터 진행합니다.

### 손상된 로컬 거래 데이터 복구

정산 프로세스가 비정상 종료된 뒤에는 먼저 비파괴 dry-run을 실행합니다. 이 도구는
`matching.trades`를 기준으로 미정산 체결과 주문·예약 상태를 함께 검증하며, 모순이 있으면
어떤 데이터도 변경하지 않습니다.

```bash
# api / matching-engine / bots를 먼저 중지한 뒤 실행
pnpm recover:settlement

# 출력이 SAFE일 때만 명시적으로 적용
pnpm run recover:settlement -- --apply --confirm=RECOVER_UNSETTLED_TRADES
pnpm check:consistency
```

체결 이력 자체가 주문 수량과 모순되는 경우 자동 복구는 안전하지 않으므로 차단됩니다. 이
로컬 개발 환경에서는 다음 초기화·시드 절차로 깨끗한 시장 상태를 다시 만들 수 있습니다.

```bash
docker compose --project-name mock-kabu2 down -v
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm check:consistency
```

## 락 전략 전환 (스펙 4.2)

`.env`의 `LOCK_STRATEGY`를 바꾸고 api를 재기동:

| 값 | 구현 |
|---|---|
| `optimistic` | `UPDATE ... WHERE version = ?` + 지수 백오프 재시도 (충돌 시 409) |
| `pessimistic` (기본) | `SELECT ... FOR UPDATE` 원시 SQL, 계좌 ID 오름차순 잠금, lock_timeout |
| `distributed` | Redis `SET NX PX` + Lua 해제 + **fencing token**으로 좀비 쓰기 방어 |

현재 전략·충돌/재시도 카운터는 http://localhost:3100/admin (동시성 실험 관전 모드)에서 실시간 확인.

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
  bots/             시장 참여자 봇 (추세·변동성 군집 기준가, 마켓메이커 x3 / 소액개미 x3 / 고래 x1 / 노이즈 x2 / 모멘텀 x1)
  web/              Next.js — 대시보드·호가창·캔들차트·주문·이체·관전 모드
packages/
  shared/           타입·이벤트 스키마·상수 (종목, 스트림/채널 키)
  db/               Prisma 스키마(5개 스키마 논리 분리)·마이그레이션·시드·정합성 검사
  concurrency/      BalanceMutator 인터페이스 + 락 전략 3종 구현
```

## 이번 구현 범위 밖 (스펙의 후속 마일스톤)

k3d/Helm 배포 리허설(M5), k6 벤치마크 + Grafana(M6), isolation-lab 격리 수준 재현 테스트, AWS 스팟 배포(M7+)
