# 가상 투자·체결 엔진 시스템 기획안

**작성일**: 2026-07-11
**상태**: 초안 (v1.1 — 무료 로컬 실행 트랙 추가)
**목적**: 포트폴리오급 실서비스 구현. 전 과정을 로컬에서 무료로 완주할 수 있게 하고, 클라우드 배포는 선택 단계로 둔다. 핵심 증명 포인트는 **동일 자산·잔액에 대량 트래픽이 몰릴 때의 Race Condition을 세 가지 락 전략으로 각각 해결하고, 정량 비교한 것**.

---

## 1. 프로젝트 개요

### 1.1 한 줄 요약

가상 자산(모의 주식/코인)을 사고파는 **모의 투자 거래소**. 사용자는 가상 잔액으로 지정가/시장가 주문을 넣고, 체결 엔진이 실시간으로 주문을 매칭한다. 계좌 이체·주문·체결·정산 전 구간에서 동시성 제어를 직접 설계·구현·검증한다.

### 1.2 핵심 목표 (우선순위 순)

1. **Race Condition 해결 증명**: 동일 잔액/자산에 동시 요청이 몰릴 때 낙관적 락, 비관적 락, Redis 분산 락 **3가지를 모두 구현**하고 런타임에 전환 가능하게 하여, 부하 테스트로 처리량·지연·정합성을 정량 비교한다.
2. **트랜잭션 격리 수준 설계**: 이체·체결·정산 각 유스케이스에 맞는 PostgreSQL 격리 수준을 선정하고, 격리 수준이 낮을 때 발생하는 이상 현상(Lost Update, Write Skew)을 재현 테스트로 증명한다.
3. **로컬 우선(local-first) + 저비용 고가용 인프라**: 개발·테스트·벤치마크·배포 리허설까지 전 과정을 **로컬에서 $0으로 완주**할 수 있게 한다(Docker Compose + k3d). 클라우드 비용은 실제 배포를 선택할 때만 발생하며, 그때는 EC2 스팟 인스턴스만으로 운영하되 스팟 회수 이벤트·스냅샷 처리로 가용성을 유지한다. IaC로 전체를 코드화하여 AWS 크레딧 소진 시 GCP/Azure로 이전 가능하게 한다.
4. **마이크로서비스 아키텍처**: 서비스를 책임 단위로 분리하고, 서비스 간 정합성(Saga/Outbox)까지 다룬다.

### 1.3 비목표 (Out of Scope)

- 실제 금전 거래, 실계좌 연동, KYC
- 실시간 외부 시세 연동은 v1에서 제외 — 내부 시세 시뮬레이터로 대체 (v2 후보)
- 모바일 앱

---

## 2. 기술 스택 (확정)

| 영역 | 선택 | 비고 |
|---|---|---|
| 언어 | **TypeScript 전 구간 고정** | 프론트·백엔드·인프라 스크립트 모두 |
| 프론트엔드 | Next.js (App Router) + Tailwind CSS | 대시보드, 호가창, 주문 UI |
| 백엔드 | **Node.js + NestJS** | 아래 2.1 결정 근거 참조 |
| DB | PostgreSQL 16 | 단일 프라이머리 + WAL 아카이빙 |
| 캐시/락/스트림 | Redis 7 | 분산 락, Pub/Sub(시세), Streams(이벤트 버스) |
| ORM | Prisma (일반 CRUD) + 원시 SQL (락·격리 수준 제어 구간) | `SELECT ... FOR UPDATE`, `SET TRANSACTION ISOLATION LEVEL`은 원시 SQL로 명시 |
| 모노레포 | pnpm workspace + Turborepo | |
| 부하 테스트 | k6 | 락 전략 비교 벤치마크의 핵심 도구 |
| 로컬 실행 | **Docker Compose + k3d** | 전 구간 무료 로컬 개발·벤치마크·배포 리허설 (5.0 참조) |
| IaC | Terraform(OpenTofu) + k3s + Helm | 멀티클라우드 이전 대비 (배포 시에만 사용) |
| 관측 | Prometheus + Grafana + Loki | 벤치마크 대시보드 겸용 |

