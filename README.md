# mock kabu — 가상 투자·체결 엔진 (로컬 모의 거래소)

가상 자산을 사고파는 모의 거래소입니다. 지정가/시장가 주문 → 인메모리 오더북 매칭 → 정산까지 전 구간이 로컬에서 동작하며, 알고리즘 봇 10개(마켓메이커·소액개미·고래·노이즈·모멘텀)가 다양한 시장 참여자 역할을 해 호가창이 항상 살아 움직이고, 가상 뉴스가 그 수급을 확률적으로 움직입니다. 개미·모멘텀 봇은 매수 뒤 손절·트레일링 예약을 걸어 두므로 하락장에서는 스탑이 연쇄로 터지는 흐름도 재현됩니다. 잔액/보유자산 경합 구간에는 **락 전략 3종(낙관적/비관적/Redis 분산)** 이 구현되어 있고 환경변수로 전환할 수 있습니다.

기획: [docs/superpowers/specs/2026-07-11-virtual-exchange-design.md](docs/superpowers/specs/2026-07-11-virtual-exchange-design.md) (M1~M4 구간)

## 아키텍처

```
apps/web (Next.js :3100) ──REST/WebSocket──> apps/api (NestJS :4100)
                                              ├─ auth/account/order/market/admin 모듈
                                              ├─ outbox relayer ──> Redis Streams(orders)
apps/matching-engine ── orders 스트림 소비 → 심볼별 오더북 매칭 → trades 발행
apps/settlement ── trades 스트림 소비 → 잔고·보유·원장·캔들 정산 → account Pub/Sub
                        └─ 호가/체결/계정 Redis Pub/Sub → api gateway → 브라우저 push
apps/bots ── 봇 계정 10개로 api REST 호출 (추세·변동성 군집 기준가 + 마켓메이커/소액개미/고래/노이즈/모멘텀)
docker-compose: PostgreSQL 16 + Redis 7
```

- **전용 유동성 공급자**: 종목별 reserve 계정 5개가 양방향 각각 약 ₩120M의 연속 호가벽을 유지합니다. 최우선 호가에는 일반 주문을 흡수할 최소 수량을 집중하고, 기존 호가를 먼저 채운 뒤에만 교체해 호가 공백과 불필요한 슬리피지를 막습니다.
- **차트 타임프레임**: 1분·5분·15분·1시간·4시간·1일 봉을 지원합니다. 저장은 1분 봉만 하고 나머지는 조회 시 집계하므로 단일 진실 원천이 유지됩니다. KST가 UTC+9라 09:00 KST가 곧 UTC 자정이며, 따라서 **1일 봉은 09:00 KST에 열리고** 4시간/1시간 봉도 그 경계에 정확히 맞물립니다. 선택한 봉 간격은 브라우저에 저장됩니다.
- **가상 뉴스**: 종목별 호재/악재(수주·실적·리스크·수급·자본 등)와 시장 전체 매크로 뉴스(금리·환율·유가·원자재·운임·글로벌 경기)를 템플릿 160종에서 생성해 종목 뉴스는 4~8분, 시장 전체 뉴스는 30~60분마다 발행합니다. 각 뉴스는 강도(0.2~1.0)에 비례해 봇들의 매수/매도 선택 확률과 마켓메이커 기준가를 기울이므로, 강한 호재일수록 오를 **확률**이 높아질 뿐 반드시 오르지는 않습니다. 일부 뉴스는 후속 보도로 이어지며 결과가 뒤집히기도 합니다. 상단 메뉴 **뉴스**(`/news`)에서 볼 수 있고, 호재/악재 여부와 강도는 UI에 표시하지 않습니다.
- **운영 메모리 경계**: 주문·정산 Streams는 consumer group이 ACK한 구간만 주기적으로 trim하며, production Redis는 `noeviction`입니다. 메모리 한계에서는 금융 이벤트를 버리지 않고 outbox 재시도로 복구합니다.
- **조건부(예약) 주문 + OCO**: 주문폼의 **조건부** 탭에서 "현재가가 N원 이상/이하가 되면 시장가 매수/매도"를 예약합니다(손절·익절·돌파·눌림). 대기 중에는 현금·수량을 홀드하지 않고, 체결가가 조건을 만족하는 순간 API가 정확히 한 번만 발동시켜 일반 주문으로 접수합니다(접수 거부 시 사유 기록). 포지션 바의 **손절/익절 설정**은 두 다리를 OCO 한 쌍으로 등록해 한쪽이 발동하면 다른 쪽을 자동 취소합니다. **트레일링 스탑**은 등록 후 고점(매도)/저점(매수)을 따라 트리거가 움직이고, 매수 주문의 **체결 후 손절/익절 자동 등록**(브래킷)은 체결 평균가 기준 OCO를 체결 수량만큼 자동으로 걸어 줍니다. 지정가는 종목별 호가 단위에 맞아야 접수됩니다.
- **실현손익·매매 성과·랭킹**: 매도 체결마다 평단가 대비 실현손익을 정산과 같은 트랜잭션에 기록합니다. 대시보드에 오늘/누적 실현손익, 승률·손익비·평균 손익, 분 단위 자산 추이 차트, 사용자 계정 수익률 랭킹이 있고, 주문내역의 **체결** 탭에서 체결별 실현손익을 볼 수 있습니다. 체결·예약 발동은 어느 페이지에서든 토스트로 알립니다.

