# HANDOFF — mock_kabu 작업 인수인계 (2026-09-22)

다른 AI 모델/세션이 이 프로젝트 작업을 이어받기 위한 문서. 프로젝트 개요·실행법은 [README.md](README.md), 원 기획은 `docs/superpowers/specs/2026-07-11-virtual-exchange-design.md` 참고.

## 프로젝트 한 줄 요약

로컬 모의 거래소 모노레포(pnpm + turbo): `apps/web`(Next.js 15 :3000) ↔ `apps/api`(NestJS :4000, REST + socket.io) ↔ `apps/matching-engine`(Redis Streams 매칭) + `apps/bots`(기존 흐름 봇과 전용 유동성 봇). 인프라는 docker-compose(PostgreSQL 16 + Redis 7).

## 현재 상태 (작업 로그)

- `9659626` — M1~M4 전체 구현 (main)
- `be579e5` — 웹 실시간 채널 필터링 버그 수정 + 호가창 높이 고정 (아래 "실시간 버그 수정" 참고)
- `a3a63e4` — README 실행 가이드 재구성 + HANDOFF/AGENTS 문서
- `d911a6a` — **보유종목 평단가·수익률 + 봇 역할 다양화** (아래 참고). 브라우저·DB·정합성 검사로 검증 완료.
- `4ea014d` — **차트 지표: 50/200 SMA·100 VWMA·거래량 + 토글** (아래 참고)
- (최신) — **거래 페이지 내 포지션 바 + 청산 UI** (아래 참고)
- `error.md` — 사용자가 브라우저 에러를 붙여넣는 스크래치 파일 (gitignore됨)

### 2026-07-12 후속 작업 — 시세 연속성·정산 복구·로컬 데이터 재시드

- **재기동 시세 연속성**: 체결 생성과 `market.symbols.last_price` 갱신을 같은 DB 트랜잭션으로 묶었다. 매칭 엔진 부팅은 `matching.trades`의 최신 체결가를 우선해 호가창/캐시를 복원하고, 봇 기준가는 `최신 체결 → last_price → 시초가` 순으로 이어받는다. 따라서 종료 전 1,300원이던 종목이 재시작 직후 시초가 1,000원으로 돌아가지 않는다.
- **정산 재시작 방어**: settlement consumer가 stale pending 메시지를 `XAUTOCLAIM`으로 회수하고, 실패한 금융 이벤트를 ACK로 버리지 않고 재시도한다. 캔들은 원장 체결로 다시 계산해 중복 소비에도 거래량이 누적되지 않는다.
- **복구 도구**: `pnpm recover:settlement`은 기본 dry-run이며, 안전할 때만 `pnpm run recover:settlement -- --apply --confirm=RECOVER_UNSETTLED_TRADES`로 적용한다. 전체 주문·체결 이력에서 예약금/예약수량을 재계산하고, 모순이 있으면 쓰기 없이 중단한다. `pnpm check:consistency`은 미정산 체결·예약 불일치·last_price 불일치까지 검사한다.
- **현재 로컬 DB**: 기존 DB는 주문 수량 초과 체결/terminal `filledQty` 불일치가 있어 비파괴 복구가 안전하게 차단됐다. 사용자 승인에 따라 PostgreSQL·Redis 볼륨을 초기화하고 마이그레이션·봇 시드를 다시 적용했다. 이후 봇 체결이 발생한 상태에서 `check:consistency`와 복구 dry-run 모두 통과했다.
- 검증: Vitest 30개, 봇 가격 복원 node:test 2개, 복구 플래너 node:test 6개, 전 패키지 TypeScript 검사 통과. API와 매칭 엔진의 기동/REST 접속도 확인했다.

### 2026-07-13 후속 작업 — 차트 OHLC hover·호가 유동성 강화

- **캔들 hover 정보**: `apps/web/src/components/CandleChart.tsx`가 lightweight-charts crosshair의 `seriesData`에서 실제 렌더된 봉을 읽는다. 마우스를 봉 위에 두면 차트 좌상단에 시·고·저·종 가격과 각각의 시가 대비 변동률(상승=빨강, 하락=파랑)을 표시한다. 진행 중인 마지막 봉도 실시간 체결에 맞춰 readout이 갱신되고, 차트를 벗어나면 숨긴다.
- **마켓메이커 유동성**: 새 `apps/bots/src/market-maker.ts`/`liquidity.ts`가 기존 3레벨·5~25주·전량취소 방식 대신 편당 12레벨, 최우선 160주, 총 935주의 촘촘한 호가 래더를 유지한다. REST 호가창의 상위 10단 바깥에 4단의 완충을 두고 250ms 전체 래더 재조정으로 체결 직후에도 가시 호가가 8단 아래로 내려가지 않게 한다. 새 호가를 먼저 넣되 active/retiring 주문 전체와의 반대편 교차를 엄격히 막고, 취소 요청 후에도 terminal 상태가 확인될 때까지 방어한다. 중심가는 한 번에 1틱만 이동한다.
- **봇 충격 완화**: 고래 봇은 40~120주로 제한하고 시장가 비중을 25%로 낮췄다. 따라서 작은 시장가 주문과 고래 주문이 한 번에 호가창을 소진할 가능성이 크게 줄었다.
- **호가 재조정 조회**: 봇은 이제 `/orders?symbol={SYMBOL}&status=live`로 자기 계정의 해당 종목 OPEN/PARTIAL만 읽는다. 전체 주문 이력의 200건 한도 때문에 오래된 활성 호가를 영구히 살아 있다고 판단하던 문제를 막는다. 기존 `/orders` 응답은 호환된다.
- **매칭 재기동 멱등성**: migration `20260713090000_add_matching_processed_order_events`가 `matching.processed_order_events(event_id PK)`를 추가했다. `order.placed`는 이 event id claim·체결 원장·last_price를 한 트랜잭션으로 확정해 outbox 재발행이나 Streams PEL 회수 뒤에도 두 번 매칭되지 않는다. pending은 `XAUTOCLAIM`으로 회수하며, 취소 이벤트는 close 발행 실패 시 안전하게 재시도한다. `pnpm db:migrate`는 현재 로컬 DB에 적용됨.
- **정산 순서 방어**: `order.closed`가 선행 trade 정산보다 앞서면 hold를 풀지 않고 pending으로 남긴다. `XAUTOCLAIM` 재시도 시 앞선 체결 정산이 끝난 뒤에만 종료 처리를 한다.
- **전용 유동성 계정 + 재기동 복구**: `bot16`~`bot20`만 종목별 전용 reserve 계정(MOCK/KABU/TANU/SAKU/NEKO)으로 사용한다. 과거 시험 세대인 `bot11`~`bot15`와 기존 `bot1`~`bot10`의 주문·체결 이력은 동결하며 자동 보정·재사용하지 않는다. API의 내부 reserve bootstrap은 계정·현금·재고를 멱등적으로 보충하고, matching bootstrap은 `isBot` + 정확한 reserve 이메일 + 계정 ID + 배정 종목까지 확인한 16~20 주문을 먼저 메모리 호가창에 복원한다. 그 뒤 레거시/사용자 주문은 이 기준 호가를 교차하지 않을 때만 복원한다. 이 우선순위/격리는 **DB 주문·체결·잔고를 전혀 수정하지 않는** 부팅 시 메모리 안전 경계다. 전용 reserve에 예전의 PARTIAL 또는 중복 잔존 주문이 있으면 봇은 정상 24개 래더를 먼저 채택하고, 비교차 잔존 행은 ID 기반 self-trade guard로만 보존한다. 따라서 불일치 주문을 자동 보정·강제취소하지 않고도 새 12단 호가를 유지한다. snapshot에는 없지만 DB가 `OPEN/PARTIAL`인 과거 주문도 취소 시 `matching.trades` 합계와 DB `filledQty`가 정확히 일치할 때만 정상 `order.closed`로 종결하며, 불일치는 경고만 내고 자동 보정하지 않는다.
- **체결 목록 정렬**: `TradesFeed`는 `가격 / 수량 / 일시` 헤더와 고정 CSS grid 열(`7rem / 3.5rem / minmax(0,1fr)`)을 사용한다. 수량을 가격 바로 옆에 두고 시간만 우측에 붙이며, 시간은 항상 `HH:mm:ss`로 0-padding한다.
- **실전 리플레이**: 새 메뉴 `/replay`는 기존 거래소와 완전히 분리된 가상 USD 계좌로 과거 일봉을 한 봉씩 공개한다. `GET /replay/datasets`와 `GET /replay/datasets/:id/candles`는 AAPL·MSFT·NVDA를 제공하며 기본 상태에서는 외부 시세를 요청하지 않는다. 명시적 `REPLAY_HISTORICAL_CSV_DIR`의 사용자 권한 CSV가 우선이고, 없을 때만 `ALPHA_VANTAGE_API_KEY`를 사용한다. 두 소스가 없거나 AAPL의 승인된 외부 요청이 실패하면 MIT Plotly fixture를 쓴다. `5y`·`10y`·`max`는 CSV 또는 Alpha Vantage full 일봉 권한이 필요하다. 자세한 사용·권리·검증 규칙은 `docs/replay-data-guide.md`를 참고한다.
- **혼합 리플레이**: `packages/shared/src/replay.ts`의 `HistoricalReplayEngine`/`HybridReplayEngine`이 x0.25/x0.5/x1/x2와 미래 OHLC 미노출을 담당한다. 혼합 모드는 seed 기반 가상 MM/모멘텀 압력을 실제 기준 경로의 ±1/±2.5/±5% 안으로 엄격히 제한하며, 기존 `apps/bots`, 매칭, 주문, 계좌·정산은 전혀 건드리지 않는다.
- **로컬 DB 재시드 완료**: 위의 과거 불일치 DB는 `tmp/mock-kabu-pre-reseed-20260713-2004.dump`로 PostgreSQL custom-format 백업을 보존한 뒤, 사용자 승인으로 PostgreSQL·Redis 볼륨을 초기화하고 전체 migration/seed를 다시 적용했다. 현재 새 로컬 DB에서는 `pnpm check:consistency`와 `pnpm recover:settlement` dry-run이 모두 통과한다. 과거 덤프를 자동 복구·수정하지 말고, 필요하면 별도 포렌식 DB에 복원해 검토할 것.
- **반영/검증**: 현재 웹/API는 :3000/:4000에서 기동 중이며 matching-engine과 bots도 최신 코드로 재시작했다. reserve 우선 bootstrap 회귀 테스트(오래된 TANU 8,580 매도가 완전한 `bot18` 사다리를 밀어내지 못함)를 포함한 matching recovery 9개 및 matching-engine 전체 24개 테스트와 matching TypeScript 검사를 통과했다. bots TypeScript 및 9개 테스트(12단 래더, PARTIAL guard, 정상 24단+잔존행 채택)를 통과했다. 재기동 뒤 2026-07-13에 5초 간격 5회로 MOCK/KABU/TANU/SAKU/NEKO를 확인해, 모든 샘플에서 양방향 각각 10단, 편당 최소 766주, `bestBid < bestAsk`를 유지했다. 루트 `pnpm test`는 실행 중인 서버가 Windows Prisma query-engine DLL을 잠가 `prisma generate` 단계에서만 EPERM으로 중단될 수 있으므로, 서버를 내린 뒤 재실행한다.