### 2.1 백엔드 프레임워크 결정 근거

목표에서 "백엔드는 상황에 따라(.NET/FastAPI 등)"라 했으나 "모든 스택은 TS로 고정"이 우선 조건이므로 Node.js로 확정. 후보 비교:

- **NestJS (선택)** — DI·모듈 구조가 마이크로서비스 분할과 자연스럽게 맞고, 락 전략을 인터페이스+구현체 교체(Strategy 패턴)로 보여주기에 가장 좋음. 이력서/포트폴리오 가독성도 높음.
- Fastify 단독 — 오버헤드는 최소지만 서비스가 늘어날수록 구조 일관성을 직접 만들어야 함. 체결 엔진같이 순수 성능이 중요한 단일 서비스에만 부분 채택 가능.
- .NET — 체결 엔진 성능은 최상이나 TS 고정 조건 위배. 탈락.

**절충**: 체결 엔진(matching)만은 NestJS 컨텍스트 없이 가벼운 순수 TS 프로세스(Fastify 또는 raw)로 두어 이벤트 루프 지연을 최소화한다. 나머지 서비스는 NestJS.

---

## 3. 시스템 아키텍처

### 3.1 마이크로서비스 구성

```
[Next.js Web] ──HTTPS──> [Cloudflare Tunnel] ──> [API Gateway (NestJS)]
                                                      │
        ┌──────────────┬──────────────┬───────────────┼───────────────┐
        ▼              ▼              ▼               ▼               ▼
   auth-service   account-service  order-service  matching-engine  market-data
   (인증/세션)     (잔액/원장/이체)  (주문 접수/취소)  (호가창/체결)     (시세 시뮬레이터)
        │              │              │               │               │
        └──────── PostgreSQL ─────────┘        Redis Streams ── Redis Pub/Sub
                  (서비스별 스키마 분리)          (주문/체결 이벤트)      (실시간 시세 push)
```

| 서비스 | 책임 | 데이터 |
|---|---|---|
| **api-gateway** | 라우팅, 인증 검증, rate limit, WebSocket 종단(호가/체결/잔액 실시간 push) | 없음 (stateless) |
| **auth-service** | 회원가입/로그인, JWT 발급, 세션 | `auth` 스키마 |
| **account-service** | **핵심 서비스.** 가상 잔액 원장(ledger), 입금(가입 보너스), 계좌 이체, 체결 정산. 3가지 락 전략이 여기에 구현됨 | `account` 스키마: accounts, ledger_entries, holdings |
| **order-service** | 주문 접수·검증·취소, 주문 상태 관리, 주문 시점 잔액 홀드(hold) | `order` 스키마: orders |
| **matching-engine** | 심볼별 인메모리 오더북(가격-시간 우선), 주문 매칭, 체결(trade) 생성 | 이벤트 소싱: `matching` 스키마 trades + Redis Streams |
| **market-data** | 가상 시세 생성(랜덤워크 + 체결가 반영), 캔들 집계 | `market` 스키마: candles |

- DB는 **물리적으로 1개 PostgreSQL 인스턴스, 서비스별 스키마 + 별도 DB 유저**로 논리 분리한다. 스팟 기반 저비용 운영과 마이크로서비스 원칙("서비스는 자기 데이터만 소유") 사이의 절충이며, 서비스 코드는 타 스키마에 접근 권한이 없다.
- 서비스 간 동기 호출은 최소화하고, 상태 변화는 **Redis Streams 이벤트**(`order.placed`, `trade.executed`, `settlement.completed` 등)로 전파한다. Kafka는 스팟 3~4대 예산에서 운영 부담이 과하므로 채택하지 않는다. Streams의 consumer group + ack로 at-least-once를 보장하고, 컨슈머는 멱등하게 짠다.

### 3.2 주문 → 체결 → 정산 데이터 흐름