- **주문 → 체결 → 정산 흐름**: 주문 접수 시 잔액/보유 홀드(락 적용) + orders/outbox 동일 트랜잭션 → relayer가 Redis Streams 발행 → 매칭 엔진(single-writer)이 가격-시간 우선 매칭 → trade 이벤트 → 정산 컨슈머가 잔액·보유 갱신(락 적용) + 홀드 해제 → WebSocket push
- **멱등성**: 모든 이벤트에 `event_id`, 정산은 `processed_events` 테이블로 중복 소비 무시 (at-least-once)
- **DB 안전망**: `CHECK(balance >= 0)` 등 제약 + append-only `ledger_entries` 원장

전체 엔드포인트와 계정 채널 push 페이로드는 [REST API 레퍼런스](docs/api.md)에, 최근 변경은 [CHANGELOG.md](CHANGELOG.md)에 정리돼 있습니다.

## 저비용 VPS 배포

개발용 `docker-compose.yml`과 별도로, 한 대의 VPS에서 PostgreSQL·Redis·API·매칭 엔진·봇·웹을
운영할 수 있는 production Compose 구성을 제공합니다. 외부에는 Caddy의 HTTPS(80/443)만 열고,
DB/Redis/API는 내부 Docker 네트워크에만 둡니다. PostgreSQL은 pgBackRest 암호화 백업과 복구
스크립트를 포함합니다.

실제 배포 전 준비, 비밀값 생성, 백업·복구 절차는 [저비용 VPS 운영 배포 가이드](docs/production-vps-deployment.md)를 따르세요.

**Oracle Cloud Always Free**(A1 VM 4 OCPU/24GB + Object Storage + Autonomous Database)에 0원으로 올리는 절차는 [deploy/oci/README.md](deploy/oci/README.md)에 있습니다 — Terraform 한 번으로 VM을 만들고, `bootstrap.sh`가 빌드·기동·백업/정리 타이머까지 등록합니다. 무료 Oracle DB는 주 DB 대신 아카이브·분석 저장소로 붙습니다(`pnpm oracle:sync`, 드라이버 없이 ORDS REST SQL).

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

# 4. DB 마이그레이션 + 시드 (종목 7개, 기본 봇 계정 10개) — 최초 1회만
pnpm db:migrate
pnpm db:seed