### 2026-07-13 후속 작업 — 전 호가 단계 변화·durable outbox·깨끗한 로컬 검증

- **모든 호가 단계의 변화**: `apps/bots/src/main.ts`의 depth-shaper가 자신의 지정가를 현재 보이는 양쪽 10단 중 임의 위치에 추가하고, 이미 낸 주문도 임의 순서로 취소한다. `chooseBookLevelIndex()`는 최우선 호가도 16% 확률로 포함하되 나머지 84%는 2~10단에서 고르므로, 수량 증감이 최고 매수가/최저 매도가에만 고정되지 않는다. 봇 단위 테스트가 이 분포를 고정 검증한다.
- **체결·호가 수량의 현실성**: 시장가 물량은 가격에 반비례해 주식 수를 조정하고, 대다수는 최우선 벽보다 작게 체결되며 일부만 가까운 최대 3단을 관통한다. 유동성 래더도 가격 정규화한 거래대금 목표를 사용하므로 저가 종목은 더 많은 주식 수로, 고가 종목은 적은 주식 수로 비슷한 호가대 거래대금을 유지한다. `VolumeActivity`의 무작위 quiet/busy pulse가 수량과 빈도를 바꾸되 매수·매도 방향 자체를 강제하지 않는다.
- **매칭-정산 전달 보장**: migration `20260713100000_add_matching_settlement_outbox`의 `matching.outbox_events`에 `trade.executed`/`order.closed` 이벤트를 체결 원장·last_price·event claim과 같은 DB 트랜잭션으로 저장한다. relay는 Redis `XADD` 성공 뒤에만 `published_at`을 표시하므로, Redis 실패 또는 재시작 사이에도 같은 event ID로 재발행되어 정산 멱등성이 유지된다. 취소 이벤트 ID도 재시도마다 고정했다.
- **자기 체결 방지**: 매칭 엔진은 동일 accountId의 교차 주문을 발견하면 들어온 주문의 잔여분만 취소하고 기존 maker 호가는 유지한다. 새 DB 런타임 관찰에서 자기 체결은 0건이었다.
- **최종 런타임 검증 (2026-07-13)**: 5개 종목 모두 양방향 10단·`bestBid < bestAsk`를 확인했다. 42초 전후 비교에서 각 종목의 양쪽 비최우선 호가가 8~18개 가격 단위로 변했다. Redis Streams의 matching/settlement 그룹은 재관찰 시 `pending=0`, `lag=0`; outbox 대기는 0; `pnpm check:consistency` 전체 통과; `pnpm recover:settlement` dry-run은 미정산 0건 SAFE였다. matching-engine 26개, bots 22개, API 26개 테스트와 shared·matching·bots·API build, 웹 TypeScript 검사를 통과했다.

## 2026-09-22 — 사용자 피드백 6건 (최신 작업)

- 호가창 클릭 → 가격만(방향 유지). `priceHint`에서 `side` 제거, `OrderForm`은 `setSide`를 더 이상 호출하지 않는다. `MyOpenOrders`도 `priceHint`를 받아 정정 행의 가격 칸을 채운다.
- `CandleChart`의 `OVERLAYS`(내 체결 마커·평단/예약선) 토글 — `INDICATORS`와 같은 저장 키(`mock-kabu2:chart:indicators`)에 합쳐 저장. 평단선 제목은 `평단`.
- `/market-index` 페이지(`/index`는 Next 프리렌더 버그로 빌드 실패) + `MarketIndexPanel`: 서버 `/market/index`(캐시 15~120초) 추이 + `trades:*` 구독으로 현재값 실시간 재계산(같은 정의: 현재가/시초가 평균 × 1,000). 종목별 기여 = (현재가/시초가 − 1) × 1,000 / 종목 수.
- 뉴스 간격 2배(`apps/bots/src/news/scheduler.ts` DEFAULT_*_GAP). 엔진 테스트는 2시간 시뮬레이션으로 바꿈.
- **Caddy 경로 충돌**: `/orders`·`/admin`·`/replay`가 웹 페이지와 API 접두사를 공유한다. `@api` 매처에 `not header Sec-Fetch-Dest document`/`not header RSC 1`/`not header Accept text/html*`를 넣어 페이지 로드·RSC 내비게이션은 웹으로. 로컬 dev는 포트가 달라 재현되지 않으니 프로덕션 Caddyfile을 바꿀 때 이 규칙을 지울 것.

## 2026-09-22 — 실제 배포: https://jobradar.my (OCI ap-osaka-1)