```
1. 주문 접수   : order-service가 주문 검증 → account-service에 잔액 홀드 요청(여기서 락 전략 적용)
2. 주문 발행   : orders INSERT + outbox INSERT (동일 트랜잭션) → outbox relayer가 Redis Streams 발행
3. 체결       : matching-engine이 스트림 소비 → 인메모리 오더북 매칭 → trade 이벤트 발행
4. 정산       : account-service가 trade 소비 → 매수자/매도자 잔액·보유자산 갱신(락 전략 적용) + 홀드 해제
5. 실시간 반영 : gateway가 체결/잔액 이벤트를 WebSocket으로 push, market-data가 체결가로 시세 갱신
```

- **체결 엔진 내부는 락이 없다**: 심볼당 단일 파티션·단일 컨슈머(single-writer principle)로 설계하여 오더북 자체에는 경합이 발생하지 않는다. 경합은 전부 **잔액/보유자산이 있는 account-service**로 모이며, 여기가 락 전략 비교의 실험대다.
- 주문~정산은 **Saga(choreography) + Outbox 패턴**: 각 로컬 트랜잭션에 outbox 테이블을 함께 커밋하고 릴레이어가 발행함으로써 "DB에는 커밋됐는데 이벤트는 유실" 문제를 차단. 정산 실패 시 보상 트랜잭션(주문 거부 + 홀드 해제).
- 멱등성: 모든 이벤트에 `event_id`, 정산 처리 테이블에 `processed_events(event_id PK)`를 두고 중복 소비를 무시한다.

---

## 4. 핵심: 동시성 제어 설계

### 4.1 경합 시나리오 (재현 대상 버그)

| # | 시나리오 | 락 없이 생기는 문제 |
|---|---|---|
| S1 | 동일 계좌에서 동시 이체/출금 N건 | Lost Update → 잔액이 음수가 되거나 차감 누락 |
| S2 | 동일 계좌로 동시 주문 N건 (잔액 홀드 경합) | 잔액보다 큰 주문이 동시에 통과 (초과 매수) |
| S3 | 동일 보유자산에 대한 동시 매도 | 보유 수량 초과 매도 |
| S4 | 인기 종목에 체결 정산 폭주 | 정산 순서 꼬임, 잔액 왜곡 |
| S5 | "두 계좌 합산 잔액이 X 이상일 때만 출금 허용" 같은 다중 행 제약 | Write Skew (행 단위 락으로 못 막음 → 격리 수준으로 해결) |

### 4.2 락 전략 3종 — 공통 인터페이스로 교체 가능하게

account-service의 잔액 변경 로직을 인터페이스로 추상화하고, 환경 변수 `LOCK_STRATEGY=optimistic | pessimistic | distributed`로 구현체를 선택한다.

```ts
// packages/concurrency — 공유 패키지
interface BalanceMutator {
  // fn 안에서 잔액 읽기→검증→쓰기가 원자적으로 보장되어야 한다
  withAccountLock<T>(accountId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}
```

**① 낙관적 락 (Optimistic Lock)**
- `accounts.version` 컬럼. `UPDATE accounts SET balance = $1, version = version + 1 WHERE id = $2 AND version = $3` → 영향 행 0이면 충돌로 판단, 지수 백오프 + 지터로 재시도(최대 N회 후 409 응답).
- 예상 특성: 경합 낮을 때 처리량 최고, 경합 높을 때 재시도 폭증으로 급락. **재시도 횟수를 Prometheus 메트릭으로 노출**해 그래프로 증명.

**② 비관적 락 (Pessimistic Lock)**
- 트랜잭션 내 `SELECT ... FROM accounts WHERE id = $1 FOR UPDATE` 후 검증·갱신.
- 데드락 방지 규칙: 이체처럼 두 계좌를 잠글 때는 **항상 계좌 ID 오름차순으로 잠근다**. `lock_timeout` 설정으로 무한 대기 차단.
- 예상 특성: 경합 높을 때도 처리량이 안정적으로 유지, 대신 평균 지연 증가.

