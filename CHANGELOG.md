# 변경 이력

## 2026-09-22 — 손익·예약 주문·대시보드 대폭 확장 + 성능·자원 최적화 (55 커밋)

로컬 실행 순서는 그대로다(`pnpm infra:up` → `pnpm db:migrate` → `pnpm dev`). **새 마이그레이션 7개**가 있으니 기존 DB는 `pnpm db:migrate`를 한 번 돌릴 것.

### 거래 기능
- **실현손익**: 매도 체결마다 평단가 대비 손익을 정산 트랜잭션에 기록. 대시보드 오늘/누적, `/orders` 체결 탭(실현손익·CSV), 포지션 바 종목 실현손익.
- **조건부(예약) 주문**: 손절·익절·돌파·눌림(고정 트리거), **트레일링 스탑**(고점/저점 추적), **OCO** 한 쌍(포지션 바 "손절/익절 설정"), **브래킷**(매수 체결 후 손절/익절 자동 등록), 발동 시 시장가/지정가 선택. 대기 중 홀드 없음, 정확히 한 번 발동, 실패 사유 기록. `/orders` 예약 탭.
- **주문 정정**(지정가, 취소 확인 후 남은 수량 재접수), **호가 단위 검증**, 주문 상한(1천만 주·10억 원), `Idempotency-Key` 멱등 주문, 로그인 속도 제한(60초 10회).
- 호가 클릭 시 방향 자동 선택(매도호가→매수·매수호가→매도), 호가창에 내 미체결 표시·잔량 균형 바, 차트에 평단가·예약 트리거 가격선·내 체결 마커, 종목 전환 스트립.

### 대시보드·분석
- 분 단위 **자산 추이** 차트(1일/1주/전체, 7일/90일 압축 보존) + **모의 시장 지수** 비교선.
- **매매 성과** 카드(승률·손익비·평균 손익·최고/최저·MDD), **일별 성과**(KST 종가 자산·전일 대비·실현손익).
- **투자자 랭킹**(봇 제외, 오늘/1주/전체, 지수 대비 알파, 내 순위 항상 표시).
- 종목 표 정렬·6시간 추세선.

### 알림·계정
- 체결·예약 발동 **토스트**, Nav **알림함**(안 읽은 배지·최근 50건), 선택적 **브라우저 시스템 알림**.
- `/settings` 닉네임·비밀번호 변경(우상단 사용자 칩에서 진입).

### 성능·배포 자원 (후반 세션)
- 저장 공간: 발행된 outbox·옛 매칭 claim을 각 프로세스가 1분마다 배치 삭제, `pnpm prune:history`(봇 종결 주문·봇↔봇 체결·뉴스·봇 원장 압축, dry-run 기본). 로컬 DB 4.6GB → 0.8GB. 고회전 테이블 autovacuum 튠. 배포 가이드 "저장 공간 보존 정책".
- DB: 체결 계정/주문 인덱스 4개 + 조건부 (account, status) 인덱스; 정산 캔들 집계를 SQL 한 문장으로.
- API: 요약·집계봉·지수·랭킹 프로세스 내 TTL 캐시(single-flight), `/market/overview`(대시보드 6요청→1), outbox 유휴 폴링 1s.
- 프로세스: 정산·매칭·봇을 tsc로 컴파일해 프로덕션에서 `node dist/main.js`(tsx 상주 제거). 봇 부하 손잡이 `BOT_QUOTE_RECONCILE_MS`/`BOT_FLOW_DELAY_SCALE`(프로덕션 500ms/1.5).
- 웹: 계정 push 후 재조회 400ms 디바운스, 차트 컴포넌트 지연 로드(`next build` 대시보드 134KB). 웹 vitest 16개.

### Oracle Cloud Always Free
- `deploy/oci/`: Terraform(A1.Flex 4 OCPU/24GB, 네트워크, 방화벽) + cloud-init + `compose.oci.yml`(IP/HTTP 모드, Object Storage 백업) + `bootstrap.sh` + systemd 타이머(백업·정리·ADB 동기화). 가이드 `deploy/oci/README.md`.
- Autonomous Database(무료 Oracle DB)를 아카이브·분석 저장소로: `deploy/oci/oracle/schema.sql`, `pnpm oracle:sync`(ORDS REST SQL, 드라이버 없음, 워터마크 증분 MERGE). 주 DB는 PostgreSQL 유지(Prisma에 Oracle 커넥터 없음).
- Prisma 엔진 arm64/x86 동시 생성.

### 봇·운영
- 개미 봇은 매수 뒤 고정 손절, 모멘텀 봇은 트레일링을 걸어 하락장 스탑 연쇄를 재현.
- `/health/ready`에 백그라운드 작업 상태, `pnpm check:consistency`에 실현손익·조건부 주문 불변식, `pnpm smoke` E2E 스모크(19개 체크), `apps/web` vitest 도입, [REST API 레퍼런스](docs/api.md).
- 버그 수정: lightweight-charts "Object is disposed" 예외(차트 제거 타이밍).

자세한 설계·검증 기록은 [HANDOFF.md](HANDOFF.md).