# 5. 전체 기동 (api + settlement + matching-engine + bots + web)
pnpm dev
```

→ http://localhost:3100 접속 → 회원가입(가상 현금 1,000만원 지급) → 종목 선택 → 매수/매도.

### 실제 과거 시세 리플레이

상단 메뉴의 **실전 리플레이**(`/replay`)에서는 기존 KABU·MOCK 등 로컬 거래소와 분리된
가상 계좌로 해외 주식 10종, KOSPI 주식 5종, Bitcoin의 **고정 일봉 연습 데이터**를 한 봉씩
공개하며 연습할 수 있습니다. 종목 선택은 국내 주식·해외 주식·코인으로 나뉩니다.

- **기준 경로**: 봇 없이 종목별 고정 OHLCV 경로 그대로 재생합니다.
- **봇 혼합**: seed 기반의 가상 유동성 압력이 고정 기준 경로의 ±1/±2.5/±5% 범위 안에서만
  추가됩니다. 기존 `apps/bots`, 오더북, 주문, 계좌·정산에는 영향을 주지 않습니다.
- **사전 차트·기간·재생 속도**: 어떤 기간이든 먼저 200봉을 공개합니다. 그 뒤 1개월=30봉,
  3개월=90봉, 6개월=180봉, 1년=365봉, 2년=730봉, 3년=1,095봉만 실제로 재생합니다.
  따라서 1개월 응답은 230봉, 최대 3년 응답은 1,295봉이며, 최대 재생 기간은 3년입니다.
  x0.25 / x0.5 / x1 / x2, 한 봉 진행, 새 시나리오를 지원합니다.
- 데이터 선택 창이나 외부 데이터 소스 전환은 없습니다. API 키나 네트워크 상태와 무관하게
  같은 종목·기간은 항상 같은 데이터를 반환합니다.

고정 데이터의 범위·제약, 확장 종목 목록, Alpha Vantage 키 발급 가이드와 혼합 모드의 봇 분리는
[실전 리플레이 데이터 가이드](docs/replay-data-guide.md)를 참고하세요.

봇 계정: 닉네임 `봇#1` ~ `봇#10` / 비밀번호 `botpassword` (각 10억 + 종목별 5만 주). API로는 내부 이메일 `bot1@bots.local`로도 로그인된다.

일반 회원가입은 **이메일 없이 닉네임(2~20자)과 비밀번호만** 받는다. 닉네임이 로그인 ID다.

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
# api / settlement / matching-engine / bots를 먼저 중지한 뒤 실행
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
pnpm check:consistency    # 원장 합계=잔액, 음수 잔액/보유 0건, 홀드 불변식, 실현손익·조건부 주문 검사
pnpm smoke                # 기동 중인 스택에 임시 계정으로 주문→체결→실현손익→조건부/OCO/트레일링/브래킷 E2E
```

## 프로젝트 구조

```
apps/
  api/              NestJS 경계 API (auth·account·order·market·admin·gateway)
  matching-engine/  순수 TS 프로세스 — 오더북(순수 함수) + Redis Streams 컨슈머
  settlement/       순수 TS 워커 — 체결 정산·원장·보유·캔들 + 계정 이벤트 발행
  bots/             시장 참여자 봇 (추세·변동성 군집 기준가, 마켓메이커 x3 / 소액개미 x3 / 고래 x1 / 노이즈 x2 / 모멘텀 x1)
  web/              Next.js — 대시보드(자산 추이·성과·랭킹)·호가창·캔들차트·주문(조건부/OCO)·체결 내역·이체·관전 모드
packages/
  shared/           타입·이벤트 스키마·상수 (종목, 스트림/채널 키)
  db/               Prisma 스키마(5개 스키마 논리 분리)·마이그레이션·시드·정합성 검사
  concurrency/      BalanceMutator 인터페이스 + 락 전략 3종 구현
```

## 이번 구현 범위 밖 (스펙의 후속 마일스톤)

k3d/Helm 배포 리허설(M5), k6 벤치마크 + Grafana(M6), isolation-lab 격리 수준 재현 테스트, AWS 스팟 배포(M7+)