**③ Redis 분산 락 (Distributed Lock)**
- `SET lock:account:{id} {token} NX PX {ttl}` + 해제는 토큰 비교 Lua 스크립트(자기 락만 해제).
- TTL 만료 후 좀비 프로세스가 쓰는 문제는 **fencing token**(락 획득 시 단조 증가 카운터를 받아 DB 갱신 조건에 포함)으로 방어 — Redlock 논쟁(Kleppmann vs antirez)을 README에 정리해 이해도를 보여준다.
- 용도: DB 커넥션을 잡기 전에 진입 자체를 직렬화하므로 커넥션 풀 고갈 방지에 유리. 여러 서비스 인스턴스에 걸친 임계 구역(예: 정산 컨슈머 다중 배포) 보호.
- Redis는 단일 인스턴스 + AOF로 시작하되, 락 유실 시나리오와 한계를 문서화.

### 4.3 트랜잭션 격리 수준 설계

| 유스케이스 | 격리 수준 | 근거 |
|---|---|---|
| 일반 조회 (잔액, 주문 내역) | READ COMMITTED (기본) | 이상 현상 무해, 성능 우선 |
| 계좌 이체, 잔액 홀드, 정산 | READ COMMITTED + **행 락(전략 ①②③)** | Lost Update는 락으로 해결. 격리 수준만 올려 해결하는 대안(REPEATABLE READ의 first-updater-wins 직렬화 오류 + 재시도)도 벤치마크에 포함해 비교 |
| S5 다중 행 제약 (Write Skew) | **SERIALIZABLE** + 직렬화 실패 재시도 | 행 락으로 막을 수 없는 유일한 케이스임을 테스트로 증명 |
| 일 단위 정산 집계 배치 | REPEATABLE READ | 스냅샷 일관성 필요 |

- 재현 테스트 스위트 `isolation-lab/`: 격리 수준별로 Lost Update·Non-repeatable Read·Write Skew를 **의도적으로 발생시키는 통합 테스트**를 작성한다. "버그 재현 → 해법 적용 → 통과"가 각각 커밋으로 남는 것이 포트폴리오의 핵심 스토리.
- 추가 안전망: `CHECK (balance >= 0)` 제약과 append-only `ledger_entries`(모든 잔액 변동 이력, 복식부기식)로 락이 뚫려도 데이터 왜곡을 DB 레벨에서 최종 차단·감사 가능하게 한다.

### 4.4 벤치마크 계획 (증명 방법)

- 도구: k6. 시나리오 S1~S4를 각 락 전략 × 동시성 단계(VU 10/50/200/500)로 실행. **기본 실행 환경은 로컬 Docker Compose(5.0)** — 클라우드 배포 시 동일 스크립트로 재측정.
- 측정: 처리량(TPS), p50/p99 지연, 실패율, 재시도 횟수, 데드락 발생 수, DB 커넥션 사용률.
- **정합성 검증이 벤치마크의 합격 기준**: 부하 종료 후 `sum(ledger_entries) == 잔액 총합`, 음수 잔액 0건, 초과 매도 0건을 자동 검사하는 스크립트 포함.
- 결과는 Grafana 대시보드 + README의 비교표/그래프로 공개.

---

## 5. 인프라 설계

인프라는 **0단계(로컬, $0) → 1단계(AWS 스팟, 배포 선택 시)** 순서로 진행한다. M1~M6의 모든 산출물(기능, 재현 테스트, 벤치마크, 배포 리허설)은 0단계만으로 완성되며, 1단계는 "실서비스로 공개하고 싶을 때"만 밟는다.

### 5.0 로컬 환경 (0단계, 무료) — 기본 실행 환경

```
[브라우저] ──> localhost:3000 (Next.js)
                 │
                 ▼
          Docker Compose (docker-compose.yml 하나로 전체 기동)
            ├─ api-gateway / auth / account / order / matching / market-data
            ├─ PostgreSQL 16 + Redis 7
            └─ Prometheus + Grafana + Loki  (벤치마크 대시보드 동일 구성)
```