- **어디에**: OCI 콘솔에서 수동 생성한 `VM.Standard.E3.Flex` 2 OCPU / 4GB, x86_64, Ubuntu 24.04.5, 공인 IP `129.225.135.95`(임시 IP — 인스턴스를 지우면 바뀐다). **E3.Flex는 Always Free가 아니라 Free Trial 크레딧 자원**이라 체험 종료 시 회수된다. 상시 무료로 가려면 `deploy/oci/terraform`의 A1.Flex 경로로 다시 만들고 아래 절차를 반복한다.
- **어떻게**: 보안 목록에 80/443 ingress 추가, VM iptables 80/443 개방(`netfilter-persistent save`), Docker 29 + compose v5, 4GB 스왑, `git -c core.autocrlf=false archive`로 스냅샷을 `/opt/mock-kabu2`에 풀고 `deploy/oci/scripts/bootstrap.sh`. `.env.production`은 스크립트가 생성(APP_DOMAIN=jobradar.my, APP_ORIGIN=https://jobradar.my, CADDYFILE=../production/Caddyfile, BOT_QUOTE_RECONCILE_MS=500, BOT_FLOW_DELAY_SCALE=1.5). SSH 키는 로컬 `~/.ssh/mock-kabu-private.key`.
- **DNS**: Cloudflare(NS)에서 루트 `jobradar.my`의 기존 **Cloudflare Tunnel 레코드(대상 `349271e0-5ea5-44d6-908f-9912c1ff1518.cfargotunnel.com`)를 삭제하고 A `129.225.135.95` (DNS 전용, 프록시 끔)** 으로 교체했다. 되돌리려면 같은 이름에 CNAME으로 그 대상을 다시 넣으면 된다. `www.jobradar.my`(A 20.194.25.57, 프록시)는 그대로. Caddy가 Let's Encrypt 인증서를 tls-alpn-01로 받았다(프록시를 켜면 Cloudflare가 TLS를 종단해 Caddy ACME가 깨지므로 DNS 전용 유지).
- **고친 것**: 웹 컨테이너가 `Could not find a production build in the '.next' directory`로 재시작 루프 — 엔트리포인트가 `/app`에서 `next start`를 실행해 `/app/.next`를 찾던 문제. `next start apps/web -p 3100`으로 수정(`2c3003e`). 이 때문에 bootstrap이 타이머 등록 전에 멈춰 타이머는 수동으로 등록했다(backup 매일 03:30 KST, prune 일요일 04:10 KST; oracle-sync는 `ORACLE_ORDS_URL` 넣고 `bootstrap.sh --update`).
- **상태**: 8개 컨테이너 모두 Up(api·web·postgres·redis healthy), 메모리 사용 약 1.3GB/3.9GB, `https://jobradar.my/health/trading` 전부 up, `/market/symbols` 정상. 스냅샷 시점은 `4534694`(닉네임 로그인·랭킹 admin 제외, `API_URL=https://jobradar.my node scripts/smoke.mjs` 20개 통과)이며 이후 커밋은 `bootstrap.sh --update`(git pull 기반)가 아니라 archive+scp로 올린 뒤 VM에서 `compose build → run --rm migrate → up -d --remove-orphans`를 손으로 돌린다 — VM에 git remote가 없다. origin에 push한 뒤 `/opt/mock-kabu2`를 clone으로 바꾸면 `--update`가 그대로 쓰인다.

## 2026-09-22 — Oracle Cloud Always Free 배포 환경 + Autonomous Database 아카이브

- **왜 이렇게**: Free tier의 관리형 DB는 Oracle DB뿐이고 Prisma에 Oracle 커넥터가 없다(정산·매칭도 PostgreSQL 전용 SQL). 그래서 주 DB는 A1 VM의 PostgreSQL 컨테이너 그대로, 무료 ADB는 **드라이버 없이 ORDS REST SQL로 밀어 넣는 아카이브·분석 저장소**로 붙였다. 주 DB 교체를 다시 검토하려면 Prisma를 버리고 데이터 계층(락 전략 3종·raw SQL 40여 개)을 다시 써야 한다.
- **`deploy/oci/`**: `terraform/`(VCN·IGW·서브넷·보안목록 22/80/443·A1.Flex 4/24 + Ubuntu 22.04 arm64 + cloud-init, `prevent_destroy`), `terraform/cloud-init.yaml`(Docker·compose 플러그인, iptables 80/443 개방, 4GB 스왑, clone → /opt/mock-kabu2), `compose.oci.yml`(production 위 오버라이드: `APP_ORIGIN`으로 IP/HTTP 모드, `CADDYFILE`·`PGBACKREST_CONF` 마운트, Postgres 2G/512MB·API 768M, 봇 400ms/1.25, ORACLE_* env), `Caddyfile.http`(도메인 없이 HTTP), `pgbackrest.s3.conf`(Object Storage S3 호환), `scripts/bootstrap.sh`(.env 자동 생성·비밀값 openssl 채움 → build → up → systemd 타이머 등록; `--update`), `systemd/`(백업 매일·prune 주간·oracle-sync 매시), `oracle/schema.sql`(1부 ADMIN: 사용자+`ORDS.ENABLE_SCHEMA`, 2부: mk_* 테이블·뷰), `README.md`(전체 절차·A1 용량 팁·회수 정책·문제 해결).
- **`pnpm oracle:sync`** (`packages/db/scripts/oracle-sync.ts` + 순수 계획기 `oracle-sync-plan.ts`, node 테스트 4개, db `test` 스크립트 신설): 계정 디렉터리·1분 봉·사용자 낀 체결·사용자 실현손익·자산 스냅샷을 스트림별 워터마크(`mk_sync_state`) 이후로 MERGE(200행/문, 실행당 최대 2만 행). `--dry-run`, `--full`. 엔트리포인트 `oracle-sync`. 로컬 DB로 `--dry-run --full` 확인(문장 생성까지; ADB 실호출은 계정이 없어 미검증).
- Prisma `binaryTargets = ["native", "linux-arm64-openssl-3.0.x", "debian-openssl-3.0.x"]` — x86에서 빌드해 ARM으로 옮겨도 동작.
- 검증: 두 compose 파일 병합 `docker compose config` 통과(IP 모드 env), cloud-init YAML 파싱, `pnpm test` 11 태스크 통과. Terraform은 로컬에 없어 `validate`는 못 했고 python-hcl2로 HCL 문법 파싱만 확인했다 — 첫 `terraform init/plan`에서 프로바이더 스키마 오류가 나면 그 부분만 손보면 된다.

## 2026-09-22 — 성능·자원 최적화 5차: 잡다한 것

- migration `20260922160000_tune_autovacuum_hot_tables`: outbox·claim·orders·trades·ledger에 `autovacuum_vacuum_scale_factor` 0.02~0.05 — 배치 삭제로 생기는 dead tuple을 기본(20%)보다 훨씬 빨리 회수해 힙이 자라지 않게.
- API `OutboxRelayer` 유휴 폴링 200ms → 1s (주문 접수는 `flushSoon()`이 즉시 깨움). 한가한 API의 DB 쿼리 초당 5회 → 1회.
- 프로덕션 compose의 `DATABASE_URL`에 Prisma 풀 상한 `?connection_limit=` (api 8, matching 4, settlement 4) — 4개 프로세스가 `max_connections=80`에 근접하지 않게. `docker compose config`로 문법 확인.
- `next build`(프로덕션) 통과 확인: 대시보드 First Load JS 134KB, 종목 페이지 141KB, 차트 청크는 별도 로드. 빌드 산출물(.next)은 dev와 섞이지 않게 지웠다.
- 웹: `CandleChart`·`EquityChart`를 `next/dynamic({ ssr:false })`로 지연 로드 — lightweight-charts가 첫 JS 번들·SSR에서 빠지고 스켈레톤(glass pulse)이 먼저 그려진다.

## 2026-09-22 — 성능·자원 최적화 4차: 웹 요청 폭주 완화

- `apps/web/src/lib/debounce.ts`(`debounce`, `ACCOUNT_REFRESH_DEBOUNCE_MS=400`): 계정 채널 push를 받는 9곳(대시보드 계좌 갱신, 주문/체결/예약 페이지, 미체결·예약·포지션·주문폼·호가 내 주문·차트 가격선·체결 마커)이 push마다 즉시 REST를 부르던 것을 마지막 push 뒤 400ms에 한 번으로 묶었다. 시장가 한 건이 5단을 관통하면 push 5번 × 컴포넌트 7개 = 35요청이 7요청으로. 15초 폴백은 그대로. 테스트 `lib/__tests__/debounce.test.ts`.

## 2026-09-22 — 성능·자원 최적화 3차: 저장 공간 보존

- **진단**: 로컬 DB 4,665MB 중 `order.outbox` 1.4GB(2.9M행), `matching.outbox_events` 1.1GB, `processed_order_events` 428MB, `closed_order_markers` 406MB, `orders` 845MB(봇 종결 주문 1.07M). 발행된 outbox와 옛 claim이 전체의 85%.
- **프로세스 자체 정리** `packages/shared/src/log-retention.ts` (`LOG_RETENTION`, `pruneBatch`, `pruneUntilDrained`: 5,000행 배치·최대 20회/스윕, 1분 주기): API `OutboxRelayer`가 발행 1시간 지난 `order.outbox`, 매칭 리더가 발행된 `matching.outbox_events` + 7일 지난 `processed_order_events`·`closed_order_markers`를 지운다. 테스트 `core/__tests__/log-retention.test.ts`.
- **주의 — `account.processed_events`는 프로세스가 지우지 않는다.** 체결의 event id == trade id라 정합성 검사("all trades settled")와 복구 플래너가 정산 증거로 쓴다. 이 세션에서 한 번 7일 기준으로 지웠다가(같은 psql -c 트랜잭션에서 VACUUM 에러로 전부 롤백돼 실제 피해 없음) 설계를 바로잡았다: 체결 행이 있는 동안 claim은 남고, 봇 체결을 지울 때만 함께 지운다.
- **`pnpm prune:history`** (`packages/db/scripts/prune-history.ts`, 엔트리포인트 `prune-history`): dry-run 기본, `--apply`. 봇 종결 주문 7일, 봇↔봇 체결 30일(+실현손익·정산 claim), 봇 종결 조건부 주문 7일, 뉴스 30일, `--compact-bot-ledger`로 봇 원장을 계정당 `COMPACTED` 1행으로 압축(sum(delta)==balance 유지). 사용자 계정이 낀 행은 건드리지 않는다. 로컬 적용 결과: 4,665MB → 821MB(VACUUM FULL 후), `check:consistency` 전부 통과. `docs/production-vps-deployment.md`에 "저장 공간 보존 정책" 절 추가(주 1회 cron 권장).
- 스택이 죽을 때 스트림에 남아 있던 미정산 체결 2건은 `pnpm recover:settlement --apply`로 정산했다(복구 플래너의 realized_pnl 생성도 실데이터에서 확인). 스택을 다시 올리면 settlement가 같은 event id를 XAUTOCLAIM으로 받지만 processed_events 덕분에 건너뛴다.

## 2026-09-22 — 성능·자원 최적화 2차: 프로세스·봇 부하

- **워커 컴파일**: settlement·matching-engine·bots에 `tsconfig.build.json`(noEmit false, 테스트 제외)과 `build: tsc -p tsconfig.build.json` / `start: node dist/main.js`. 프로덕션 엔트리포인트(`deploy/production/docker/app-entrypoint.sh`)가 `node apps/*/dist/main.js`를 실행 — tsx/esbuild 서비스가 각 192MB 컨테이너에 상주하지 않고 기동도 빠르다. `pnpm dev`는 여전히 tsx watch. 로컬에서 `node dist/main.js`로 settlement·matching 기동 확인(매칭의 첫 lease 시도가 Redis 연결 전이라 에러 로그 한 줄 뒤 재시도 성공 — 기존 동작).
- **`GET /market/overview`**: 종목 목록 + 당일 요약을 `GROUP BY symbol` 한 쿼리로(2초 캐시). 대시보드가 15초마다 보내던 6개 요청이 1개로. 요약 SQL의 `price*qty`는 int4 오버플로를 피해 `price::bigint*qty`로.
- **봇 부하 손잡이**: `BOT_QUOTE_RECONCILE_MS`(마켓메이커 래더 재조정, 기본 250, 최소 100)와 `BOT_FLOW_DELAY_SCALE`(흐름 봇 대기 배율, 기본 1, 최소 0.25). 프로덕션 compose는 500 / 1.5를 기본으로 넣어 api·postgres 상시 CPU를 대략 절반으로. `.env.production.example`에 설명.

## 2026-09-22 — 성능·자원 최적화 1차

배포(VPS 1대, 컨테이너별 192~384MB) 관점에서 CPU·메모리를 줄이는 작업. 런타임 확인은 스택이 내려가 있어 SQL 직접 실행·단위 테스트로만 했다.
- **정산 캔들 집계를 DB 한 문장으로**: `updateMarket`이 그 분의 체결 행 전부를 Node로 끌어와 max/min/reduce 하던 것을 `INSERT … SELECT array_agg/MAX/MIN/SUM … ON CONFLICT DO UPDATE` 한 번으로 바꿨다. 재전달 멱등성(원장 재집계)은 그대로. 체결이 분당 수백 건일 때 왕복·전송·GC가 모두 줄어든다.
- **인덱스** migration `20260922150000_add_trade_account_order_indexes`: `matching.trades(buyer_account_id, created_at)`, `(seller_account_id, created_at)`, `(buy_order_id)`, `(sell_order_id)`, `conditional_orders(account_id, status)`. 내 체결/차트 마커/브래킷 평균가/복구 플래너가 seq scan → index scan (EXPLAIN ANALYZE 1ms).
- **읽기 캐시** `apps/api/src/core/memo-cache.ts` (`MemoCache`, 프로세스 내 TTL + single-flight, CoreModule 전역): `/market/summary` 2초, 집계 봉(5m~1d) 5초, `/market/index` 15초/60초/120초, 랭킹 10초(기간별, `me`는 요청마다 붙임). 1분 봉·호가·최근 체결은 캐시하지 않는다. 테스트 `core/__tests__/memo-cache.test.ts`.

## 2026-09-22 — 랭킹 기간 필터

- `GET /account/leaderboard?period=all|today|week`: today/week는 기간 시작(KST 자정 / 7일 전) 이후 **첫 자산 스냅샷**을 기준으로 `(현재 자산 − 기준 − 기간 중 입출금) / 기준`, 기준 스냅샷이 없으면(그 뒤 가입) 순입금. 실현손익은 기간 내 합, 지수 등락은 `GREATEST(가입, 기간 시작)` 시점 대비. SQL은 psql로 형태 검증(API 미기동). 웹 랭킹 패널에 오늘/1주/전체 토글(`localStorage("dashboard:leaderboard-period")`).

## 2026-09-22 — 조건부 지정가 발동 UI

- 주문폼 조건부·고정 가격 모드에 **발동 시 시장가 | 발동 시 지정가** 토글과 "발동 후 지정가" 입력(호가 단위 검증). API의 `orderType: LIMIT` + `limitPrice`를 그대로 쓴다. 트레일링은 시장가 발동만. 브라우저 미확인(스택 종료 상태) — typecheck만.

## 2026-09-22 — 웹 단위 테스트

- `apps/web`에 vitest(`vitest.config.ts`, node 환경, `src/**/*.test.ts`, `@` alias)와 `pnpm --filter @mock-kabu/web test`. 순수 로직을 `lib/`로 뽑아 테스트: `drawdown.ts`(MDD), `csv.ts`(`toCsv` BOM·따옴표 이스케이프), `sparkline.ts`(`sparklineGeometry`), `guards.ts`(`guardSummary`). 컴포넌트는 소켓·브라우저에 묶여 있어 다루지 않는다. 루트 `pnpm test`(turbo)가 web 포함 10개 태스크 전부 통과 — dev 스택을 내린 상태에서 실행(실행 중이면 db build의 prisma generate가 EPERM).
- 참고: 이 세션 후반에 dev 스택(`pnpm dev`)이 메모리 부족으로 강제 종료됐다. 이후 변경(웹 테스트, 이하 항목)은 typecheck·단위 테스트로만 검증했고 브라우저 확인은 못 했다.

## 2026-09-22 — 봇 보호 스탑

- `apps/bots/src/main.ts` `ProtectiveStops`: 소액개미(bot6·7)는 시장가 매수 뒤 60% 확률로 기준가 1.5~4% 아래 고정 손절을, 모멘텀(bot10)은 매수 뒤 70% 확률로 2~3% 트레일링을 API `POST /orders/conditional`로 건다(`ApiClient.placeConditional/listConditional`). 봇당 대기 상한 12건(1분마다 재계수), 거절은 조용히 무시. 수량이 1~5주라 시장을 흔들지 않으면서 하락 국면에 스탑 연쇄 매도가 섞인다. 조건부 감시자 부하는 종목당 수십 건 수준.

## 2026-09-22 — API 하드닝

- **주문 상한**: shared `MAX_ORDER_QTY`(1천만 주)·`MAX_ORDER_PRICE`(10억 원). DB price/qty가 Int32라 상한 없이는 이상 주문이 호가창을 왜곡한다. `OrderService.place`에서 400.
- **주문 멱등성**: `POST /orders`에 `Idempotency-Key` 헤더(1~128자)를 주면 `placeIdempotent()`가 Redis `SET NX EX 86400`로 키를 선점하고, 같은 키의 재시도에는 기존 주문을 `idempotentReplay:true`와 함께 돌려준다(접수 실패 시 키 삭제, 동시 재시도는 최대 2초 대기). 웹 주문폼은 제출마다 `newIdempotencyKey()`를 보낸다(더블 클릭·재시도 보호). 키 `KEYS.orderIdempotency`.
- **속도 제한**: `login-rate-limit.guard.ts`의 `enforceRateLimit(redis, rule, request)` 공통 함수 위에 `LoginRateLimitGuard`(IP+이메일, 60초 10회)와 `SignupRateLimitGuard`(IP, 10분 5회). 테스트 `auth/__tests__/rate-limit.test.ts`. 로그인 가드는 Redis `INCR/EXPIRE`(`KEYS.loginAttempts`)라 복제본 간 공유, Redis 장애 시 허용(가용성 우선). 봇 20계정은 이메일이 달라 영향 없음.

## 2026-09-22 — 계정 설정

- `PATCH /auth/me {nickname}`(1~20자, 새 token/user 발급 — 닉네임이 JWT에 들어 있어서)와 `POST /auth/password {currentPassword, newPassword}`(현재 비밀번호 검증, 4자 이상).
- 웹 `/settings` 페이지: 닉네임 저장은 `saveSession()`으로 세션을 갈아 끼우고, `lib/api.ts`의 새 `onSessionChange()`를 Nav가 구독해 경로 이동 없이 우상단 칩이 바뀐다. 진입은 **Nav 우상단 사용자 칩 클릭**뿐 — 기본 메뉴 목록(LEGACY MENU LOCK)은 그대로.

## 2026-09-22 — 주문 정정

- `PATCH /orders/:id {price?, qty?}` (`OrderService.amend`): 지정가 미체결만. 취소 요청 → 최대 4초 동안 100ms 간격으로 DB에서 종결을 확인 → 종결 확인 시 남은 수량(요청 qty와 실제 미체결 중 작은 값)으로 새 지정가 접수. 확인 전 전량 체결이면 `{amended:false, reason}`, 확인 지연이면 422(새 주문 없음). 호가 단위·변경 없음 검증. 응답 `{amended, reason, canceled, order}`. 단일 writer 매칭이라 원자적 교체가 아니며 취소와 재접수 사이에 다른 참가자가 먼저 체결될 수 있다(의도된 한계).
- 웹 `MyOpenOrders.tsx`: 지정가 행의 **정정** 버튼 → 인라인 가격/남은 수량 입력(호가 단위·남은 수량 검증, 변경 없으면 비활성) → 확인. 테스트 `order.service.test.ts` amend 3건.

## 2026-09-22 — 스모크 스크립트

- `pnpm smoke` (`scripts/smoke.mjs`, 의존성 없음): 기동 중인 API에 임시 사용자(닉네임 `smoke-*`, 이메일 없음)를 만들어 시장가 매수→체결→호가 단위 400→매도→실현손익/체결 내역→조건부(이미 만족 400·대기·취소)→OCO 짝 취소→트레일링→브래킷 ARMED→자산/일별/랭킹/헬스 background까지 20개 체크(닉네임 로그인 포함). 봇이 돌고 있어야 시장가가 체결된다. 끝나면 남은 보유를 청산하지만 계정 자체는 남는다(랭킹에 보임 — 필요하면 DB에서 지울 것).

## 2026-09-22 — 브래킷 주문: 매수 체결 후 손절/익절 자동 등록

- **DB**: migration `20260922140000_add_bracket_intents` → `order.bracket_intents` (`order_id` unique, `stop_bps` 10~5000, `take_bps` 10~10000, `status` PENDING/ARMED/CANCELED, `armed_qty`, `avg_fill_price`, `note`).
- **API**: `POST /orders`에 선택 필드 `bracket: {stopBps, takeBps}` — 매수에만 허용(매도면 400, 주문 전에 검증). 주문이 커밋된 뒤 `BracketService.attach()`가 의도를 저장하고 응답에 `bracket`을 실어 준다. `GET /orders/bracket?symbol=`, `DELETE /orders/bracket/:id`(PENDING만).
- **`apps/api/src/order/bracket.service.ts`**: 3초마다 PENDING을 훑어 부모 주문이 종결(FILLED/CANCELED/REJECTED)되면 `updateMany(PENDING→ARMED)`로 claim 후: 체결 0이면 CANCELED("체결 없이 종결된 주문"); 체결 있으면 `matching.trades`의 평균가로 손절 `floor(avg×(1−stop))`·익절 `ceil(avg×(1+take))`를 계산해 **체결 수량만큼** `ConditionalOrderService.placeOco()`. 체결과 등록 사이에 이미 선을 넘었으면 OCO 대신 **즉시 시장가 매도**(note에 사유·주문 ID). 등록 실패는 PENDING으로 되돌려 재시도. 헬스 `background.bracketIntents`. 테스트 `bracket.service.test.ts`(미종결 무시·평균가 OCO·부분 체결·무체결 취소·즉시 매도), `order.controller.test.ts`.
- **웹**: 주문폼 매수(지정가/시장가)에 "체결 후 손절/익절 자동 등록" 체크박스 + 손절/익절 % 입력(기본 5/10). 예약 주문 패널 맨 위에 PENDING 의도를 "대기 · 체결 후 자동 보호 · 손절 −5.0% · 익절 +10.0% [취소]"로 표시, ARMED push는 상단 notice. 런타임 검증: MOCK 20주 시장가 + 3%/8% → 수 초 내 평균가 42,750 기준 OCO 41,467/46,170 등록; 미체결 지정가 취소 시 의도 CANCELED.

## 2026-09-22 — 매매 성과·투자자 랭킹·종목 추세선

- **매매 성과**: `GET /account/realized`가 `stats {fills, wins, losses, winRate, avgWin, avgLoss, profitFactor, best, worst}`를 추가로 돌려준다(실현손익 테이블 집계, 손익 0 체결은 승/패 제외). 웹 `PerformanceCard.tsx`가 대시보드 자산 추이 오른쪽(lg 3열 중 1열)에 표시.
- 랭킹은 닉네임 `smoke-*`(스모크 계정)을 제외한다. 스모크 계정 자체는 DB에 남는다(삭제 스크립트 없음).
- **랭킹 지수 대비(알파)**: `getLeaderboard`가 LATERAL 서브쿼리로 가입 직전 1분봉 종가(없으면 기준가) 대비 현재가 배율의 종목 평균(`index_ratio`)을 구해 `indexRate = ratio − 1`, `alpha = returnRate − indexRate`를 준다. 웹 표에 "지수 대비 +x.xx%p" 열(툴팁에 가입 이후 지수 등락). 현금만 든 계정은 하락장에서 알파가 양수로 나온다 — 의도(현금 보유가 시장을 이긴 것).
- **투자자 랭킹**: `GET /account/leaderboard?limit=` — 사용자(non-bot) 계정을 수익률 `(총자산 − 순입금) / 순입금` 순으로. 순입금 = `SIGNUP_BONUS/SEED/TRANSFER_IN/TRANSFER_OUT` 원장 합, 총자산 = 현금 + Σ보유×`last_price`(실시간 평가). 순입금 ≤ 0은 수익률 null로 맨 뒤. 응답 `{total, rows}`이며 내 행(`me:true`)은 상위 밖이어도 마지막에 붙는다. 웹 `Leaderboard.tsx`가 대시보드 뉴스 아래·보유 자산 위에 표시(30초 폴링). **Nav 메뉴는 LEGACY MENU LOCK 때문에 추가하지 않았다** — 별도 페이지가 필요하면 제품 결정 후 추가.
- **종목 추세선**: 대시보드 종목 표에 `Sparkline.tsx`(인라인 SVG) 열 "6시간 흐름" — 5분봉 종가 72개, 실시간 가격이 마지막 점을 대체, 5분마다 재조회.
- 웹 코드 포맷 주의: 저장소에 prettier 설정이 없어 기본(80열)으로 돌리면 기존 100열 스타일 파일이 통째로 바뀐다. 포맷이 필요하면 `npx prettier --print-width 100`을 쓰거나 패치 범위만 손보기.

## 2026-09-22 — 체결/예약 발동 토스트 알림

- **정산 push 확장**: `apps/settlement/src/main.ts`가 `account:{id}` 채널에 체결 정보를 실어 보낸다 — 매수자에 `{type:"trade", side:"BUY", symbol, price, qty, tradeId}`, 매도자에 `side:"SELL"`(자기 체결이면 한 번). 기존 `account_update`는 `order.closed`에서만 계속 쓰인다. 어떤 payload든 "내 계좌가 바뀌었다"는 신호이므로 기존 구독자(대시보드·주문폼 등)는 그대로 동작한다.
- **브라우저(시스템) 알림**: `/settings`의 "브라우저 알림 켜기"가 `Notification.requestPermission()`을 요청하고 `localStorage("mock-kabu2:desktop-notifications")`에 저장. Toaster가 토스트를 띄울 때 **탭이 가려져 있으면**(`visibilityState !== "visible"`) `showDesktopNotification()`으로 시스템 알림(클릭 시 해당 종목 페이지). 권한 거부 상태면 안내 문구. 브라우저 자동화로는 권한 다이얼로그를 누르지 않았음(수동 확인 필요).
- **알림함**: `lib/notifications.ts`가 계정별 `localStorage("mock-kabu2:notifications:{accountId}")`에 최대 50건을 남기고(읽음 시각 별도 키), Nav의 `NotificationBell.tsx`가 안 읽은 수 배지·드롭다운(종목 링크, 모두 지우기)을 그린다. Toaster가 토스트를 띄울 때 같은 항목을 알림함에도 넣는다(브래킷 ARMED 포함). 드롭다운은 glass의 반투명 배경 위로 페이지 텍스트가 비쳐서 inline `rgba(9,10,15,.97)`로 덮었다.
- **`apps/web/src/components/Toaster.tsx`**(layout에 전역 마운트): 로그인 상태면 `account:{id}`를 구독해 우하단 토스트. 체결은 종목·방향별 1.5초 창에서 합산(`N건 · 평균가`) — 봇 계정으로 로그인해도 폭주하지 않는다. 예약 주문 `TRIGGERED`/`FAILED`도 표시. 최대 4개, 6초 뒤 자동 소멸, `tradeId` 중복 무시. pathname 변화 때 재구독(로그인/로그아웃 대응).

## 2026-09-22 — 자산 추이 스냅샷 + 대시보드 차트

- **DB**: migration `20260922110000_add_equity_snapshots` → `account.equity_snapshots` (`account_id`, 분 단위 `ts`, `cash`, `stock_value`, `equity`; `(account_id, ts)` unique).
- **기록** `apps/api/src/account/equity-snapshot.service.ts`: 부팅 직후 1회 + 매 분 경계(+250ms)에 **한 SQL**로 모든 **사용자(non-bot) 계정**을 기록(현금 + Σ보유수량×`market.symbols.last_price`). `ON CONFLICT DO NOTHING`이라 API 복제본이 여러 개여도 중복 없음. 봇 계정은 제외(유동성 풀이라 의미 없음). 보존: 부팅 시와 하루 한 번 `compact()`가 7일 지난 행은 10분 격자(각 버킷의 마지막 분 :09/:19/…), 90일 지난 행은 1시간 격자(:59)만 남기고 지운다 — 조회가 "버킷의 마지막 행"을 쓰므로 과거 차트 모양이 유지된다.
- **API**: `GET /account/equity?range=1d|1w|all` → `[{ts, cash, stockValue, equity}]`. 버킷 폭 1분/10분/1시간, 버킷당 **마지막** 스냅샷(종가 방식) — `DISTINCT ON (bucket) … ORDER BY bucket, ts DESC`.
- **시장 지수 비교**: `GET /market/index?range=1d|1w|all` — 5종목 동일가중 `mean(close/initial_price)×1000`, 1분 봉을 1분/10분/1시간 버킷으로 묶고 봉이 없는 종목은 직전 값을 이어 쓴다. `EquityChart`가 내 첫 자산에 맞춰 정규화한 점선("시장 지수")을 겹치고, 헤더 토글에 같은 구간의 지수 등락률을 보여 준다 — "시장을 이겼는지"가 한눈에 보인다.
- **웹** `apps/web/src/components/EquityChart.tsx`: 대시보드 hero 아래 면적 차트(lightweight-charts `AreaSeries`). 첫 점 대비 증감으로 색(상승 빨강/하락 파랑/보합 sky), 헤더에 hover 시점(또는 현재)의 자산·증감·현금/주식 내역, 1일/1주/전체 토글은 `localStorage("dashboard:equity-range")`(마운트 후 읽음). 60초 폴링. 스냅샷 2개 미만이면 안내 문구.
- 주의: 스냅샷은 `last_price` 기준이라 대시보드 hero의 실시간 총자산과 최대 1분 차이가 난다(의도). 차트 제거는 CandleChart와 같은 "숨기고 다음 프레임에 remove" 패턴.

## 2026-09-22 — 조건부(예약) 주문

- **DB**: migration `20260922100000_add_conditional_orders` → `order.conditional_orders` (`direction` AT_OR_ABOVE/AT_OR_BELOW, `trigger_price`, `order_type` MARKET/LIMIT, `status` WAITING/TRIGGERED/CANCELED/FAILED, 발동 체결가·접수 주문 ID·실패 사유). **대기 중에는 아무것도 홀드하지 않는다.**
- **감시자** `apps/api/src/order/conditional-order.service.ts`: 부팅 시 WAITING 행을 메모리 인덱스(symbol→id)로 적재하고 `trades:*` Pub/Sub을 구독(REDIS_SUB 공유; Redis가 클라이언트별 패턴 중복을 제거). 체결가가 조건을 만족하면 인덱스에서 먼저 빼고 `updateMany(WAITING→TRIGGERED)`로 **정확히 한 번** claim한 뒤 `OrderService.place()`로 일반 주문 접수. 접수 거부(잔액/수량 부족 등)는 `FAILED`+사유. 부팅 직후와 10초마다 인덱스를 재적재하고 `market.symbols.last_price`로도 검사해 내려가 있던 동안 지나친 조건을 잡는다. 계정당 대기 50건 제한. 현재가가 이미 조건을 만족하면 400으로 거부(일반 주문 안내).
- **OCO(손절+익절 한 쌍)**: migration `20260922120000_add_conditional_oco_group`가 `oco_group_id`를 추가. `POST /orders/conditional/oco {symbol, side, qty, lowerPrice, upperPrice}`가 AT_OR_BELOW/AT_OR_ABOVE 두 다리를 같은 그룹으로 만든다(둘 다 현재가를 넘기면 안 됨). 한 다리가 claim되면 `cancelOcoSiblings()`가 짝 WAITING 행을 `CANCELED`(fail_reason에 사유)로 바꾸고 인덱스에서 제거하며, 한 다리를 사용자가 취소해도 짝을 함께 취소한다. 웹: 포지션 바의 **손절/익절 설정** 버튼이 인라인 폼(기본값 평단 −5%/+10%, 현재가 안쪽으로 보정)을 열어 OCO를 등록하고, 예약 목록에 `OCO` chip. 런타임 검증: NEKO 100주에 18,900/19,000 OCO → 익절 발동·손절 자동 취소·시장가 체결·실현손익 −25,000원 기록 확인.
- **트레일링 스탑**: migration `20260922130000_add_conditional_trailing`이 `trail_bps`(10~5000, CHECK)·`watermark`를 추가. `POST /orders/conditional`에 `trailBps`를 주면 `direction`/`triggerPrice`는 무시되고 매도=AT_OR_BELOW(고점 추적)/매수=AT_OR_ABOVE(저점 추적)로 고정, 등록 시점 `last_price`가 watermark. 감시자 `onTick`은 새 극값이면 메모리의 watermark·trigger를 먼저 옮기고(`trailingTrigger`, 매도 내림/매수 올림) `persistTrail()`로 WAITING 행만 DB에 반영(실패해도 메모리 값이 판정 기준) — 그 tick에서는 발동 검사를 건너뛴다. 재시작 시 DB의 watermark/trigger로 복원. 갱신은 단조 보장: `persistTrail`은 DB watermark가 뒤처진 경우에만 쓰고(`OR: [{watermark:null},{watermark:{lt|gt}}]`), 10초 `reloadIndex`는 메모리 극값이 DB보다 앞서면 메모리 값을 유지한다(테스트 "trailing reload"). 웹 주문폼 조건부 모드에 **고정 가격 | 트레일링** 토글(%, 트리거 미리보기), 예약 목록/탭에는 "트레일링 손절 3%"와 현재 트리거(툴팁에 추적 기준). 런타임 검증: SAKU 0.2% 트레일링 → 고점 260,500→261,000 따라 트리거 259,979→260,478 상승, 260,000 체결에 발동.
- **호가 단위 강제**: `OrderService.place`와 조건부 LIMIT 접수가 `tickSizeOf(symbol)` 격자 밖 지정가를 400(`"SAKU의 호가 단위는 500원입니다"`)으로 거부한다(shared `isOnTick`). 봇은 이미 `alignToTick`으로 정렬하므로 영향 없음(DB 확인: 격자 밖 지정가 0건). 주문폼은 가격 라벨에 단위를 보여주고, 어긋나면 "N원으로 맞추기" 링크와 함께 버튼을 잠근다.
- **일별 성과**: `GET /account/daily?days=` (`EquitySnapshotService.daily`) — KST 날짜별로 그날 마지막 스냅샷의 종가 자산·전일 종가 대비 증감·실현손익 합·매도 체결 수. 스냅샷과 실현손익을 FULL OUTER JOIN 해 둘 중 하나만 있는 날도 나온다. 웹 `DailyPerformance.tsx`가 대시보드에서 투자자 랭킹 옆(lg 2열)에 최근 14일 표시, 첫 행에 "오늘" chip.
- **거래 페이지 UI**: 상단에 `SymbolStrip.tsx`(5종목 현재가·등락률 실시간, 클릭 전환), 호가창 `Orderbook.tsx`의 `useMyDepth`가 `/orders?symbol&status=live`로 내 미체결 지정가 단계에 파란 점 표시(계정 push + 15초 폴백).
- **호가 균형 바**: `Orderbook.tsx` 하단에 보이는 10단 매수/매도 잔량 합과 비율 바(55%↑ 빨강, 45%↓ 파랑). 체결강도(과거 체결)와 구분해 툴팁에 설명.
- **소소한 UX**: 대시보드 종목 표 헤더 정렬(종목/현재가/등락률/거래대금, `localStorage("dashboard:symbol-sort")`), `/orders` 체결 탭 **CSV 내려받기**(UTF-8 BOM, KST 시각).
- **차트 체결 마커**: `useMyFills(symbol)`(`/account/trades?symbol=`, 계정 push로 갱신)를 `CandleChart`가 `createSeriesMarkers`로 그린다 — 같은 봉·같은 방향은 하나로 합쳐 "매수 300"처럼 수량 표기, 매수는 봉 아래 ▲빨강, 매도는 봉 위 ▼파랑. 봉 간격 전환 시 버킷을 다시 계산.
- **차트 가격선**: `apps/web/src/lib/usePositionLines.ts`가 내 평단가(흰 파선, "평단 N주")와 이 종목의 대기 중 예약 트리거(손절 파랑/익절 빨강 점선, 트레일링 노랑)를 읽어 `CandleChart`가 `createPriceLine`으로 그린다. 계정 push + 15초 폴백으로 갱신, 차트 재생성(심볼/봉 전환) 시 `chartEpoch`로 다시 그림. 가격선은 자동 스케일에 포함되지 않아 화면 밖에 있을 수 있다(의도).
- **헬스**: `GET /health/ready`(및 `/health/trading`) 응답에 `background` 필드 — `apps/api/src/core/background-status.ts`의 `BackgroundStatusRegistry`(CoreModule 전역)에 감시자(`conditionalOrders: waiting/lastTickAt/triggered/failed`)와 스냅샷(`equitySnapshots: status up|degraded|starting, lastSnapshotAt, lastInserted, lastError`)이 자기 상태를 등록한다. 정보용이며 readiness 판정에는 관여하지 않는다.
- `pnpm check:consistency`에 두 검사 추가: `realized_pnl` 행이 같은 tradeId의 매도자·수량·가격과 일치하고 `realized = price×qty − cost_basis`인지, 조건부 주문의 TRIGGERED 행에 접수 주문 ID(60초 유예)·FAILED 행에 사유가 있는지, 고정 트리거 WAITING 행이 `last_price`를 2분 넘게 만족한 채 남아 있지 않은지(감시자 정지 감지).
- 포지션 바에 **보호** 항목: 이 종목의 대기 중 매도 예약을 "손절 6,940 · 익절 8,940 · 트레일링 10% (현재 7,155)"로 요약.
- `/orders` 페이지에 **예약** 탭(전 종목 조건부 주문 이력, 대기 행 취소, OCO chip·발동가·취소/실패 사유). 탭 저장 키 `orders:tab`.
- **API**: `POST /orders/conditional {symbol, side, direction, triggerPrice, qty, orderType?, limitPrice?}`, `GET /orders/conditional?symbol=&status=&limit=`, `DELETE /orders/conditional/:id`(WAITING만). 발동/실패 시 `account:{id}` 채널에 `{type:"conditional", status, label, orderId, failReason…}` push.
- **공통 규칙** `packages/shared/src/conditional.ts`: `conditionMet`(경계 포함), `inferTriggerDirection`(현재가 대비 위치로 이상/이하 추론), `describeCondition`(손절/익절/돌파/눌림 라벨). 테스트: `apps/api/src/order/__tests__/conditional.test.ts`, `conditional-order.service.test.ts`(claim 1회·다른 인스턴스 선점·FAILED 기록·LIMIT 전달).
- **웹**: `OrderForm` 주문 유형에 **조건부** 추가(트리거 가격·이상/이하 토글, 방향은 자동 추론 후 수동 고정 가능, 이미 만족 시 경고+버튼 비활성, 호가 클릭은 트리거 칸에 입력). `MyConditionalOrders.tsx`가 거래 페이지 미체결 주문 아래에 대기 목록(취소)과 최근 이력 5건(발동 체결가·실패 사유 title)을 보여주며, push 알림 문구를 상단에 띄운다. 행이 없으면 렌더하지 않는다.
- 런타임 검증(2026-09-22): TANU 현재가 ±10원에 손절/익절 예약 → 봇 체결로 수 초 내 둘 다 TRIGGERED, 접수된 시장가 주문 FILLED 확인. 이미 만족 조건 400, 취소 경합 처리 확인. UI에서 등록·취소·이력 표시 확인, 콘솔 에러 없음.

## 2026-09-22 — 실현손익 추적

- **DB**: migration `20260922090000_add_realized_pnl` → `account.realized_pnl` (계정·종목·`trade_id` unique·수량·가격·차감 원가·실현손익·체결시각). 정산 컨슈머(`apps/settlement/src/main.ts` `settleTrade`)가 매도자 `costBasis` 비례 차감과 **같은 트랜잭션**에 한 행을 남긴다. `trade_id` unique가 재전달을 한 번 더 막는다. 불변식: 누적 `realized` + 남은 `costBasis` = 총 매입원가.
- **공통 계산**: `packages/shared/src/settlement.ts` `realizedPnlForSale()` — 컨슈머와 복구 플래너(`packages/db/scripts/settlement-recovery-plan.ts`, `plan.realizedPnl`)가 같은 BigInt 내림 규칙을 쓴다. 테스트: `apps/api/src/account/__tests__/settlement-state.test.ts`, `packages/db/scripts/__tests__/settlement-recovery-plan.node-test.ts`.
- **API**: `GET /account/realized?limit=` → `{ today, todayQty, total, totalQty, bySymbol[], recent[] }` (KST 당일 경계는 `apps/api/src/common/market-time.ts` `koreaDayStart`, market summary와 공유). `GET /account/trades?limit=&symbol=` → 내 체결(매수/매도/자전, taker 여부, 매도 행에 `realized`·`costBasis`).
- **웹**: 대시보드 hero에 "오늘 실현손익 / 누적 실현손익" 타일, `/orders`에 **주문 | 체결** 탭(체결 탭은 실현손익·수익률 열, 탭 선택은 `localStorage("orders:tab")`), 거래 페이지 포지션 바에 종목 누적 실현손익.
- 주의: 테이블 도입 전의 매도는 행이 없어 집계에서 빠진다(의도). 봇 시드 보유(원가 0)의 매도는 대금 전체가 실현으로 잡히고 `realizedRate`는 null.

## 거래 페이지 포지션 바 + 청산

`apps/web/src/components/MyPosition.tsx` (신규) — 거래 페이지(`/symbol/{symbol}`)의 차트와 주문폼 사이에 배치. **해당 종목 보유가 있을 때만 렌더** (없으면 null).

- 표시: 보유 수량(매도 대기 별도 표기)·평단가·현재가·평가손익(수익률, 이익=빨강/손실=파랑)
- **실시간 수익률**: `/account/holdings`의 costBasis 기반 + `trades:{symbol}` tick의 가격으로 클라이언트에서 재계산. 잔액·보유 변화는 `account:{id}` push + 5초 폴링으로 갱신
- **청산**: `availableQty`(매도 대기 제외) 전량 시장가 매도. 오클릭 방지 2단계 확인 — 첫 클릭에 "N주 전량 매도 확인"으로 바뀌고 4초 내 재클릭 시 실행. 매도 대기 수량만 남으면 버튼 비활성
- 주의: browser `confirm()`은 쓰지 않았음(브라우저 자동화·UX 모두에 나쁨) — 같은 패턴 유지할 것

## 차트 지표

`apps/web/src/components/CandleChart.tsx` — 캔들차트에 지표 4종 추가, 차트 위 버튼으로 개별 on/off:

- **50 SMA**(초록 #22c55e)·**200 SMA**(빨강 #ef4444): 종가 단순이동평균. **100 VWMA**(하양 #f5f5f5): 거래량가중이동평균 Σ(종가×거래량)/Σ거래량. **거래량**: 차트 하단 18% 별도 스케일의 히스토그램(캔들 방향색, 알파 0.45).
- 전부 **클라이언트 계산** — 서버 수정 없음. 과거 데이터는 `/market/candles`(volume 포함, limit 500), 실시간은 `trades:{symbol}` tick의 price·qty로 마지막 캔들·지표 포인트만 갱신.
- 토글 상태는 `localStorage("chart:indicators")`에 저장. **주의: localStorage는 반드시 마운트 후 useEffect에서 읽어 setState할 것** — useState 초기값에서 읽으면 SSR(기본값)과 클라이언트 첫 렌더가 어긋나 hydration mismatch 발생 (이번에 실제로 밟고 수정한 함정).
- 윈도우 미달 구간은 선을 그리지 않음 — 1분봉이므로 200 SMA는 거래 이력 200분, 100 VWMA는 100분 누적 후에야 나타남. 갓 시드한 DB에서 안 보이는 건 정상.

## 평단가·수익률 기능

**목표**: 대시보드에서 종목별 평단가·평가손익·수익률과 전체 수익률을 보여준다.

- **DB**: `Holding.costBasis BigInt` (총 매입원가, 원) 추가 — 평단가 = costBasis/qty. 마이그레이션 `20260712100000_add_holding_cost_basis`는 기존 보유분을 종목 `initial_price`로 근사 백필. 시드도 costBasis 포함(`packages/db/prisma/seed.ts`).
- **정산**(`apps/api/src/account/settlement.consumer.ts`): 매수 시 costBasis += 체결금액, 매도 시 비례 차감 `costBasis × 매도수량 / 보유수량` (BigInt 내림 — qty가 0이 되면 costBasis도 정확히 0). 정산 컨슈머는 단일 프로세스 순차 처리라 이 read-then-update가 안전함.
- **API**(`account.service.ts` getHoldings): `costBasis, avgCost, pnl, pnlRate` 필드 추가. BigInt는 api main.ts의 전역 toJSON으로 number 직렬화.
- **웹**(`apps/web/src/app/page.tsx`): 보유 자산 테이블에 평단가·평가손익(수익률) 컬럼, 상단 Stat에 "평가손익 (전체 수익률)" 타일. 이익=빨강, 손실=파랑.

## 봇 역할 다양화

`apps/bots/src/main.ts` — 10계정 역할 재배치: **마켓메이커 x3**(5종목 분담, 3레벨 양측 호가), **소액개미 x3**(1~5주, 최근 체결 추세를 65% 확률로 추종), **고래 x1**(15~45초 간격 100~400주, 시장가 또는 호가 관통 지정가 — 가격 충격 생성), **노이즈 x2**(순수 랜덤), **모멘텀 x1**. 고래의 대량 시장가는 호가 잔량을 소진하면 잔여분 CANCELED — 의도된 동작(IOC성 잔여 취소).

## 이전 세션에서 한 일

### 1. WebSocket 채널 필터링 버그 수정 — 근본 원인

증상: 캔들차트에 NaN assertion(lightweight-charts) 발생 + 차트 실시간 갱신 정지, TradesFeed에 React key 경고와 NaN 행.

원인: 게이트웨이(`apps/api/src/gateway/realtime.gateway.ts:38`)는 모든 채널을 단일 `"message"` 이벤트 `{channel, data}`로 emit하는데, `apps/web/src/lib/socket.ts`의 `subscribe()`가 채널 필터 없이 모든 메시지를 핸들러에 넘겼음. 같은 페이지의 호가창이 `orderbook:{symbol}`을 join하므로 호가 스냅샷(`price` 필드 없음, `lastPrice`만 있음)이 차트/체결피드 핸들러에 흘러들어 `undefined → NaN`.

수정 (`apps/web/src/lib/socket.ts` 전면 재작성):
- 핸들러 래핑으로 자기 채널 메시지만 전달
- 채널별 refcount — 같은 채널을 쓰는 컴포넌트(CandleChart와 TradesFeed 모두 `trades:{symbol}`) 중 하나만 해제돼도 룸에서 leave되던 결함 수정. 마지막 구독자 해제 시에만 leave
- 재연결 시 전체 채널 재-join을 `getSocket()`에서 중앙 처리

### 2. 방어 코드

- `apps/web/src/components/CandleChart.tsx`: trade 핸들러에 `Number.isFinite(price/ts)` 가드 (오염 페이로드가 차트를 죽이지 않게)
- `apps/web/src/components/TradesFeed.tsx`: 목록 맨 앞과 같은 `tradeId` 중복 수신 무시

### 3. 호가창 높이 고정 (UX)

`apps/web/src/components/Orderbook.tsx`: asks/bids를 항상 8행씩 렌더(부족분은 `EmptyRow` 패딩) — 호가 수 변동으로 아래 매수/매도 주문폼이 위아래로 움직이던 문제 해결.

### 4. README 실행 방법 재구성

최초 1회 설정(`cp .env.example .env` 추가) / 2번째 실행부터(`docker compose up -d` + `pnpm dev`) / 종료 방법(`Ctrl+C` + `docker compose stop`, 완전 초기화는 `down -v`) 3단계로 분리.

## 검증 방법 (완료된 검증의 재현법)

`.claude/skills/verify/SKILL.md`에 상세 레시피 있음. 요약:

1. `docker compose up -d` + `pnpm dev` (이미 떠 있는지 `curl localhost:3000`, `localhost:4000/market/symbols`로 확인)
2. 봇이 상시 거래하므로 주문 없이 관찰 가능. 로그인 필요 시 `bot1@bots.local` / `botpassword`
3. `/symbol/KABU` (종목: KABU·MOCK·NEKO·SAKU·TANU)에서 확인:
   - 마지막 캔들·현재가 라인이 체결마다 실시간으로 움직임
   - 브라우저 콘솔에 NaN assertion / key 경고 없음
   - 실시간 체결 목록에 NaN 행 없음
   - 호가 행 수가 변해도 주문폼 위치 고정
4. `pnpm test` (21개) + `apps/web`에서 `npx tsc --noEmit` — 이번 세션에서 전부 통과 확인함

## 다음 후보 작업 (사용자 미승인 — 착수 전 확인 필요)

2026-09-22 세션에서 남긴 후보 (예전 목록의 현재가 헤더·push 갱신·% 버튼·실시간 시세는 모두 구현됨):
- 자산 스냅샷 90일 이상 장기 보존 정책은 있으나 삭제(퇴장) 계정 정리 없음.
- 시스템 알림 권한 다이얼로그는 브라우저 자동화로 확인하지 못함 — 수동 확인.

스펙상 후속 마일스톤(README 하단): k3d/Helm(M5), k6+Grafana(M6), isolation-lab, AWS(M7+).

## Prisma 마이그레이션 주의 (중요)

- **`prisma migrate dev`는 쓰지 말 것** — init 마이그레이션(`20260712000000_init`)이 적용 후 UTF-16→UTF-8로 재인코딩되어 체크섬이 불일치, migrate dev가 DB 리셋을 요구함. 대신 **마이그레이션 SQL을 수동 작성**(`prisma/migrations/<timestamp>_<name>/migration.sql`)하고 `pnpm db:migrate`(migrate deploy)로 적용할 것. deploy는 체크섬을 재검증하지 않음.
- **`prisma generate`는 `pnpm dev` 실행 중이면 EPERM으로 실패** — 실행 중인 api/matching-engine이 query engine DLL을 잠그기 때문. 엔진 버전이 같으면 생성된 client JS/타입은 이미 갱신된 상태라 무해하지만, `pnpm build`/`pnpm test`(turbo가 db build를 선행)는 dev를 끄고 돌려야 통과함. 테스트만 빨리 돌리려면 각 패키지 디렉토리에서 `npx vitest run`.

## 주의사항 (이 코드베이스 특유)

- **socket.io는 단일 소켓·단일 `"message"` 이벤트**로 모든 채널이 들어온다. 새 실시간 컴포넌트는 반드시 `subscribe()`(필터 내장)를 쓰고, 직접 `socket.on("message")`을 달지 말 것.
- 웹은 HMR로 즉시 반영되지만 api/matching-engine/bots 수정은 `pnpm dev` 재시작 필요.
- Windows 환경 (PowerShell/Git Bash). git이 LF→CRLF 경고를 내지만 무해.
- UI 색 관례: 상승/매수=빨강, 하락/매도=파랑 (한국식).
- 커밋 메시지 컨벤션: 한국어, `feat:`/`docs:` prefix (git log 참조).