- **Docker Compose가 일상 개발 환경**: `docker compose up` 한 번으로 서비스 6개 + DB + Redis + 관측 스택 전체가 뜬다. 서비스 코드는 볼륨 마운트 + watch 모드로 핫 리로드.
- **k3d(k3s in Docker)로 쿠버네티스 리허설**: 5.3의 Helm 차트(L2 레이어)를 로컬 k3d 클러스터에 그대로 배포해 검증한다. `k3d node delete`로 노드를 강제로 죽여 **스팟 회수 시나리오(5.2)를 로컬에서 무료로 훈련**할 수 있다 — 클라우드에서 바뀌는 것은 L1(Terraform)뿐이다.
- **벤치마크도 로컬에서 완결**: k6 → Compose 스택으로 부하를 쏘고 Grafana에서 관측한다. 단일 머신이라 절대 수치(TPS)는 클라우드와 다르지만, **락 전략 3종의 상대 비교(경합 시 처리량 곡선, 재시도 폭증, 데드락)는 동일 조건이므로 유효**하다. README에는 "로컬(머신 사양 명시) 기준" 수치를 싣고, 클라우드 배포 시 동일 스크립트로 재측정만 하면 된다.
- **외부 공개도 무료로 가능**: 필요하면 로컬 머신에 cloudflared를 붙여 Cloudflare Tunnel(무료)로 임시 공개 URL을 만들 수 있다 (포트포워딩·공인 IP 불필요). 데모 시연용.
- 백업·PITR 연습: wal-g의 S3 대상 대신 로컬 MinIO(무료, S3 호환) 컨테이너를 사용해 5.2의 WAL 아카이빙·복원 절차를 동일하게 검증한다.
- 요구 사양: 메모리 8GB면 전체 스택 + k6 실행 가능(서비스당 ~150MB 수준). 관측 스택은 벤치마크 시에만 켜는 Compose profile로 분리한다.

### 5.1 구성 개요 (AWS 1단계 — 실서비스 배포를 선택할 때만)

```
Cloudflare (DNS + Tunnel + CDN, 무료)
   │  아웃바운드 터널 (인바운드 포트 0개, 공인 IP·ALB 불필요)
   ▼
EC2 스팟 인스턴스 3대 (k3s 클러스터, ARM t4g/m7g 계열)
   ├─ node-app  x2 : 게이트웨이·서비스들·cloudflared (Deployment, HA 2 replica)
   └─ node-data x1 : PostgreSQL + Redis (EBS gp3 볼륨 분리 마운트)
S3: WAL 아카이브 + 논리 백업 + Terraform state
```

- **리전**: 스팟 가격 최저 벨트인 `us-east-2`(오하이오)를 1순위로 하되, Terraform 변수로 리전을 두고 배포 시점에 스팟 가격 조회 후 결정. 지연보다 비용 우선(사용자향 정적 자산은 Cloudflare CDN이 흡수).
- **Cloudflare Tunnel + DNS**: cloudflared를 클러스터 안에 replica 2로 배포. TLS·DDoS 방어·캐시까지 무료로 해결되고, 스팟 IP가 바뀌어도 터널이 알아서 재연결되므로 Elastic IP도 불필요.
- 인스턴스 타입: ARM(Graviton) 스팟이 x86 대비 단가가 낮음. Node/Postgres/Redis 모두 ARM 네이티브 지원.

### 5.2 스팟 회수 대응 (가용성 유지)

**애플리케이션 노드 (stateless)**
- 모든 서비스는 replica ≥ 2, `podAntiAffinity`로 노드 분산.
- 각 노드의 DaemonSet이 IMDS의 스팟 중단 알림(2분 전) 폴링 → 감지 즉시 `kubectl cordon + drain` → 파드가 생존 노드로 재스케줄. (AWS Node Termination Handler 사용)
- ASG(스팟, 다중 인스턴스 타입·다중 AZ 풀 지정)가 회수된 노드를 자동 보충 → cloud-init으로 k3s 조인.

**데이터 노드 (PostgreSQL/Redis)**
- 데이터는 인스턴스와 수명이 분리된 **EBS 볼륨**에 존재 — 스팟이 회수돼도 볼륨은 남는다.
- 2분 알림 수신 시: `CHECKPOINT` 실행 → 클린 셧다운 → 볼륨 detach. 보충된 새 스팟이 부팅 스크립트로 **같은 AZ의 볼륨을 re-attach** 후 기동. (다운타임 목표: 2~4분)
- AZ 자체가 소진돼 다른 AZ로 뜨는 경우: EventBridge `EC2 Spot Instance Interruption Warning` → Lambda가 최신 스냅샷에서 해당 AZ에 볼륨 복원.
- 백업 3중화: ① EBS 스냅샷 (DLM으로 시간 단위 자동화) ② wal-g로 WAL 연속 아카이빙 → S3 (PITR 가능, **멀티클라우드 이전 시 이 백업이 이사짐**) ③ Redis AOF (락·스트림은 유실 시 재구성 가능하므로 완화된 기준 적용).
- RPO: WAL 아카이빙 기준 ~1분 / RTO: 5분 이내. 모의 투자 서비스이므로 수용 가능하며, 이 수치 자체를 문서화한다.

### 5.3 IaC와 멀티클라우드 이전 전략

- 레이어 분리로 이전 비용 최소화:
  - **L1 Terraform** (클라우드 종속): VPC/네트워크, 스팟 ASG, EBS, S3, IAM. `modules/aws`, `modules/gcp`, `modules/azure`로 인터페이스(입출력 변수)를 통일 → 이전 시 이 레이어만 교체.
  - **L2 k3s + Helm** (클라우드 중립): 모든 서비스·DB·모니터링은 k8s 매니페스트. GCP(Spot VM)·Azure(Spot VM)에서도 그대로 적용.
  - **L3 데이터**: wal-g 백업을 S3 → GCS/Blob으로 복사 후 PITR 복원. Cloudflare가 DNS를 쥐고 있으므로 **터널 엔드포인트만 새 클러스터로 바꾸면 컷오버 완료** (DNS 전파 대기 없음).
- 이전 리허설을 마일스톤에 포함: AWS에서 GCP로 실제 1회 이전해보고 소요 시간을 기록한다 (크레딧 소진 전 사전 검증).
- GitHub Actions: CI(테스트/빌드/이미지 push) + CD(Helm 릴리스). 셀프호스티드 러너 불사용(스팟 회수와 충돌).

### 5.4 예상 비용 (월)

| 단계 | 항목 | 예상 |
|---|---|---|
| **0단계 (로컬)** | Docker Compose + k3d + MinIO + Cloudflare Tunnel | **$0** |
| 1단계 (AWS, 배포 시) | 스팟 t4g.medium x3 (us-east-2) | ~$12–18 |
| 1단계 | EBS gp3 30GB x2 + 스냅샷 | ~$6 |
| 1단계 | S3 + 트래픽 | ~$3 |
| 1단계 | Cloudflare | $0 |
| | **1단계 합계** | **~$25 내외** (프리티어/크레딧 적용 전) |

- 비용은 **실서비스 배포(1단계)를 선택한 기간에만** 발생한다. 개발·검증·벤치마크·포트폴리오 산출물은 전부 0단계에서 $0으로 완성 가능하며, 배포도 시연 기간에만 켰다 끄는 방식(Terraform apply/destroy)으로 일할 계산해 더 줄일 수 있다.

---

## 6. 프론트엔드 (Next.js + Tailwind)

- 페이지: 로그인/가입 → 대시보드(잔액·보유자산·손익) → 종목 상세(호가창 + 캔들 차트 + 주문 폼) → 주문/체결 내역 → 이체.
- 실시간: 게이트웨이 WebSocket 구독(호가·체결·잔액). 재연결 시 REST 스냅샷 + 시퀀스 번호로 갭 복구.
- **동시성 실험 관전 모드**: 현재 락 전략, 실시간 TPS, 재시도/데드락 카운터를 보여주는 어드민 패널. 벤치마크 결과를 서비스 안에서 직접 보여주는 차별화 요소.

## 7. 테스트 전략

- 단위: 오더북 매칭 로직(가격-시간 우선순위, 부분 체결) 순수 함수로 분리해 커버.
- 통합: testcontainers(Postgres/Redis)로 락 전략별 경합 테스트 — 동시 요청 100건을 실제로 쏘아 정합성 검증.
- `isolation-lab/`: 격리 수준 이상 현상 재현 테스트 (4.3).
- E2E: Playwright로 주문→체결→잔액 반영 핵심 경로 1개.
- 부하: k6 시나리오를 CI에서 축소 실행(스모크), 본 벤치마크는 수동 트리거.

## 8. 마일스톤

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| M1 | 모노레포 셋업, auth + account 서비스, **락 없는 이체 API** | S1 버그가 부하 테스트로 재현됨 (음수 잔액 발생 로그) |
| M2 | 락 전략 3종 구현 + isolation-lab | 전략 전환 가능, 재현 테스트 전부 통과 |
| M3 | order + matching-engine + market-data, Saga/Outbox | 주문→체결→정산 E2E 통과, 정합성 검사 통과 |
| M4 | Next.js 프론트 + WebSocket 실시간 | 핵심 페이지 동작 |
| M5 | **로컬 k3d 배포 리허설** — Helm 차트 작성, k3d 클러스터 배포, 노드 강제 삭제 복구 훈련, MinIO 대상 WAL 백업/복원 | k3d 노드 삭제 후 자동 복구, PITR 복원 성공 |
| M6 | k6 벤치마크(로컬) + Grafana 대시보드 + README 비교 보고서 | 락 전략 비교표/그래프 공개 (로컬 머신 사양 명시) |
| M7 (선택, 배포 시) | AWS 스팟 배포 — Terraform + Cloudflare Tunnel, 스팟 회수 훈련, 벤치마크 재측정 | 인스턴스 강제 종료 후 5분 내 자동 복구 |
| M8 (선택) | GCP 이전 리허설 | 이전 소요 시간 문서화 |

- **M1~M6는 전부 로컬(0단계)에서 $0으로 진행**된다. M7부터가 유일하게 비용이 발생하는 구간이며, 생략해도 포트폴리오 핵심 스토리(락 전략 비교 + 격리 수준 증명 + k8s 운영 리허설)는 완성된다.

## 9. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 데이터 노드 스팟 회수 빈발 → DB 다운타임 누적 | 다중 인스턴스 타입 풀 + 최저 중단률 풀 선택(Spot Placement Score). 심하면 데이터 노드만 온디맨드 t4g.small로 전환하는 스위치를 Terraform 변수로 준비 |
| Node 단일 스레드로 체결 엔진 처리량 한계 | 심볼별 파티셔닝으로 수평 확장 여지 확보. 모의 서비스 트래픽에서는 충분하며, 한계 수치를 벤치마크로 측정해 문서화하는 것 자체가 산출물 |
| 마이크로서비스 복잡도로 일정 지연 | M1~M2는 사실상 모놀리식(auth+account)으로 시작, M3에서 분리. 서비스 경계는 처음부터 모듈 경계로 유지 |
| Redis 단일 장애점 (락 유실) | fencing token으로 DB가 최종 방어. Redis 재시작 시 락은 안전하게 소멸(TTL) |
| Prisma가 락/격리 제어를 가림 | 경합 구간은 원시 SQL + `pg` 드라이버 직접 사용으로 명시성 확보 |

## 10. 미결정 사항 (구현 중 확정)

- 가상 시세 시뮬레이터의 모델(단순 랜덤워크 vs GBM) — M3에서 결정
- 종목 수(초기 5~10개 제안), 가입 보너스 금액 등 서비스 파라미터
- 도메인 이름 (Cloudflare에 등록할 실제 도메인)
