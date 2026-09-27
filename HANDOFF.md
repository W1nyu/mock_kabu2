# HANDOFF — mock_kabu 작업 인수인계 (2026-09-22)

## 2026-09-28 05:00~08:30 KST — 서버 부하·목록 로딩 최적화 (로컬 커밋, 운영 미배포)

- 운영 실측(읽기 전용): Postgres CPU 154%. 가장 큰 읽기는 `/market/overview` 세션 통계가 체결 223만 행을 **병렬 순차 스캔**(비용 ~86,800, 분당 ~12회). 계정별 미체결 주문 조회 1회 113ms(옵션 MM이 주기마다). 대기 이벤트 1위는 커밋 WALSync, 다음이 계좌 행 잠금(설계상 경합), 인서트 중 DataFileRead(캐시 부족).
- API: `MemoCache` stale-while-revalidate(`staleMs`) — 랭킹 5분·overview/symbols/summary 10초·지수·추세선은 만료 뒤에도 이전 값을 즉시 주고 뒤에서 갱신(9623066). overview·summary 세션 통계는 5분 경계(30초 여유)까지 캐시 + 이후 체결만 합산(9623066·f099cd4, 최근분은 인덱스 스캔 비용 ~858). `trades/latest`를 LATERAL 쿼리 1개로(0c0bf9d, 운영 4ms; 예전엔 19개 동시 쿼리로 풀 12 독점). 추세선·원자재 개요는 `mapWithConcurrency`로 4/3개씩(78ed295·81d1976). 계좌·보유 조회 병렬화(74d4fea).
- DB: 부분 인덱스 `orders_live_account_created_idx`(마이그레이션 20260928100000, CONCURRENTLY; 합성 200만 행 39ms→0.025ms, prepared 8회째도 사용)(3b57da8). GCP compose: postgres 메모리 3GB·shared_buffers 768MB·effective_cache_size 2GB·random_page_cost 1.1(2647c64) — **적용 시 postgres 재시작(수 초 중단)**.
- 웹: `lib/snapshot`(탭 sessionStorage) — 대시보드·증권·랭킹·종목 화면이 마지막 응답을 먼저 그림(a6f037c), 상단 메뉴가 목록 스냅샷을 미리 받아 둠(75b15f0). `sharedGet`으로 같은 공개 GET 합치기(2dd8aeb·2f38bdb). 폰트 CDN preconnect(fb401e7·a656d8c).
- 봇: 시장 관찰 루프 중복 실행 방지(00f93ec). 운영 로그 오류 0, 현물·선물 전 종목 거래 중, 무체결 옵션은 retired K 계열·깊은 ITM/먼 OTM.
- 08:00 이후 추가: 실시간 체결가 0.2초 묶음 반영 — 대시보드·증권·종목 띠·지수 패널·선물 목록·옵션 체인(e6fdc76·ce45f55·b521cac; 대시보드 거래대금은 스냅샷 세대 번호로 중복 가산 방지). 시장 지수 봉 조회를 현물 종목으로 한정(3325ad2, 운영 1일 132→82ms; 10분 측정에서 candles 순차 스캔 20회의 출처). 10분 측정: trades 순차 스캔 120회·9,258만 행(= overview/summary 세션 집계, 증분 합산 배포로 해소 예정). `isTradingFeeExempt`(auth.users 초당 ~32회)는 수수료 정합성 기준이라 캐시하지 않았다.
- 코드 오류: 운영 전 화면에서 테마 인라인 스크립트가 CSP(nonce 없음)에 막혀 다크 테마 사용자가 매번 라이트로 번쩍였다 → nonce 부여(68971f4·579efb2, 로컬에서 오류 0·첫 화면 다크 확인). favicon 404 → app/icon.svg.
- 배포 시: api·web·bots 재빌드 + `prisma migrate deploy`(인덱스). 웹 변경은 단위 테스트·타입 검사만(로컬 API가 꺼져 있어 화면 확인은 못 함).

## 2026-09-28 04:21 KST — 수수료 + 현물 변동폭 50% 축소 운영 적용, '원' 줄바꿈 수정 (e0b8596·aa5bab6)

- 사용자 요청으로 변동폭 축소를 30% → **50%**(`SPOT_PRICE_MOVE_SCALE = 0.5`)로 바꾸고 예약 대신 바로 적용. 수수료 시작은 원래대로 **2026-09-28 04:20 KST** 체결부터(`TRADING_FEES_EFFECTIVE_AT`).
- 경과: 기존 04:13 예약(`…-20260928`)은 03:25 옵션 수정 배포로 이미지가 달라져 무효 → 타이머 중지·비활성. 새 예약 `/var/lib/mock-kabu-trading-update-20260929`(이름만 29, 오늘 날짜로 설정)의 04:13 실행은 DB diff 백업(pgbackrest)이 120초 제한을 넘겨 **변경 전에 중단**(영향 없음). 04:20 점검 종료 뒤 무점검 교체: 봇 정지 → 27개 소스 교체(원본 `…-20260929/backup/`) → api·settlement·web 새 이미지(healthy) → 봇 새 이미지로 시작. matching-engine은 변경 없어 그대로(`65ed4bf6…`). DB 백업은 03:30 정기 백업 기준(스키마 변경 없음).
- 이미지: `mock-kabu2-app:trading-update-20260929` = `0145c2c4…`. 롤백: `trading-update-rollback-20260929-{api,matching-engine,settlement,web,bots}`, 공유 기준 `trading-update-base-20260929`(`8cf812fc…`). 확인: 교체 1분 뒤 90초간 체결 706건·29종목, 15초 넘은 미정산 0, api·settlement·bots 에러 로그 0.
- 이어서 web만 교체(aa5bab6): 100만 원 이상 가격의 '원'이 다음 줄로 넘어가던 문제. `.num`에 `word-break: keep-all`(숫자+단위는 한 덩어리, 문장은 띄어쓰기에서 줄바꿈), 증권·선물·지표 목록 가격 칸을 `w-[…]` → `min-w-[…]`. 이미지 `wonwrap-20260928`(`34bd6d94…`), 롤백 `pre-wonwrap-20260928`, 원본 `/var/lib/mock-kabu-wonwrap-20260928/backup/`. `DEPLOYED_COMMIT` = aa5bab6.

## 2026-09-28 03:25 KST — 옵션 거래 멈춤 수정 운영 적용 (ee19e1a, api·bots 무점검)

- 증상(사용자 "옵션 거래가 너무 없다", 원자재지수 콜 101.5가 27일 07:40 → 18:45 공백): 운영 27일 12~18시 옵션 체결 0건. 거래 봇 4개(bot2·8·9·10)가 시장가 청산 매도를 시간당 ~90번씩 냈는데 전부 체결 0으로 취소, 보유 한도 6개에 묶여 새 주문을 못 냈다.
- 원인: 옵션 시장가 한도가 `lastPrice` 기준(매수 ×1.5+10호가, 매도 ÷2). 체결이 없으면 최근가가 옛 값에 머물러 한도가 마켓메이커 호가를 벗어나고 → 체결 없음 → 최근가 고정의 악순환. 묶인 보유분은 대부분 가치가 거의 0인 먼 외가격.
- 수정: api `optionMarketReference` — 옵션 시장가 한도를 이론가 기준으로(없으면 최근가, OptionsService는 순환이라 ModuleRef로 찾음). bots `heldToExpiry` — 이론가 2호가 미만 매수 보유분은 닫지 않고 만기까지 두며 보유 한도에서 뺀다. 사용자 결정: 가치 0 근처 옵션에 마켓메이커 매수호가를 새로 두지는 않는다.
- 운영: 봇 정지 → api 교체(healthy) → 봇 시작. 롤백 태그 `pre-optref-20260927`(+api·bots), 원본 `/tmp/src-before-pre-optref-20260927.tgz`. `DEPLOYED_COMMIT` = ee19e1a. 확인: 교체 뒤 8분간 옵션 체결 62건·20종목, 봇 시장가 매수 전부 체결·청산 매도 대부분 체결, 현물 호가 10단 정상.
- 참고: 가치 0 근처 보유분은 한도 밖이라 하루 동안 봇당 보유 종목 수가 6개를 넘을 수 있다(만기 04:11에 정산되어 비워짐).

## 2026-09-27 — 변동성 축소 + 실제 계정 매매 수수료 통합 예약 완료 (9/28 04:20 KST)

- **아래의 변동성 단독 04:15 예약을 대체했다.** 사용자 승인: 현물 변동폭 약 30% 축소와 매수·매도 각각 0.01% 수수료를 2026-09-28 04:10~04:20 점검 이후 적용. 수수료는 `auth.users.is_bot=false`인 실제 계정만, 봇·유동성 계정은 수수료 및 추가 예약금 모두 면제. 레버리지는 명목 체결금액에 이미 포함: 증거금 100만 원 × 10배 = 1,000만 원 → 각 1,000원. 자세한 정책은 `docs/trading-fees.md`.
- `packages/shared/src/trading-fees.ts`: 체결 시각 **2026-09-27T19:20:00Z**부터 1bps. 현물 대금·선물 명목금액·옵션 프리미엄 기준, 체결별 원 미만 올림. 매수/신규 증거금 주문은 1단위당 수수료까지 예약해 부분 체결을 감당한다. 매도 대금에서 차감하는 현물 매도 및 증거금 없는 청산 주문은 기존 방식대로 주문 가능. 기존 미체결 주문은 취소하지 않고, 부족한 수수료는 기존 `futuresDebt`에 미납 기록해 잔액/예약금 불변식을 유지한다.
- API와 정산은 동일한 서버 DB 봇 플래그를 사용한다. 현물·선물·옵션 정산의 기존 `processed_events` 트랜잭션 내에 수수료 원장과 채무 처리를 넣었고, 계정 업데이트는 계정당 1회 유지(optimistic 락 지원). 적용 이전 체결을 지연 처리해도 소급 부과하지 않는다. 구형 `recover:settlement` 복구 도구는 적용 이후 체결의 처리 완료 표시를 거부한다(수수료 포함 정산 컨슈머로 재처리 필요).
- 화면: 주문 가능 수량에 수수료 포함, 실제 계정 주문창에 예상 수수료·레버리지 안내, 체결 내역/CSV에 수수료 열. 기존 실현손익·거래 성과 통계는 **수수료 차감 전**임을 명시했으며 현금·총자산에는 수수료가 반영된다. DB 스키마 변경은 설명 주석뿐이며 마이그레이션 없음.
- **서버 예약 등록 완료, 아직 운영 적용 전.** `mock-kabu-spot-volatility-20260928.timer` 이름은 유지하고 실행을 **04:13 KST**로 변경. `/var/lib/mock-kabu-trading-update-20260928/activate.py`가 기존 소스·이미지 SHA, 점검 마커, 봇 정지, 스토리지 가드, 당일 파생상품 정산 완료, outbox를 확인하고 DB diff 백업 후 api·matching-engine·settlement·web 교체 및 health 확인. bots는 `up --no-start`로 준비하고 기존 maintenance-end가 **04:20**에 시작한다. 수수료는 체결 시각으로 04:20부터 활성화된다.
- 새 이미지 `mock-kabu2-app:trading-update-20260928` = **`sha256:23590b1a383c92ee9819badeaf1b6d8a4887f4d2446381550fba901798bc0449`**. 위 디렉터리의 `files.json`에 27개 소스 before/after SHA, `manifest.json`에 기존 서비스별 이미지와 새 이미지 ID. 기존 이미지는 `mock-kabu2-app:trading-update-rollback-20260928-{api,matching-engine,settlement,web,bots}` 태그로 보존. 운영 소스 백업은 실제 교체 직전에 `backup/`으로 보존한다. 성공 시 `applied.json` 및 gcp 태그 갱신, 실패 시 소스·서비스별 기존 이미지 복구와 `rolled-back.json`. 복구 실패/강제 종료 때 `in-progress`를 남겨 maintenance-end drop-in이 봇 재개를 막는다. **중간에 다른 배포로 소스/이미지가 달라지면 예약은 거부되므로 반드시 재검토해야 한다.**
- 검증: 봇 128, API 182, 정산 20, 웹 30, DB 21개 테스트 통과. API/웹/정산 타입 검사와 최종 서버 이미지의 TypeScript·Next.js production build 통과. 서버 새 이미지의 네트워크 차단 컨테이너에서 정산 20개 재확인. systemd 문법·예약 시각·모든 소스/이미지 사전 검사 통과. compose dry-run은 bots만 재생성하고 시작하지 않음. 기존 운영 5개 컨테이너 모두 실행 중이며 이미지/시작 시각 그대로(봇 시작 2026-09-27T06:29:52Z). 이 예약은 미커밋 변경을 SHA로 추적하며 `DEPLOYED_COMMIT=2192ff5`는 그대로다.
- Codex heartbeat `automation`도 **9/28 04:25 KST 1회** 통합 적용 확인으로 갱신했다. 실제 배포는 서버 systemd가 수행한다. 결과 확인 시 위 새 경로·이미지 기준으로 확인할 것(아래 이전 단독 이미지/경로 사용 금지).

## 2026-09-27 — 현물 가격 모델 변동폭 30% 축소 (9/28 04:20 KST 적용 예약)

- **2026-09-28 변경: 로컬 소스를 50% 축소(`SPOT_PRICE_MOVE_SCALE = 0.5`)로 바꿨다(봇 테스트 129개·타입 검사 통과). → 2026-09-28 04:21 운영 적용(맨 위 기록).**
- 사용자 요청: ±30% 초과는 허용하면서 개별 주식 가격 움직임을 지금보다 약 30% 완만하게.
- `apps/bots/src/market-model.ts`의 `SPOT_PRICE_MOVE_SCALE = 0.7`: 시장 추세·공통 변동성·종목별 변동성·점프·뉴스의 영구/일시 가격 충격과 틱당 제한을 70%로. 표준편차를 먼저 줄인 뒤 분산으로 제곱한다. 뉴스 잔여 충격 종료 기준도 같은 비율로 줄여 지속 시간·매매 방향/거래량 편향을 유지한다. 시장 체결가 추종·이동 기준가 범위·주문 제한은 그대로이며 일일 상하한가는 추가하지 않았다. 환율·원자재 모델은 변경하지 않았다.
- 검증: 변경 전/후 같은 난수 5종 × 10,000틱, 현물 15종목 각각 50,000틱의 로그수익률 표준편차 비교 → 뉴스 없음/있음 모두 약 30% 감소. 실제 체결가는 호가 단위·사용자/봇 주문 흐름의 영향도 받아 감소율을 보장하지 않는다. 봇 테스트 128개 및 봇 타입 검사 통과.
- 사용자 추가 요청으로 **2026-09-28 04:10~04:20 KST 정기 점검 이후 적용** 예약 완료. 서버 `mock-kabu-spot-volatility-20260928.timer`(1회, Persistent=false)가 **04:15 KST**에 정지된 bots 컨테이너만 `compose up --no-start --no-deps --no-build --pull never --force-recreate bots`로 교체하고, 기존 maintenance-end 타이머가 **04:20 KST**에 시작한다. 현재 실행 중인 봇·운영 소스·gcp 이미지 태그는 아직 기존 상태.
- 준비물: `/var/lib/mock-kabu-spot-volatility-20260928/{activate.py,manifest.json,market-model.ts}`. 새 이미지 `mock-kabu2-app:spot-volatility-20260928` = `sha256:b3e4bbf938eab6c3069de5b189c083db0f15b72600b0218112b239f8392a669f`. 최신 gcp 이미지에서 현물 모델 소스만 교체하고 봇 TypeScript를 다시 컴파일한 파생 이미지. 기존 봇은 `mock-kabu2-app:spot-volatility-rollback-20260928`(`2dd204218684…`), 기존 gcp는 `mock-kabu2-app:spot-volatility-base-20260928`(`9f9e7f415d07…`)로 보존. 일반 pre-* 정리 대상에서 제외.
- 예약 스크립트는 해당 날짜 04:10~04:18 구간·점검 정지 마커·봇 정지·스토리지 가드 해제·준비 당시 이미지/소스 일치를 확인한 뒤 적용한다. 소스 교체와 컨테이너 준비 성공 시 gcp 태그도 새 이미지로 옮기고 `applied.json`을 기록한다. 교체 중 오류면 원래 소스·태그·정지된 봇 컨테이너로 복구한다. **그 전에 다른 배포로 이미지/모델 소스가 바뀌면 안전을 위해 예약 실행이 거부되므로 이 예약도 재검토할 것.** 아직 커밋하지 않은 모델 변경이라 `DEPLOYED_COMMIT`은 그대로(2192ff5); 이 예약은 manifest와 소스 SHA로 추적한다.
- 예약 검증: 이미지 내부 컴파일 결과 `SPOT_PRICE_MOVE_SCALE = 0.7`, 사전 검사 및 systemd unit 검증 통과, compose dry-run에서 bots만 재생성하고 시작하지 않음 확인. 기존 봇 이미지·시작 시각(2026-09-27T06:29:52Z) 유지 확인. Codex 이 채팅 heartbeat `automation`은 **9/28 04:25 KST 1회** 실제 이미지·실행 로그·체결 확인 및 결과 보고 예약(실제 적용은 서버 systemd가 담당).

## 2026-09-27 16:10 KST — 로그아웃·언어 선택을 프로필 메뉴로 이동 운영 적용 (2192ff5, web만 무점검)

- 사용자 요청: 상단 로그아웃 버튼·언어 선택 제거, 프로필 칩을 누르면 바로 로그아웃. 새 `UserMenu.tsx` — 칩 클릭 → 드롭다운(닉네임 · 계정 설정 · 로그아웃), 바깥 클릭·Esc·경로 이동 시 닫힘. 언어는 계정 설정 화면에서 바꾼다.
- 로그인 전 화면(로그인·가입)에는 언어 선택을 남겼다 — 다른 입구가 없어서.
- 운영: web만 교체, 롤백 태그 `pre-usermenu-20260927`(+web), 원본 `/tmp/src-before-pre-usermenu-20260927.tgz`(Nav.tsx만; UserMenu.tsx는 새 파일). `DEPLOYED_COMMIT` = 2192ff5. 확인: 이미지 안 UserMenu.tsx 존재, web healthy. 로컬에서 칩 클릭 → 메뉴 열림 확인.

## 2026-09-27 15:59 KST — 증권 화면 현물 검색·상단 메뉴 검색창 제거 운영 적용 (9a99502·b9c1bbf, web만 무점검)

- **증권 화면 현물 검색**(사용자 요청 "종목 검색은 증권창에서도, 현물만"): `/market` 현물 탭의 산업군 칩 위 검색칸. 상단 검색과 같은 매칭(코드·한영일 이름·초성)으로 `matchStockCodes`(`symbol-search.ts`, 현물만·상장 폐지 제외)가 코드 집합을 돌려주고, 검색어가 있으면 산업군 선택과 상관없이 전체 현물에서 거른다(정렬은 사용자가 고른 순서 유지). 제목 "검색 결과", 결과 없으면 "검색 결과가 없습니다", ✕·Esc로 지우기.
- **상단 메뉴 검색창 제거**(b9c1bbf, 다른 세션, 헤더 UI 깨짐): `NavSearch.tsx` 삭제·`Nav.tsx`에서 제거. 서버에서도 `NavSearch.tsx`를 지웠다.
- 운영: web만 교체, 롤백 태그 `pre-marketsearch-20260927`(+서비스별), 원본 `/tmp/src-before-pre-marketsearch-20260927.tgz`(NavSearch.tsx 포함). `DEPLOYED_COMMIT` = b9c1bbf. 확인: jobradar.my `/market`(브라우저 요청 헤더) ko·en·ja 모두 검색칸 1개, `/symbol/KABU`에 상단 검색 없음, web healthy, 5분 오류 로그 0.
- 참고: curl로 확인할 때 `Accept: text/html`이 없으면 Caddy가 `/market`을 API로 보내 JSON 404가 나온다(정상).

## 2026-09-27 — 상단 메뉴 종목 검색·일본어 금액 ₩ 표기 운영 적용 (4ea4256·dc37ca0, web·bots만 무점검)

- **종목 검색**(사용자 피드백 "검색 창이 없어 불편"): `NavSearch` — lg 이상은 메뉴 줄 입력칸, 좁은 화면·폰은 돋보기 버튼 → 헤더 아래 패널. `/` 키로 열기, 방향키·Enter. 대상은 현물 15·선물 7·환율/원자재 6(상장 폐지·옵션 제외). 코드·한영일 이름·한글 초성(`ㄷㅇ` → 다온반도체). 로직 `apps/web/src/lib/symbol-search.ts`(NFKC가 호환 자모를 바꾸므로 초성은 정규화 전 입력으로 비교), 테스트 `symbol-search.test.ts`. 전역 `:focus-visible`이 레이어 밖이라 입력칸 테두리는 인라인 `outline: none`으로 끈다.
- **일본어 금액**: 사용자 요청 "ja도 en처럼, ウォン 쓰지 말 것" → `formatWon`·서버 문구·거래대금·가입 문구·뉴스 금액(`formatEokLocale` ₩320B 등)을 영어와 같은 ₩ 표기로. 통화 이름(`ドル/ウォン`)과 기사 속 "ウォン高" 같은 말은 유지. 옛 기사 번역은 DB에 ウォン 그대로(새 기사부터 ₩).
- 운영: web·bots만 교체, 롤백 태그 `pre-search-20260927`(+web·bots), 원본 `/tmp/src-before-pre-search-20260927.tgz`. 확인: jobradar.my ja 쿠키로 `/market` 본문 ウォン은 `ドル/ウォン` 1건뿐·₩ 31건, 검색 `ㄷㅇ` → ダオン半導体, 페이지 오류 0, 봇 재시작 뒤 오류 로그 0.

## 2026-09-27 — 첫 접속 언어: 그 외 브라우저는 영어 운영 적용 (227a7c7, web만 무점검)

- 언어 결정 순서는 그대로(`mk_locale` 쿠키 → `Accept-Language`). 한국어·일본어·영어가 아니거나 헤더가 없으면 이제 한국어 대신 영어(`pickLocale` → `FALLBACK_LOCALE`). `DEFAULT_LOCALE`(ko)는 클라이언트 초기값으로만 남김. 테스트 `packages/shared/test/i18n.node-test.mjs`.
- 기준은 IP 국가가 아니라 브라우저 언어(서버가 DNS-only라 `CF-IPCountry` 없음).
- 운영: web만 교체, 롤백 태그 `pre-localeen-20260927`, 원본 `/tmp/src-before-pre-localeen-20260927.tgz`. 확인: jobradar.my에 fr·zh·빈 헤더 → `lang="en"`, ja → `ja`, ko → `ko`.

## 2026-09-26 — 첫 접속 라이트 모드·가입하기 버튼 운영 적용 (1dede1e, web만 무점검)

- 기본 테마 라이트(`DEFAULT_THEME`). 사용자가 직접 바꾼 테마만 저장(예전 코드는 첫 방문에 dark를 자동 저장했다 — 그 브라우저는 계속 다크). `layout.tsx` 인라인 스크립트로 첫 화면 전에 저장값 적용.
- 가입하기 버튼: 처음엔 상단 메뉴 로그인 옆에 뒀다가, 사용자 요청으로 로그인 화면 카드의 로그인 버튼 아래(테두리 버튼)로 옮기고 "계정이 없나요?" 문구 삭제(f76e6f9, 운영 적용, 롤백 태그 `pre-login-20260926`). 상단 메뉴는 원래대로 로그인만 → 이어서 로그인 버튼도 제거(dd3978a, 운영 적용, 롤백 태그 `pre-navlogin-20260926`). 로그아웃 사용자는 대시보드·랭킹·종목 화면에서 /login으로 이동된다(증권·선물·뉴스 화면에는 로그인 입구 없음).
- 확인: 운영 `/login` HTML `data-theme="light"`, `/signup` 링크, web healthy. 롤백 태그 `pre-theme-20260926`(+web).

## 2026-09-26 20:17~20:24 KST — 인덱스·개요 쿼리·옵션 체인 운영 적용 (83ed7c2)

- 20:17 점검 공지(20:22~20:32) → 무중단 migrate(인덱스 2개 26초, 131MB·80MB, valid) → web → 20:22 봇 정지 → api 재시작 → 점검 해제 → 봇. 확인: 2분간 두 테이블 seq scan 0(인덱스 사용), 엔진 정리 정상(분당 약 2,000행), **Postgres CPU 60% → 11%, 매칭 엔진 56% → 1%**, `/market/overview` 262ms, 정합성 PASS 11 / FAIL 0.
- 롤백 태그 `mock-kabu2-app:pre-index-20260926`(+web·api), 원본 `/tmp/src-before-pre-index-20260926.tgz`.

## 2026-09-26 — 운영 서버 점검, 인덱스 2개·개요 쿼리·옵션 체인 높이 (→ 20:24 운영 적용)

- **핵심 문제**: 매칭 엔진이 1분마다 7일 지난 멱등 기록을 지우는데(`pruneDurableLog`) `processed_order_events.processed_at`·`closed_order_markers.created_at`에 인덱스가 없어 매번 610만·370만 행(각 약 900MB)을 통째로 읽었다(분당 약 1,000만 행, EXPLAIN·60초 seq_scan 증가로 확인). 마이그레이션 `20260926200000_index_processed_order_event_age`·`20260926200100_index_closed_order_marker_age`(CREATE INDEX CONCURRENTLY, 무중단).
- **시세 개요**: `/market/overview` 세션 집계가 종목 조건 없이 `created_at`만으로 체결 전체를 병렬 스캔(2초 캐시라 보는 사람이 있으면 2초마다) → 현물 종목 IN 조건으로 `(symbol, created_at)` 인덱스 사용(운영 EXPLAIN ANALYZE 1.17초 → 0.64초). API 재시작 필요.
- **옵션 체인 높이**: 기본 등가격 ±2(5줄), "행사가 11개 모두 보기", 칸 한 줄(최근가·이론가), `.tbl-compact`.
- 그 밖에 점검 결과(문제 아님): 디스크 25%, 메모리 여유 5.4GB(스왑 0.9GB 사용), Postgres 1.38/1.5GB는 대부분 파일 캐시(anon 250MB), 컨테이너 재시작 0, 1시간 오류 로그 0(bot7 422 1건), 백업 정상, TLS 12/22 만료(Caddy 자동 갱신), Redis 3.7MB. `mock-kabu-prune.service` failed 표시는 9/25 스키마 불일치 때 정합성 검사 예외 — 이후 정합성 PASS 11, 오늘 04:11 실행에서 풀린다.

## 2026-09-26 19:25 KST — 대시보드·옵션 거래 흐름 운영 적용 (1a95370, web·bots만 무점검)

- 확인: web 200·healthy, 봇 재시작 뒤 4분간 옵션 체결 KCOM 13·원/달러 15(시간당 약 420건, 이전 약 46건), 옵션 봇 오류 없음, 정합성 PASS 11 / FAIL 0.
- 롤백 태그 `mock-kabu2-app:pre-dash-20260926`(+web·bots), 원본 `/tmp/src-before-pre-dash-20260926.tgz`.
- 서버 정리(사용자가 직접 실행): 롤백 태그는 `pre-dash`·`pre-opt11`만 남기고 삭제, 빌드 캐시 28.4GB 회수, /tmp 배포 잔여물 삭제 → 디스크 78G → 35G / 145G(54% → 25%). 이후는 04:12 타이머가 태그 최근 8개·빌드 캐시 2GB로 유지.

## 2026-09-26 — 대시보드 평가손익 수익률·보유 자산 합계, 옵션 거래 흐름 확대 (→ 19:25 운영 적용)

- **평가손익 수익률**: 분모를 투입 원가(주식 매입원가 + 선물 증거금 + 옵션 원가) → 총 자산(평가손익 반영 전 = 총 자산 − 평가손익)으로. 라벨 "평가손익 · 총 자산 대비".
- **보유 자산 합계**: 옵션 탭 합계 줄이 `tfoot`에 표 스타일이 없어 여백·정렬이 깨졌다 → `.tbl tfoot td` 스타일(본문 여백·위 구분선). 주식(평가금액·평가손익·수익률)·선물(증거금·평가손익·증거금 대비) 탭에도 합계 줄, 폰 목록에는 `HoldingsTotalItem` 합계 줄.
- **옵션 거래가 너무 적었다**: 운영 6시간 체결이 선물 종목당 약 4,000건인데 옵션은 KCOM 22종목 합쳐 108건, 원/달러 168건(종목당 5~8건). 거래 흐름이 2계정·20~50초·매수만이었다 → 4계정(bot2·8·10 매수 위주, bot9 외가격 쓰기 위주, `OPTIONS_TRADER_STYLES`), 8~25초, 동시 보유 6종목, 1~6분 뒤 청산(쓴 포지션은 되사기, `closingOrder`), 호가가 없어 못 닫으면 1분 뒤 재시도. 예상 약 10~20배(선물보다는 훨씬 적게).
- 배포: web·bots만(마이그레이션·seed 없음, 점검 불필요).

## 2026-09-26 18:30 KST — 옵션 11행사가·미체결 주문 관리·디스크 보존 정책 운영 적용 (9e0c791)

- 사용자 "5분 뒤에 배포해". 18:25 점검 공지(18:30~18:45) + 미리 빌드 → 18:30~18:34 점검: 봇 정지 → pgBackRest diff `20260925-183002F_20260926-093029D` → seed(옵션 44) → api·web·matching-engine·settlement → 점검 해제 → 봇. systemd `mock-kabu-prune`·`mock-kabu-build-cache-prune` 재설치(daemon-reload), pgbackrest.conf는 inode 유지한 채 제자리 교체(컨테이너에서 `repo1-retention-diff=3` 확인).
- 확인: `/market/options` 54행(거래 44·종료 10, 행사가 44/44). 장중 확대라 KCOM은 기존 1~5번(99.00~101.00) 그대로 + 6~11번 바깥쪽(97.50~102.50), 원/달러 동일. 엔진 76종목, 옵션 호가 대부분 2~3단(먼 외가격 풋·콜은 최소 호가라 매수 0단), 정합성 PASS 11 / FAIL 0, 봇 오류 없음. 디스크 73G/145G(51%).
- 오래된 롤백 이미지 태그는 오늘 04:12 타이머가 처음 정리한다(최근 8개 유지).
- 롤백 태그 `mock-kabu2-app:pre-opt11-20260926`(+서비스별), 원본 `/tmp/src-before-pre-opt11-20260926.tgz`.

## 2026-09-26 — 옵션 행사가 5개 → 11개, 옵션 봇 부하 감소, 디스크 보존 정책 단축 (→ 18:30 운영 적용)

- **행사가 11개**: shared `OptionFamilyDef.strikes`(KCOM·원/달러 11, 종료된 K 5), `atmSlot()`(11개면 6번), `familySlots()`. 종목 `KCOMC1~11`·`KCOMP1~11`·`UC1~11`·`UP1~11`(거래 44종목). `OPTION_SLOTS`·`OPTION_ATM_SLOT` 삭제.
- **장중 확대**: `ensureSeries`는 계열에 오늘 거래일 행사가가 있으면 기존 행사가(포지션이 걸린)를 그대로 두고 빈 종목에 사다리 바깥쪽 행사가를 붙인다(`extendStrikeLadder`, 최근가 = 이론가). 오늘 행사가가 없으면 전부 다시 깐다. 다음 04:11 만기 뒤에는 6번이 등가격인 정상 배치.
- **만기 지난 종료 옵션**: `/market/options` `expired`, 주문 422 "만기가 지난 옵션입니다", 옵션 화면은 주문창 대신 안내. MM은 그 종목 호가를 모두 취소.
- **옵션 MM 부하**: 루프마다 `/orders?status=live&limit=500` 한 번(종목별 호출 제거, API `liveOnly`면 take 500), 등가격에서 3.5칸 넘게 먼 행사가는 호가 2단. 테이커 봇은 등가격 기준 거리(`pickStrikeOffset`)로 고른다.
- **미체결 주문(선물·옵션)**: `DerivOpenOrders` — 종목 화면에 내 미체결 목록, 정정(실제 가격 소수 입력 → 정수 단위, 호가 단위 검사, 호가창 클릭으로 가격 입력)·취소·전체 취소. 옵션 화면에는 미체결이 아예 안 보였다(취소도 불가). 선물 포지션 패널의 취소만 되던 목록은 이것으로 대체. `/orders` 주문 내역에서도 접수·부분체결 주문을 바로 취소. 서버 호가 단위 오류가 선물·옵션도 "5원"으로 나오던 것 → 실제 가격(`formatFuturePrice`).
- **웹**: 옵션 체인은 행사가 내림차순·기초자산에 가장 가까운 행사가를 등가격 표시, 옵션 화면의 형제 종목 칩은 콜 → 풋, 행사가 순.
- **디스크**(운영 77G/145G, 54% — 당장 위험하진 않음. 늘어난 원인: 롤백 이미지 태그 약 40개 24GB 중 21GB 회수 가능, 빌드 캐시 31GB 중 18GB 회수 가능, pgBackRest 15GB(diff 한 개 약 1.9GB × 6), DB 6.2GB(orders 1.8GB/336만 행, trades 838MB, processed_events 766MB)):
  - 정리 타이머 인자 `--orders-days 3 --trades-days 14 --ledger-days 3`, 비체결 claim 30 → 14일(체결 claim은 체결이 남아 있는 한 보존 — 불변식 그대로).
  - pgBackRest `repo1-retention-diff` 6 → 3(파일 bind mount라 운영에서는 제자리 수정 — inode 유지).
  - `mock-kabu-build-cache-prune`에 `scripts/ops/prune-rollback-images.sh 8` — 롤백 태그 `pre-*`는 최근 8개만.
  - 지운 행의 공간은 Postgres가 재사용(파일은 줄지 않음 — 증가만 멈춘다). 줄이려면 점검 중 `VACUUM FULL`.
- 배포: 마이그레이션 없음. **seed 필요**(옵션 새 24종목) → api·web·matching-engine·settlement·bots. systemd 유닛 재설치(`install -m 0644 deploy/gcp/systemd/* /etc/systemd/system/ && systemctl daemon-reload`), pgbackrest.conf 제자리 반영.

## 2026-09-26 16:26 KST — 영어·일본어 지원·bot7 수정 운영 적용 (a621241)

- 사용자 "배포해". 미리 빌드 → 16:21 예고 → 16:26~16:31 점검: 봇 정지 → pgBackRest diff `20260925-183002F_20260926-072645D` → migrate(`20260926140000_news_translations`) → api·web·matching-engine·settlement → 점검 해제 → 봇.
- 확인: 웹 `mk_locale` 쿠키별 `<html lang>`·제목 ko/en/ja, 호가 정상, 정합성 PASS 11 / FAIL 0, 배포 뒤 첫 기사부터 translations 저장(예: "국세청, 다온반도체에 과징금…" → en/ja), bot7 증거금 부족 0건.
- 뒤이어 고침(미배포): 영어 헤드라인 첫 글자 대문자(어휘로 시작하면 "the tax authority…"였다).
- 롤백 태그 `mock-kabu2-app:pre-i18n-20260926`(+서비스별), 원본 `/tmp/src-before-pre-i18n-20260926.tgz`.

## 2026-09-26 — 영어·일본어 공식 지원 + bot7 증거금 부족 수정 (→ 16:26 운영 적용)

- **언어 선택**: 쿠키 `mk_locale`(없으면 Accept-Language) → 서버가 첫 화면부터 그 언어로 그린다. 상단 메뉴 `KO/EN/JA`, 설정 화면에도 선택. `apps/web/src/lib/i18n` — `useT()`의 키는 한국어 원문(`t("주문 가능 금액")`, `{n}` 자리표시자), 사전 `messages.ts`(한국어 → [영어, 일본어], 약 630개). 같은 한국어가 뜻이 다르면 `"취소|동작"`처럼 구분. 문장 속 링크는 `rich()`. 빠진 번역: `node apps/web/scripts/i18n-missing.mjs`. 운영자 화면(admin·ops·replay)은 한국어 유지.
- **이름**: shared `i18n.ts` — 종목·업종·원자재·선물·옵션 이름, 원화 표기(1,234원 / ₩1,234 / 1,234ウォン).
- **서버 문장**: API는 그대로 한국어를 던지고, 웹이 shared `server-messages.ts`(한국어 틀 → 영어·일본어, `{값}` 자리)로 옮긴다 — 오류, 예약 실패 사유, 브래킷 메모, 점검 안내. 새 오류 문구를 만들면 여기에 추가.
- **뉴스**: 봇이 한국어 기사와 같은 템플릿·같은 숫자로 영어·일본어 기사를 함께 만든다(`apps/bots/src/news/i18n` — 템플릿 290개 번역, 어휘·공장 지명 230개, 금액 ₩320B / 3,200億ウォン, 분기 Q2 / 第2四半期, 단위). `news_items.translations` JSONB(마이그레이션 `20260926140000_news_translations`), DTO `translations`, 웹은 화면 언어 번역이 있으면 그것(옛 기사는 한국어). 테스트가 번역 누락·자리표시자 불일치·남은 한국어를 잡는다.
- **bot7**: 주식 봇(소액 개인 투자자 역할)이 시드 10억 중 약 8.9억을 주식 재고로 바꿔 선물 주문 가능 금액이 약 600만 원뿐이었다. 선물 거래 흐름 봇이 가용 현금으로 열 수 있는 계약만 내고, 1계약도 못 열면 포지션을 줄인다(`affordableFuturesQty`).
- 배포: migrate(뉴스 번역 열) → api·web·bots·settlement·matching-engine(shared 변경). seed 불필요.

## 2026-09-26 14:40 KST — KCOM 옵션 운영 적용 (f2ca9a7)

- 사용자 "바로 배포해". 미리 빌드 → 14:35 점검 예고 → 14:40~14:44 점검(창 14:55까지): 봇 정지 → pgBackRest diff `20260925-183002F_20260926-054047D` → seed(옵션 20 = KCOM 10 + 원/달러 10) → api·web·matching-engine·settlement → 점검 해제 → 봇.
- 확인: `/market/options` 30행(거래 20·종료 10), KCOM 행사가 100.00(기초자산 99.94, KCOMC3 이론가 0.30pt), 엔진 52종목, 호가 KCOMC3·KCOMP3·KCOMC1 3/3, 거래 종료 KC3·KP3 매수 3단·매도 0(보유자 탈출용), 정합성 PASS 11 / FAIL 0, 봇 오류 없음(bot7 증거금 부족 제외).
- 롤백 태그 `mock-kabu2-app:pre-kcom-20260926`(+서비스별), 원본 `/tmp/src-before-pre-kcom-20260926.tgz`.

## 2026-09-26 — 주가지수 옵션 → 원자재지수(KCOM) 옵션 (→ 14:40 운영 적용)

- KCOM(Kabu Commodity Index) = 원유·천연가스·구리·금·옥수수 5종 동일 가중 평균(기준 100, 환율 제외). 옵션 `KCOMC1~5`·`KCOMP1~5`, 0.01pt × 1,000원, 행사가 0.5pt 간격, 변동성 1.1%, 쓰기 증거금 4%, MM bot43(`OPT_KCOM`, LIQUIDITY_RESERVE_ORDER 끝에 추가). 계열 정의는 `futures: [...]`(구성 선물 평균 = `optionUnderlyingUnits`)로 일반화.
- 주가지수 옵션(K)은 지우지 않고 `RETIRED_OPTION_FAMILIES` — 사용자 매수 422, 보유분 매도 가능, 만기 정산은 그대로, 봇 bot41은 매수 호가만(보유자 탈출용), 체인·행사가 깔기에서 제외. 다음 04:11 만기 뒤에는 포지션이 없어 사실상 끝난다.
- 뉴스 `?reference=commodity`(원자재 아무거나, 환율 제외) — KCOM 옵션 화면의 원자재 뉴스. 원자재 카드·원자재 화면에 KCOM 값.
- 배포: 마이그레이션 없음. seed(KCOM 10종목) → api·web·matching-engine·settlement·bots(엔진이 새 종목을 읽어야 해 점검 필요).

## 2026-09-26 14:08 KST — 증권 탭 환율·원자재 카드, 대시보드 옵션 탭 운영 적용 (e8d6c3c)

- 웹만 교체(점검 없음): KABU 지수 카드 아래 환율 카드(→ `/reference/USDKRW`)·원자재 카드(→ 새 `/commodities` → 품목 상세), 탭 "선물·옵션"(원자재·환율 목록 제거), 대시보드 보유 자산 주식/선물/옵션 탭(옵션 표·합계·수익률), 자산 비중에 옵션, 실현손익 라벨 "선물·옵션".
- 확인: web healthy, `/`·`/market`·`/commodities`·`/reference/USDKRW` 200. 롤백 태그 `mock-kabu2-app:pre-refcards-20260926`(-web), 원본 `/tmp/src-before-pre-refcards-20260926.tgz`.

## 2026-09-26 12:00 KST — 옵션·선물 개선·랭킹 속도 운영 적용 (8351a0e)

- 사용자 지정 시각에 Claude가 배포(예약 실행). 11:55 점검 예고 → 12:00~12:25 점검(실제 12:01~12:04). 미리 빌드해 두고 점검 중에는 봇 정지 → pgBackRest diff `20260925-183002F_20260926-030106D` → migrate(`20260926100000_options`) → seed(현물 15·선물 7·옵션 20) → api·web·matching-engine·settlement → 점검 해제 → 봇.
- 확인: 옵션 20종목 행사가(KC3 940.00 이론가 4.50, UC3 1,405원), 선물 기준가 = 직전 정산가(GOLDF·CORNF는 정산 기록 없어 첫 체결가), 엔진 42종목 부트스트랩, 호가 현물 10단·선물 5단·옵션 3단, 정합성 PASS 11 / FAIL 0, 몇 분 안에 옵션 체결 발생(KC2·KP4·UC3·UP3·UP4).
- 관찰: bot7(선물 거래 흐름)이 "주문 증거금이 부족합니다" 422를 반복 — 계좌 현금 부족으로 보이며 배포 전부터였는지는 옛 컨테이너 로그가 없어 확인 못 함.
- 롤백 태그 `mock-kabu2-app:pre-options-20260926`(+서비스별 `-api` 등), 원본 `/tmp/src-before-pre-options-20260926.tgz`. DB(옵션 표·종목)는 이미지 롤백으로 안 돌아간다.
- 배포 스크립트는 scp로 올린 `/tmp/step{1,2,3}.sh`(로컬 `tmp/deploy/`).

## 2026-09-26 — 선물 점검·개선 (→ 12:00 운영 적용)

- **버그: 선물 손절·익절 예약이 포지션이 없어진 뒤에도 남아** 발동하면 원래 수량 그대로 시장가를 내 반대 포지션을 새로 열었다(전량 청산·04:11 정산·반대매매·뒤집기 뒤). 선물 화면은 포지션이 없으면 예약 목록을 숨겨 사용자가 볼 수도 없었다. → 선물 예약은 청산 전용: 등록 시 보유 포지션 이내만, 발동 시 그때 포지션만큼, 포지션이 없으면 취소, 인덱스 재적재(10초)마다 고아 예약 정리. 옵션은 예약 주문 불가.
- **버그: `/orders` 주문·체결·예약 표가 선물 가격을 정수 단위 그대로**(880.05pt → 88,005) 보여 주고 체결금액을 가격 × 수량(승수 빠짐)으로, 선물 실현손익은 빈칸으로 보여 줬다 → 종목 표기, 명목 금액, `futures_realized` 연결.
- 등락률 기준가 = 직전 일일 정산가(1일물이라 09:00 기준이 04:20~09:00에 이미 끝난 계약과 비교됐다), 거래량도 이번 계약 기준. 선물 화면에 기준가·정산까지 남은 시간.
- 선물 시장가 매도에 하한(최근가 ÷ 1.1, 매수 상한과 대칭) — 호가가 얇을 때 바닥까지 긁지 않게.
- 주문창: 청산 주문의 예상 실현손익, 새 포지션의 긴급 반대매매 예상 가격.
- 운영 DB 점검(반대매매·추가증거금·미수 현황)은 자동 모드가 운영 조회를 막아 못 했다.

## 2026-09-26 — 옵션(주가지수·원/달러 1일물) (→ 12:00 운영 적용)

설계 `docs/superpowers/specs/2026-09-26-options-design.md`(결정값은 사용자 확인 전 기본값).
- 종목 20개 고정(`KC1~5`·`KP1~5`·`UC1~5`·`UP1~5`, 3번 = 등가격), 행사가만 매일 04:11 만기 정산 뒤 다시 깐다(`market.option_series`, 마이그레이션 `20260926100000_options` — symbols.kind에 OPTION 추가). 유럽형 현금 정산, 이론가 블랙-숄즈.
- 포지션·실현손익·정산 기록은 선물 표를 함께 쓴다(옵션 행 `entry_value` = 프리미엄 원가, `margin_held` = 쓰기 증거금). 체결 때 프리미엄이 매수자 → 매도자(원장 `OPTION_PREMIUM`), 만기에 내재가치 현금 정산(`OPTION_EXPIRY`, claim `option-settle:{sym}:{day}:{acct}`, 모자라면 미수금).
- 사용자는 매수·보유분 매도만, 쓰기는 봇만. MM bot41(주가지수)·bot42(원/달러)가 이론가 ± 4%로 3단 호가(재고 ±40 한도), bot8·bot10이 가끔 사고 몇 분 뒤 판다.
- 총 자산·랭킹·자산 스냅샷에 옵션 평가액(최근가 기준, `futuresValueSql`) 포함. 선물 위험 감시(반대매매)는 옵션을 보지 않는다.
- 화면: 증권 → 선물·원자재 탭 옵션 체인, `/options/[symbol]`, 대시보드 선물·옵션 탭, 체결·만기 알림.
- 함께 고침: 실시간 게이트웨이가 `orderbook:`/`trades:` 구독을 현물만 허용해 **선물 화면이 호가·체결을 실시간으로 받지 못하던 문제**(15초 폴링만) — 거래 가능한 전 종목으로 연다.
- 배포 시: migrate(`20260926100000_options`) → seed(옵션 20종목 + KABUF 이름 "주가지수 선물") → api·settlement·matching-engine·bots·web 모두 교체(엔진이 새 종목을 읽어야 함). 미배포 `4b57b97`(랭킹 속도·이름)도 함께 나간다.
- 로컬 Docker가 꺼져 있어 런타임 확인은 못 함(단위 테스트 전부 통과·타입체크만).

## 2026-09-26 07:38 KST — 원자재·환율 기사 운영 실험 (fb45e92)

- 운영자용 기사 즉시 발행 추가·배포: api 컨테이너 안에서 `fetch('http://127.0.0.1:4100/internal/news/force', {method:'POST', headers:{'x-liquidity-bootstrap-token': process.env.LIQUIDITY_BOOTSTRAP_TOKEN, 'content-type':'application/json'}, body: JSON.stringify({templateId:'macro.oil.spike'})})`.
- 실험(환율 급등·유가 급등·금값 급등·옥수수 급락 동시 발행, 5분 관찰): 기초자산이 30초 안에 절반가량, 5분에 대부분 반영 — USDKRW 1,397.8→1,402.2(+0.31%, 기사 "1,400원 돌파"), OIL 99.60→101.32(+1.73%, "101달러 돌파"), GOLD +0.84%(기사 1.0%), CORN −0.83%(기사 1.0%). 선물은 기초자산을 0.1%p 안에서 따라감(CORNF만 첫 30초 지연). 새 기사에 reference_codes 저장 확인.

## 2026-09-26 07:24 KST — 대시보드 순서·주가 지수 선물 이름·지수 차트·평가가격·자산 뉴스·모바일 알림 운영 적용 (d426ca5)

- 점검 없이 pgBackRest diff `20260925-183002F_20260925-222256D` → migrate(`20260926080000_news_reference_codes`) → seed → api·web·bots. 정합성 PASS 11 / FAIL 0, 선물 7종 5단, KABUF 이름 "주가 지수 선물" 확인. 롤백 태그 `pre-mark-20260926`.

## 2026-09-26 — 대시보드 순서·주가 지수 선물 이름·지수 차트·평가가격·자산 뉴스·모바일 알림 (→ 07:24 운영 적용)

- 대시보드: 보유 자산을 자산 추이 아래·종목표 위로. 지수 차트 "09:00 기준" 가격선 제거(머리글의 기준 대비 %는 유지).
- KABUF 이름 "주가 지수 선물"(seed가 선물 이름도 갱신).
- 선물 평가가격 `futureMarkPrice`(기초자산·최근 체결 중앙값·최근가의 중앙값) — 반대매매 감시·포지션 평가손익·유지증거금. 화면 표기 "평가가격".
- 뉴스 `reference_codes`(마이그레이션 `20260926080000_news_reference_codes`, GIN) — 봇이 기사마다 움직인 기초자산을 보내고, 선물·원자재 화면에 관련 뉴스(`AssetNews`, 주가 지수 선물은 시장 전반 기사). 배포 전 기사는 코드가 없어 비어 있다가 새 기사부터 쌓인다.
- 모바일 알림창: 화면 폭 고정 위치로 띄워 잘림 해결, 목록은 안에서 스크롤.

## 2026-09-26 07:00 KST — 선물 손익 반영·금/옥수수 선물·MOCK/TANU/PIXL 상장 폐지 운영 적용 (78e71c3)

- 사용자 지정 시각 07:00에 Claude가 배포(로컬 런타임 확인 없이). 임시 점검 → 봇·엔진·정산 정지 → pgBackRest diff `20260925-183002F_20260925-220350D` → api·web 교체 → `delist-symbols` dry run 확인 → **평단가 정산 원 미만 내림을 올림으로 수정(78e71c3, 사용자가 원금보다 적게 받지 않게) 후 재빌드** → `--apply` → seed(15종목·선물 7) → 엔진·정산 시작 → 점검 해제 → 봇.
- 폐지 결과: 미체결 132건 취소, 예약 12건 취소, 사용자 6명 현금 정산 합계 45,540,040원(현재가 5명, 평단가 1명 — 뉴턴급투자실력 TANU 9,994,880원), 봇 보유 33건 삭제, 지수 18→15종목(916.19에서 연속).
- 확인: 정합성 PASS 11 / FAIL 0, 현물 10단, 선물 7종 5단(GOLDF·CORNF 새 MM bot39·40 생성), MOCK 호가 404, 개요 15종목, 엔진 lag 0, outbox 0, 봇 오류 0, load 2.8.
- 롤백 태그 `mock-kabu2-app:pre-delist-20260926`, 원본 `/tmp/src-before-pre-delist-20260926.tgz`. **폐지·현금 지급은 DB 변경이라 이미지 롤백으로 되돌아가지 않는다**(되돌리려면 위 pgBackRest 백업).
- 원격 스크립트는 `scp`로 올려 `bash /tmp/x.sh`로 실행(한글·BOM 문제 없음).

## 2026-09-26 — 선물 손익 반영, 금·옥수수 선물, MOCK·TANU·PIXL 상장 폐지 (→ 07:00 운영 적용)

- **선물 손익 반영**(ed115e7): 랭킹·자산 스냅샷 총 자산 = 현금 + 주식 + 선물 평가손익 − 미수금(`account/futures-equity.ts`), 랭킹·일별 성과 실현손익에 `futures_realized` 포함, 매매 성과 전체/주식/선물(`/account/realized` combined), 총 자산 평가손익에 선물 포함.
- **금·옥수수 선물**: 기초자산 GOLD(하루 변동성 1%)·CORN(1.8%), 선물 GOLDF(10%/6.66%)·CORNF(15%/10%), MM bot39·bot40. 뉴스: 금 급등·급락(GLOBAL, 위험 회피 시 상승), 옥수수 가뭄·풍작(COMMODITY), 위험 회피·선호 기사 9종에 금 −0.4, 중동 유가 기사에 금 +0.3, 원자재 품목에 "금".
- **상장 폐지**: `SYMBOLS` 15종목, 폐지 종목은 `DELISTED_SYMBOLS`(이름·과거 표시용). 유동성 예약 계정은 `LIQUIDITY_RESERVE_ORDER`로 번호 고정(폐지해도 뒤 종목·선물 번호가 안 밀림 — API·엔진·봇 공통). 지수 이력 계산은 폐지 종목 봉도 읽는다(kind=STOCK 전체). 업종 기사는 주 대상 업종에 상장 종목이 있을 때만(전자·상사·게임 업종 기사는 쉼).
- **폐지 실행**: `delist-symbols`(dry run 기본, `--apply`) — 엔진·정산·봇 정지 상태에서. 미체결 취소·홀드 해제 → 예약/브래킷 취소 → 사용자 보유분: 수익이면 현재가, 손실이면 평단가(원 미만 내림)로 현금 지급(원장 `DELISTING`, 실현손익 `delist:SYM:account`) → 봇 보유분 삭제 → 해당 outbox 미발행분 발행 처리 → 지수 새 구간(수준 연속). 정합성 검사는 `delist:` 실현손익을 체결 대조에서 뺀다.
- 로컬 Docker가 꺼져 있어 런타임 확인은 못 함(단위 테스트·타입체크만).

## 2026-09-26 05:48 KST — 종목 뉴스 탭·선물 수량 %·손절익절 한쪽만 운영 적용 (cf1b5c1)

- 사용자 요청으로 로컬 런타임 확인 없이 배포. pgBackRest diff `20260925-183002F_20260925-204731D` → migrate(`20260926060000_bracket_single_leg`) → api·web 교체(봇·엔진·정산 그대로). 롤백 태그 `mock-kabu2-app:pre-conv-20260926`, 원본 `/tmp/src-before-pre-conv-20260926.tgz`.
- 확인: 정합성 PASS 11 / FAIL 0, `/market/news?symbol=MOCK&scope=own` 이 종목 기사만, 호가 정상, api 오류 로그 0, load 3.5.

## 2026-09-26 — 종목 뉴스 탭, 선물 수량 %, 손절·익절 한쪽만, 선물 뒤로가기·편의 (→ 05:48 운영 적용)

- 종목 화면 뉴스: 전체 / 이 종목 / 업종(산업군) / 시장 전반 탭(localStorage `symbol:news-scope`). API `/market/news?symbol=X&scope=own`.
- 선물 주문 수량 10·25·50·100% — 신규는 주문 가능 금액 ÷ 계약당 증거금(레버리지·시장가 110% 반영), 청산 방향은 보유 포지션 기준. 증거금 미리보기도 시장가 110%로 맞춤. 지정가 호가 −/+ 버튼.
- 손절·익절 한쪽만: 주식 체결 후 자동 등록(마이그레이션 `20260926060000_bracket_single_leg` — stop_bps/take_bps nullable + 하나는 필수 CHECK, 한쪽이면 단일 예약 매도), 보유 종목 설정, 선물 포지션. 선물은 평균가 기준 ±1·3·5% 빠른 입력.
- 선물 화면 "← 선물 목록" + 다른 선물 칩, 기초자산 화면 "← 선물·원자재".
- 로컬 Docker가 꺼져 있어 런타임 확인은 못 함(단위 테스트·타입체크만).

## 2026-09-26 05:21 KST — 대시보드 주식/선물·랭킹 10위·뉴스↔기초자산 운영 적용 (e90164b)

- Claude가 배포: DB 변경 없음 → 백업·점검 없이 api·web·bots만 교체(엔진·정산은 그대로). 롤백 태그 `mock-kabu2-app:pre-dashnews-20260926`(서비스별 태그는 실행 이미지가 이미 정리돼 생략), 원본 `/tmp/src-before-pre-dashnews-20260926.tgz`.
- 확인: 정합성 PASS 11 / FAIL 0, 현물 10단·선물 5단, 봇 오류 0, load 2.9.
- ⚠️ PowerShell 파이프로 보낸 스크립트의 **한글이 깨진다** — 원격 스크립트에는 한글 grep 패턴을 쓰지 말 것(`PASS|FAIL`로 센다).

## 2026-09-26 — 대시보드 주식/선물 구분, 랭킹 10위, 뉴스↔기초자산 일치 (→ 05:21 운영 적용)

- **대시보드**: 자산 비율 현금/주식/선물(선물 = 증거금 + 평가손익, 현금은 증거금·미수금 제외), "선물 평가금액" 지표, 총 자산에 선물 평가손익·미수금 반영, 오늘/누적 실현손익은 주식+선물(툴팁에 나눠 표시). 매매 성과·보유 자산에 주식/선물 탭(`FuturesHoldings`). `/account/realized`에 `futures` 추가(`futures_realized` 집계).
- **랭킹**: 상위 10위만.
- **뉴스↔기초자산**: 템플릿이 움직일 자산을 `referenceMoves`로 명시(환율→USDKRW, 유가→OIL+GAS 0.3, 천연가스→GAS+OIL 0.2, 금속은 {commodity}로: 구리 1·니켈/알루미늄/아연 0.5·철광석 0.3, 리튬·해상운임은 없음). 기사 속 환율·유가 수준과 등락률은 실제 현재값 + 이 기사가 만들 움직임(`referenceNewsMove`, 하루 변동성 × 2)으로 채운다(`reference: true` 슬롯). 충격 절반은 즉시, 나머지는 4분 시간상수. 시뮬레이션 300건: 방향 100% 일치, 10분 안 수준 도달 약 87~89%. 조사 "원로" → `{로}`.

## 2026-09-26 04:21 KST — 이체 제거·레버리지·선물 활성화 운영 적용 (e29d86e)

- Claude가 직접 배포(04:11 정산 직후). 임시 점검(수동 maintenance) → 봇 정지 → pgBackRest diff `20260925-183002F_20260925-192146D` → migrate(`20260926030000_futures_leverage`) → api·web·엔진·정산 교체 → 점검 해제 → 봇 시작. 이어서 선물 거래 봇 bot6→bot9 교체로 봇만 재배포.
- 롤백 태그 `mock-kabu2-app:pre-leverage-20260926`(+서비스별), 원본 `/tmp/src-before-pre-leverage-20260926.tgz`.
- 확인: 정합성 전부 통과, 현물 10단·선물 5종 5단, `/account/transfer` 404, 엔진 lag 0, 선물 체결 3분 149건, load 2.5.
- ⚠️ `bash -s`로 보낸 스크립트 안의 `docker exec`/`compose exec`/`run`은 **남은 스크립트를 stdin으로 먹는다** — 백업 뒤 단계가 조용히 사라졌다. 스크립트는 파일로 올려 `bash /tmp/x.sh`로 돌리거나 명령마다 `< /dev/null`.

## 2026-09-26 — 이체 제거·랭킹 메뉴, 선물 레버리지·청산·손절익절, 선물 거래 활성화 (→ 04:21 운영 적용)

- **이체 제거**: `/account/transfer`·`transfer-all`·`recipients` API와 화면 삭제. `/transfer`는 `/ranking`으로 보낸다. 랭킹은 대시보드에서 빼 `/ranking`(상위 50, 내 순위 포함)으로 옮김. 비밀번호 변경의 요청 제한 가드는 `PasswordRecheckRateLimitGuard`로 이름만 바꿔 유지. 과거 이체 원장(TRANSFER_IN/OUT)은 수익률 계산에 그대로 쓰인다.
- **메뉴**: PC 상단에 "증권" 추가(종목·선물 거래 화면에서도 활성), "이체" → "랭킹"(폰 하단 탭도). 폰 하단 탭은 선물 거래 화면에서 숨김(매수/매도 바와 겹침).
- **선물 화면**: 목록은 이름·티커만, 차트는 봉만(기초자산 겹침 제거), 호가 수량은 숫자만.
- **레버리지**: 1~20배, 마이그레이션 `20260926030000_futures_leverage`. USDF 기준 증거금 4.83% → 5%(20배 상한). 청산 주문 무증거금(`futuresOrderHoldPerUnit`), 반대매매 대기 판별은 `futures_liquidations`에 있는 주문만. 포지션 패널: 레버리지·전량 청산(두 번 눌러 확인)·손절익절(OCO, 예약 주문을 선물에도 허용).
- **거래 활성화**: 선물 거래 봇 bot7·8·9(1.5~4초, 1~5계약; bot6은 현금 부족으로 제외), 모멘텀 문턱↓·확률↑, MM 호가 수량 2배(4~12). 로컬(새 DB) 2분에 선물 체결 174건(이전 3분 24건), 선물 이벤트는 전체의 약 16%.
- **배포 주의**: USDF 증거금률이 바뀌어, 배포 시점에 열린 USDF 포지션은 다음 체결·정산 전까지 정합성 "position margin" 항목이 어긋날 수 있다 → 04:11 정산 직후(04:20~)에 배포하면 포지션이 모두 0이라 안전.

## 2026-09-26 — 선물 1~5단계 일괄 운영 적용 (0e25086)

- `76c4c94` 이후 전부: 봇 체결 관찰 묶음(d52cc73), vCPU 8 한도(eb7f300, postgres 3코어 재생성), 선물 1~5단계, 중복 취소 차단(1170898). 사용자가 절차서대로 직접 실행, 점검 예고는 생략(새벽 02시대).
- 마이그레이션 4개(`20260925200000`~`20260925230000`), seed(18 종목 + 선물 5). 롤백 태그 `mock-kabu2-app:pre-futures-20260926`(+서비스별), 원본 `/tmp/src-before-pre-futures-20260926.tgz`.
- 확인(02:51 KST): 정합성 전부 통과, 현물 10단·선물 5종 5단, 선물 체결 발생, 추가증거금 감시 5초 틱 정상(포지션 계좌 5), outbox 미발행 0, load 2.9.
- 첫 일일 정산은 2026-09-26 04:11 KST — 결과 로그 `[futures] 2026-09-26 settled ...` 확인 필요.

## 2026-09-25 — 선물 1~5단계 (로컬 커밋 → 2026-09-26 운영 적용)

- 설계: `docs/superpowers/specs/2026-09-25-futures-design.md`. 1일물 5종(KABUF·USDF·OILF·GASF·CPRF), 기초자산은 봇이 만드는 가상 가격(원/달러·원유·천연가스·구리, 뉴스 반응).
- 1단계 기초자산(`market.reference_candles`), 2단계 주문·체결·포지션·증거금·미수금·선물 MM(bot34~38)·화면, 3단계 04:11 KST 일일 정산(`FuturesSettlementService`), 4단계 추가증거금·반대매매(`FuturesRiskService`, 30분 유예·손실 90% 즉시 전량).
- 배포 대기 마이그레이션: `20260925200000_reference_candles`, `20260925210000_futures`, `20260925220000_futures_settlements`, `20260925230000_futures_risk`. seed로 선물 종목 등록 필요. 봇 CPU 절감(d52cc73)·GCP 오버레이 한도(eb7f300)도 함께 미배포.
- 반대매매 감시를 끄려면 API 환경변수 `FUTURES_RISK_DISABLED=1`, 선물 봇을 모두 끄려면 bots 환경변수 `BOTS_FUTURES_DISABLED=1`.
- 5단계: 증권 탭 `현물 | 선물·원자재` 전환(`?kind=futures`), 선물 차트에 기초자산 점선, 폰은 하단 매수/매도 바 + 주문 시트, 포지션 패널 증거금 게이지·긴급 반대매매가, 일일 정산 알림. 봇: bot7은 위험하면 줄이기만, bot10 기초자산 모멘텀(90초 변화가 문턱을 넘으면 1~3계약, 3~8분 보유).
- **부하 측정(로컬, 새 DB, 3분씩, 코어 1개=100%)**: 선물 켬 api 56·봇 13·엔진 34·정산 30 / 끔 api 61·봇 14·엔진 35·정산 30. 차이는 실행마다의 흔들림 안쪽. 선물 주문은 전체의 약 13%(3분 793건), 체결은 1.4%.
- **취소 되먹임 수정**: 같은 주문의 DELETE는 30초 안에 한 번만 outbox에 쓴다(`KEYS.cancelRequested`). 로컬에서 MM의 취소 재전송이 엔진 지연과 맞물려 outbox가 약 900건/초로 불어나 129만 건이 쌓인 것을 발견. 로컬 DB(`mock_kabu2`)의 `order.outbox` 미발행 행은 그대로 남아 있다 — 로컬 스택이 느리면 이 적체 때문이다.
- **정산 따라잡기 수정**: API 재기동 때마다 선물 미체결 주문이 전부 취소되던 문제 — 이미 정산한 종목은 취소하지 않고, 포지션·가격이 없는 종목도 완료(price 0)로 기록한다.

## 2026-09-25 — 18종목·산업군 뉴스·동시 접속 최적화 (GCP 운영 적용, 76c4c94)

- **신규 3종목**: NRFD 노스필드정유 150,000원(800만 주)·GARM 가람전력 6,000원(2억)·HAVN 헤이븐리츠 5,000원(2억 4,000만), MM bot31~33. 산업군 에너지·유틸리티 신설, 금융 → 금융·부동산. 폰 증권 탭 거래대금 숨김도 같이 반영.
- **산업군 뉴스**: 봇 뉴스 범위 SECTOR(15~30분, `sectorExposure`로 업종별 방향·크기). `news_items.industry`(마이그레이션 `20260925190000_news_industry`). 종목 뉴스 +47·후속 12·시장 +16.
- **최적화**: 웹 폴링 `everyVisible`(숨은 탭 중지), 점검 조회 탭당 1개, `/market/sparks` 묶음(1분 캐시), 뉴스 2초·체결/1분봉 1초 캐시, 비로그인은 `/account`·`/orders` 요청 안 함, 게이트웨이 빈 방 건너뛰기·호가 150ms 합치기. GCP 오버레이 한도 상향(api 1.5CPU/768M/연결 12, web 1.5CPU/512M, postgres 2CPU/1.5G/shared_buffers 512MB).
- **운영 적용**: 사용자가 절차서대로 직접 실행 — pgBackRest diff → postgres 재생성 → migrate → seed(18) → 지수 편입(18종목) → 서비스 교체. 정합성 검사 전부 통과, 18종목 양측 10단, `/market/sparks` 18종목. 롤백 이미지 `mock-kabu2-app:pre-newsperf-20260925`, 원본 `/tmp/src-before-pre-newsperf-20260925.tgz`.
- **머신 변경 (같은 날 18:50 KST)**: 콘솔에서 e2-standard-4 → **e2-highcpu-8 (vCPU 8, 8GB)**. VM 중지→유형 변경→시작, 컨테이너 자동 기동·`/health/ready` 200. 재기동 2분 뒤 load 1.1, api 23~37%·postgres 12~21%. GCP 오버레이의 vCPU 8 기준 한도(엔진·정산·봇 1.5, postgres 3, 커밋 eb7f300)는 아직 서버 미적용 — 설정 교체 후 해당 서비스 `up -d --no-deps`로 재생성 필요.
- **관찰 필요**: 적용 직후 load average 7.15/6.27/5.52(vCPU 4, 10종목 때 약 2.3). 컨테이너 CPU api 45~106%·postgres 52~99%·엔진 31~57%·봇 22~36%. 대부분 봇 주문이 종목 수(10→18)에 비례해 늘어난 몫이며 웹 최적화로는 줄지 않는다. 계속 높으면 봇 주문 빈도 조정이나 머신 상향을 검토.

## 2026-09-25 — 신규 5종목(15종목)·산업군 필터·1분봉 30일 보존 (GCP 운영 적용)

- **신규 종목**(상장 시가총액 각 1.2조): DDAM 도담건설 1,500원(8억 주, 1원 호가)·SAEM 샘물바이오 12,000원(1억)·STEL 스텔라엔터 30,000원(4,000만)·SLVR 실버모터스 80,000원(1,500만)·NOVA 노바셀배터리 600,000원(200만, 1,000원 호가). 뉴스 섹터 CONSTRUCTION/AUTO/ENTERTAINMENT/BATTERY, SAEM이 첫 BIO라 임상 뉴스 활성. MM 예약 계정 bot26~30.
- **산업군**: `packages/shared/src/industries.ts` 8개(IT·반도체, 2차전지·소재, 산업재, 모빌리티, 미디어·통신, 헬스케어, 소비재, 금융). 새 종목은 반드시 한 산업군에 넣을 것(테스트가 검사). 뉴스 페이지 산업군→종목 2단 칩(`/market/news?industry=<id>|market`), 증권 탭·대시보드 종목표 산업군 태그(평균 등락률), 선택은 localStorage `market:industry` 공유.
- **1분봉 보존**: `prune-history --candles-days 30`(기본) — 30일 지난 1분봉을 1시간봉('1h')으로 합친 뒤 삭제. 1h 이상 봉·지수 "전체"는 1m+1h를 함께 읽는다. 로컬 DB에서 압축 전후 일봉 동일 확인(롤백 트랜잭션).
- **운영 적용**: 사용자가 직접 SSH로 실행(자동 모드가 운영 배포 명령을 막음). pgBackRest diff 후 seed(15 upserted)·`index-add-members --apply`·api/web/엔진/정산/봇 재생성. 15종목 양측 10단, 지수 편입 15종목, 정합성 검사 전부 통과. 롤백 이미지 `mock-kabu2-app:pre-add5b-20260925`(+`-bots/-matching-engine/-settlement`), 원본 소스 `/tmp/src-before-add5b.tgz`.
- **주의**: `/opt/mock-kabu2`는 일반 사용자 쓰기 불가 — 파일 교체는 `sudo tar xf ... --no-same-owner`. 교체가 조용히 실패하면 빌드가 캐시로 금방 끝나고 옛 코드가 배포된다(이번에 seed가 `10 upserted`로 드러남). 빌드 전 `grep`으로 교체를 확인할 것.

## 2026-09-25 — MM 호가 산 모양 분포 (GCP 운영 적용)

- `LIQUIDITY_LEVEL_WEIGHTS` [100,120,140,155,150,135,115,95,80,65,55,45](4호가 최대), 일반 1호가 최소 80주(기존 160). 인접 단 비율 ≤1.25(재사용 한도). 고가 종목(SAKU·DAON)은 `HIGH_PRICE_LEVEL_WEIGHTS`로 기존 앞쪽 집중 유지.
- 운영: bots만 재생성, 롤백 이미지 `mock-kabu2-app:pre-hump-20260925`, 원본 `/tmp/liquidity.ts.orig-prod`. 재기동 직후 옛 주문을 채택해 점진 정규화 중이며, 화면 잔량에는 다른 봇 주문·PARTIAL 가드가 섞인다.

## 2026-09-25 — 관리자 시장 시나리오 (GCP 운영 적용)

- 관리자 전용 `/ops`(메뉴 미노출): 종목 복수·방향(UP/DOWN)·강도 1~3·시작(KST)·기간 5분~24시간. API `/admin/market-scenarios`(비관리자 404), 봇은 `/internal/scenarios/active`를 30초마다 폴링. 테이블 `market.scenarios`.
- 봇 효과: 해당 방향 뉴스 비율(약 61/73/84%)·추가 종목 뉴스 스트림·방향 일치 뉴스 강도 최대 +30%·흐름 봇 기울기(`SCENARIO_FLOW_WEIGHT` 0.3). 시작·종료 최대 10분 램프. 가격을 직접 움직이지 않으므로 방향 보장은 없다.
- 운영: pgBackRest diff `20260923-183013F_20260924-175719D`, 롤백 이미지 `mock-kabu2-app:pre-scenario-20260925`, 원본 소스 서버 `/tmp/src-before-scenario.tgz`. 마이그레이션 `20260925120000_market_scenarios` 적용 후 api/bots/web만 재생성. 10종목 양측 10단, `/health/ready` 정상, 외부에서 `/internal/scenarios/active` 404.
- 확인: `docker logs mock-kabu2-prod-bots-1 | grep scenario` → 등록 시 `[scenario] active/upcoming: <id>`.
- 후속(같은 날 운영 적용): 같은 종목에 시간이 겹치면 새 시나리오를 앞선 시나리오 종료 뒤로 미뤄 등록(`firstFreeStart`, advisory lock, 응답 `requestedStartsAt`). 취소·종료된 시나리오는 `DELETE /admin/market-scenarios/:id`로 삭제. api/web만 재생성, 롤백 `mock-kabu2-app:pre-scen2-20260925`. SAKU·DAON도 산 모양 호가(1호가 최소 20주), 롤백 `pre-hump2-20260925`.

## 2026-09-24 — 롤백 이미지 정리

- 운영 서버에서 `pre-admin/theme/mmfix/mobileui/relist/leaderboard-20260924` 이미지 태그 6개를 삭제했다(사용자 승인). 디스크 32GB → 27GB 사용(19%).
- 9/25: 랭킹·실현손익·일별 성과의 "오늘"을 09:00 KST로 바꿔 배포했다가, 사용자가 00:00 KST 유지로 결정해 곧바로 되돌렸다(코드·운영 모두 원상태, 커밋 없음). 이 과정에서 `pre-add5-20260924`는 지우고 현재 운영 이미지와 같은 `mock-kabu2-app:pre-today0900-20260925` 하나만 롤백용으로 남아 있다. 아래 기록의 다른 `pre-*` 태그는 더 이상 없다. "오늘"은 랭킹·실현손익·일별 성과가 00:00 KST, 시세·지수가 09:00 KST다.
- 23:52 KST 측정: 빌드 없는 1시간에 디스크 +1.06GB. pgBackRest WAL 보관분(차등 백업 뒤 정리됨)이 대부분이고, DB는 약 80MB/시간 증가. 빌드가 없는 24시간 값으로 30일 여유를 다시 판단해야 한다.

## 2026-09-24 — 서버 e2-standard-4 업그레이드·신규 5종목 상장·임시 점검 배너 (GCP 운영 적용)

- **서버**: `mock-kabu-prod`를 e2-standard-2 → **e2-standard-4 (vCPU 4, 16GB)**. 콘솔에서 중지 → 머신 유형 변경 → 시작, 다운타임 약 3.5분(20:28~20:32 KST). 고정 IP·디스크·타이머·컨테이너 자동 기동 확인. 10종목 기동 직후 CPU 약 30~45%.
- **신규 종목**(상장 시가총액 각 1.2조): BORI 보리식품 4,000원(3억 주)·BJAY 블루제이항공 20,000원(6,000만)·SKYL 스카이링크 40,000원(3,000만)·PIXL 픽셀게임즈 60,000원(2,000만)·DAON 다온반도체 400,000원(300만). 뉴스 섹터 FOOD/AIRLINE/TELECOM/GAME/SEMICONDUCTOR와 회사 프로필 추가. 상장가 20만 원 이상은 SAKU와 같은 집중 호가(`isHighPriceListing`). MM 예약 계정 bot21~25.
- **지수 편입**: `packages/db/scripts/add-index-members.ts`(컨테이너 `index-add-members`, 기본 dry run, `--apply`) — 현재 구간에 없는 종목을 상장가로 편입하고 수준이 이어지는 새 구간 추가. 운영 11:32:44 UTC 적용, 지수 936.87 유지.
- **임시 점검**: Redis `mock-kabu2:maintenance:manual` → API가 주문 차단, 웹 `MaintenanceBanner`가 예고/진행 배너 표시(절차 `docs/daily-maintenance.md`). 운영에서 20:26~21:06 예고 후 20:26 시작, 작업 완료 뒤 20:33에 조기 해제.
- 순서: api/web 먼저 교체 → 점검 예고 → 시작 시 봇 정지·pgBackRest diff `20260923-183013F_20260924-112611D` → 머신 변경 → `compose run --rm seed`(종목·봇 보유) → `index-add-members --apply` → 엔진·정산 교체 → 점검 해제 → 봇 시작. 롤백 이미지 `mock-kabu2-app:pre-add5-20260924`, 원본 소스 서버 `/tmp/src-before-add5.tgz`. 10종목 양측 10단, 정합성 검사 전 항목 통과.
- 로컬에서 같은 절차를 먼저 리허설했다(10종목 양측 호가·봇 오류 없음·정합성 통과).

## 2026-09-24 — 투자자 랭킹 정리 (GCP 운영 적용)

- `Leaderboard.tsx`: 상위 10등(`TOP_N`)만 표시 — API가 순위 밖 내 행을 덧붙여도 화면에서는 뺀다. '지수 대비' 열과 그 설명 문구 제거. API 응답의 `indexRate/alpha` 필드는 그대로 둔다. web만 재빌드·재생성, 롤백 이미지 `mock-kabu2-app:pre-leaderboard-20260924`.

## 2026-09-24 — KABU 재상장·시가총액 가중 지수·MM 자가 복구 (GCP 운영 적용)

- **MM 자가 복구**: `OneSidedQuoteWatchdog` — 전용 MM의 자기 호가가 한쪽이라도 60초(`BOT_MM_ONE_SIDED_RESTART_MS`) 동안 0이면 `MarketMakerStalledError`로 빠져나와 `runDedicatedMarketMaker`가 보충·재로그인 후 새로 띄운다(원인 무관 최후 안전장치). 확인 `docker logs mock-kabu2-prod-bots-1 | grep -E "restarting maker|stalled|re-sent cancel"`.
- **시가총액 가중 지수**: `SYMBOLS.listedShares`(MOCK 2,400만·KABU 1,000만·TANU 1억5,000만·SAKU 400만·NEKO 4,800만 → 상장 시가총액 각 1.2조, 상장 시 각 20%). 지수 = Σ(가격 × 발행주식수) ÷ 제수, 편입·제수는 `market.index_epochs`(마이그레이션 `20260924170000_market_cap_index`, 새 DB는 시드가 첫 구간 생성). API `/market/index`, 새 `/market/index/meta`, 랭킹 SQL, 웹(지수 패널 비중·오늘 기여, 증권 탭)이 같은 식을 쓴다.
- **재상장**: `market.symbols.listed_at` 이전 체결은 원장에만 남고 시세(현재가·기준가·당일 통계·체결 목록·엔진 재기동 가격·정합성 현재가 검사)에서 제외. 스크립트 `packages/db/scripts/relist-symbol.ts`(컨테이너 `relist`): 점검 → `--cancel-orders`(API와 같은 outbox 취소, 대기 예약 CANCELED) → `--apply`(가격 기본값 = 직전 종가, 지수 과거 구간에서 종목 제외 + 지금부터 수준이 이어지는 새 구간, 종목 1분봉·뉴스 삭제). 보유는 건드리지 않아 1:1 유지. 과거 구간이 이미 여러 개면 거부한다(다음 재상장 전에 확장 필요).
- **운영 적용 (09:17 UTC)**: pgBackRest diff `20260923-183013F_20260924-090556D`, 롤백 이미지 `mock-kabu2-app:pre-relist-20260924`, 원본 소스 서버 `/tmp/src-before-relist.tgz`. 봇 정지 → 마이그레이션 → api/settlement/web 교체 → KABU 주문 52건 취소 → 재상장(직전 종가 **104,800원**, 사용자 보유 2명 81·62주 유지, 봉 904·뉴스 35건 삭제, 지수 958.42 유지, 과거 지수는 4종목) → 엔진 교체 → 봇 시작. 이후 5종목 양측 10단, KABU 104,800 연속 체결, 지수 958.42→957.52(점프 없음), 정합성 검사 전 항목 통과, `/health/ready` 정상.
- 폰 거래 화면 하단 버튼 순서를 매수(왼쪽)/매도(오른쪽)로 변경(같이 배포). 로컬 DB에는 옛 bot17 close-pending 주문 11건이 있어(운영은 0건) 로컬 MM이 옛 가격대에 묶일 수 있다.

## 2026-09-24 — 모바일 UI 개편 (GCP 운영 적용)

- 폰(sm 미만) 하단 탭 `MobileTabBar`(홈·증권·뉴스·내역·이체), 상단 알약 메뉴 줄 제거. 새 증권 탭 `/market`(KABU 지수 카드 → `/market-index`, 전 종목 목록·정렬). 홈은 폰에서 종목표·뉴스 숨기고 보유 종목을 총자산 아래 목록으로.
- 거래 화면(lg 미만): 시세 카드 축소·이평선 편집 접기로 차트가 첫 화면에, 아래 내 주문/체결/뉴스 탭, 하단 고정 매도·매수 버튼 → `MobileOrderSheet`(위 호가창·아래 주문폼, `OrderForm initialSide`). `MobileSectionBar` 삭제. 판단은 `lib/media.ts`의 `useMediaQuery`.
- 운영: 웹 파일 14개만 교체(서버 소스가 이 변경 외 로컬과 동일함을 diff로 확인, md5 일치), 이미지 빌드 후 **web 컨테이너만** 재생성. 롤백 이미지 `mock-kabu2-app:pre-mobileui-20260924`, 원본 소스 서버 `/tmp/web-src-before-mobileui.tgz`. 운영 폰 화면에서 증권/뉴스 하단 탭 확인. 홈·거래 화면은 로그인 필요라 운영에서는 미확인(로컬에서 확인).
- 운영 접속: 사용자 PC `~/.ssh/config`의 `ssh mock-kabu`(사용자 `winyu-mock-kabu`, 영구 키, 만료 없음, passphrase는 Windows ssh-agent). Git Bash `ssh`가 아닌 `C:\Windows\System32\OpenSSH\ssh.exe`를 써야 agent를 쓴다.

## 2026-09-24 — KABU 매수 호가 소실 수정 (GCP 운영 적용)

- 증상: KABU 호가창 매수 쪽이 0~1단. 원인: 05:17 UTC API 재배포 재시작 순간 KABU 전용 MM(`Liquidity KABU`, bot17)이 SELL-first 재배치(113,900→114,500) 중이었고, 옛 매도 7건의 취소가 `fetch failed`로 실패했다. `retiring`에 들어간 주문은 취소를 다시 보내지 않아 재배치가 "옛 매도 종료 대기"에서 약 2시간 멈췄고, 그동안 매수 호가가 체결로 소진된 뒤 다시 걸리지 않았다(운영 로그·DB로 확인: MM 매수 0건, 05:16:58 매도 OPEN 잔존).
- 수정 `apps/bots/src/market-maker.ts`: reconcile 직후 `retryStaleRetiringCancels()`가 여전히 live인 retiring 주문의 취소를 2초 간격으로 재전송한다. 재배치가 30초 이상 멈추면 `staged relocation stalled` 경고 로그. 사고 재현 회귀 테스트 포함, 봇 테스트 79개 통과.
- 운영: 두 봇 파일만 교체, 이미지 재빌드 후 **bots 컨테이너만** 재생성(API/DB 재시작 없음). 롤백 이미지 `mock-kabu2-app:pre-mmfix-20260924`, 원본 파일 서버 `/tmp/*.orig-prod`. 재기동 후 KABU MM 매수·매도 각 12건, 5종목 모두 양측 10단, `/health/ready` 정상. 일회용 SSH 키는 메타데이터에서 제거·접속 거부 확인·로컬 파일 삭제.
- 주의: 이후 API를 재시작하는 배포에서도 이 수정으로 자동 복구되어야 한다. 확인은 `docker logs mock-kabu2-prod-bots-1 | grep -E "re-sent cancel|stalled"`.

## 2026-09-24 — 라이트 모드·지수 09:00 기준·이평선 종류 확장 (GCP 운영 적용)

- 라이트/다크 전환 버튼을 전역 내비게이션에 추가하고 브라우저에 선택을 저장한다. 화면 토큰과 캔들·지수·자산·리플레이 차트 축/격자가 전환에 맞춰 바뀐다. 운영 HTTPS에서 지수·종목 화면 양쪽 모드를 확인했다.
- `/market/index`는 조회 범위 직전의 종목 종가를 이어받아 지수 수준이 구간 시작에서 왜곡되지 않게 한다. KST 09:00 점은 그 시각 1분봉 시가로 계산하고, 지수 자체는 날짜별로 1,000에 재설정하지 않는다. 10분/1시간 조회에서도 해당 버킷의 첫 1분봉 시가를 사용하도록 수정해 1일·1주·전체의 09:00 값이 모두 **927.55**로 일치함을 운영 API와 화면에서 확인했다. 화면의 오늘 변화량·기준 대비·기준선은 해당 09:00 지수 수준을 사용한다. 페이지의 기존 지수 산식 설명 문구는 제거했다.
- 신규 브라우저의 기본 이평선은 5/10/20 SMA다. 추가 종류는 SMA/EMA/WMA/VWMA이며 기간 1~500, 최대 12개, 표시/삭제/색상 저장이 가능하다. 기존 사용자가 색상 등을 수정해 저장한 구성은 유지한다.
- 웹 타입체크·Next 프로덕션 빌드, API 타입체크, 웹 21개/API 110개 테스트 통과. GCP 배포 전 pgBackRest 차등 백업 `20260923-183013F_20260924-043909D` 성공, 기존 이미지는 `mock-kabu2-app:pre-theme-20260924`에 보존. 새 앱 이미지 배포 후 웹/API/Postgres/Redis 정상, `/health/ready`의 DB·Redis·매칭·정산 모두 up. `ops.sh review 5` 표본은 711건, p95 117.28ms, 5xx 0건이었다.

## 2026-09-24 — 랭킹 지수·차트 이평선·운영 지표·관리자 이체 (GCP 운영 적용)

- 랭킹의 지수 대비를 KABU 지수와 같은 `평균(종목 현재가/상장 기준가) ÷ 평균(기준 시점 종가/상장 기준가) − 1`로 변경했다. 응답에 `indexBase/indexCurrent`를 넣어 툴팁에서 지수 수준을 확인할 수 있다.
- 종목 차트의 SMA/VWMA를 기간 1~500, 최대 12개까지 추가·삭제·표시 전환하고 각 선의 색을 고를 수 있게 했다. 설정은 브라우저에 저장된다.
- `bash scripts/ops/ops.sh review 5`로 GCP 서버 CPU·메모리·디스크·컨테이너·소켓 동접·헬스·최근 HTTP 트래픽·NIC 속도를 한 번에 볼 수 있도록 기본 Compose 구성을 GCP로 맞췄다. OCI는 `MOCK_KABU_COMPOSE_OVERLAY` 지정이 필요하다.
- 관리자 DB 역할 마이그레이션, 랭킹 제외, 닉네임 선점 방지, 1시간 관리자 토큰, 로그인/이체 횟수 제한, 이체 시 비밀번호 재확인 구현. `ADMIN_PASSWORD`는 시드 환경 변수로만 받고 코드에 넣지 않는다. 관리자 신규 계좌 초기 현금은 기존대로 10^16원. 개별 투자자 검색·이체 및 전원 동일 금액 원자적 일괄 지급(요청 ID 멱등) 추가. 운영은 비관적 잠금 전략으로 일괄 지급 가능하다.
- Prisma 생성·스키마 검증, 웹 타입체크/프로덕션 빌드, API 타입체크/빌드/테스트 109개 통과. 사용자가 로컬 Docker 검증 대신 운영 적용을 요청했다.
- GCP `mock-kabu-prod`에 소스와 새 이미지를 배포했다. 배포 전 pgBackRest 차등 백업 `20260923-183013F_20260924-034755D` 성공, 기존 앱 이미지 `mock-kabu2-app:pre-admin-20260924` 보존. `20260924120000_add_admin_role`, `20260924121000_admin_distributions` 마이그레이션 적용, 시드 및 컨테이너 기동 완료. 운영 `ADMIN_PASSWORD`는 사용자가 지정한 값으로 0600 환경 파일에 저장했으며 문서·Git에는 남기지 않았다.
- 운영 HTTPS에서 `admin` 로그인·역할·초기 자산 정확히 10^16원·랭킹 제외·투자자 조회를 확인했다. 차트에 이평선 추가/삭제/색상 입력 UI 표시를 확인했고, 운영 원장 정합성 검사 전 항목 및 HTTPS 헤더/nonce/내부 API 차단 검사 통과. `sudo bash scripts/ops/ops.sh review 5`에서 소켓 동접·CPU/메모리·최근 HTTP 트래픽·NIC 속도·헬스 출력이 정상이다. 배포 중 재시작 구간이 포함된 5분 트래픽 표본에는 일시적 502가 8건 있었다.
- 재시작 이후 별도 1분 트래픽 표본은 41건 중 200/304만 있고 5xx는 0건이었다. 최종 외부 HTTPS `/health/ready`는 DB·Redis up, 대시보드와 KABU 종목 화면은 200이다. 배포에 사용한 30분 일회용 SSH 키는 GCP VM 메타데이터에서 제거했고 해당 키의 접속 실패를 확인한 뒤 로컬 개인/공개 키 파일도 삭제했다. 운영 접속 명령은 `docs/server-operations.md`의 GCP Cloud Shell 경로를 사용한다.

## 2026-09-24 — 운영 봇 체결 빈도 소폭 상향

- GCP 운영 1분봉 5종목을 최근 57분 확인한 결과, 비어 있는 분은 0개였다. 실제 봉 시가와 직전 종가의 차이는 종목별 26~34개 구간에 있었고, 최근 체결은 종목당 분당 약 20~38건이었다. 최우선 매수·매도 호가가 1~2틱 벌어져 매수·매도 체결이 번갈아 나오는 가격 갭이다.
- 봇의 호가 재배치 속도는 유지하고 `BOT_FLOW_DELAY_SCALE`을 운영에서 1.5→1.2로 낮춰 일반 시장가 흐름 대기시간을 20% 줄였다(이론상 시도 빈도 약 25% 증가). GCP 신규 환경 생성 스크립트, 운영 Compose 기본값, 예시 env에도 반영했다. 운영 봇 컨테이너 재생성 후 5개 전용 MM이 24개 호가씩 채택하고 흐름 봇이 실행되는 것을 확인했다. 이 설정은 가격 갭을 없애지는 않는다.
- 재시작 4분 후 `/health/ready` 정상, 5종목 모두 최근 봉 생성 및 양측 10단 호가 확인. 19:02~19:04 UTC 각 종목의 완료된 분당 체결 수는 대략 26~43건이었다. 루트 디스크 사용률 7%(135GiB 여유), 스토리지 가드 경고·위험·WAL 대기·백업 오류 0. 단기 관찰이므로 장기 디스크 증가율은 이후 표본으로 판단해야 한다.

## 2026-09-24 — Google Cloud 신규 배포 및 초기 검증 완료

- 사용자가 Oracle 접근 불가를 확인하고 기존 데이터 이전을 포기해 **새 DB로 재배포**했다. 기존 계정·거래 기록은 새 서버에 없다. Cloudflare의 `jobradar.my` A 레코드를 고정 IP `34.158.205.10`으로 전환했고, HTTPS 인증서·HTTP→HTTPS 이동·홈페이지/API 200을 외부에서 확인했다.
- GCP 프로젝트 `gen-lang-client-0924937280` (`COMMUTE`), 서울 `asia-northeast3-a`의 `mock-kabu-prod`: e2-standard-2(2 vCPU/8GB), Ubuntu 24.04 LTS, 150GB pd-balanced, 일일 스냅샷 정책 `default-schedule-1` 연결, 보안 부트/vTPM/무결성 모니터링, 삭제 보호, 서비스 계정 없음. 생성 화면 VM+디스크 월 추정 US$82.25(IPv4·스냅샷·송신료 별도). 무료 체험 크레딧 잔액 ₩435,523, 만료 2026-10-30을 확인했다.
- `/opt/mock-kabu2`에 Docker·Compose 스택을 배포하고 새 운영 비밀값을 `/opt/mock-kabu2/deploy/production/.env.production`에 생성했다(0600). PostgreSQL/Redis/API/웹/매칭/정산/봇/Caddy 기동, pgBackRest 초기 전체 백업 성공. 6시간 백업, 1분 디스크 가드, 매일 04:10~04:20 KST 거래 점검·이력/빌드 캐시 정리 타이머 활성. 일일 스냅샷 정책이 부트 디스크에 붙어 있음을 CLI로 확인했다.
- 외부 HTTPS `/health/ready`는 DB·Redis·매칭·정산 모두 up, 홈페이지/종목 API 200. Chrome 거래 화면에서 현재가·호가·체결의 실시간 갱신 확인, 브라우저 경고/오류 없음. DB 정합성 전 항목 통과, CSP nonce/보안 헤더/내부 API 차단 검사 통과. 빌드 캐시 수동 정리 후 루트 디스크 145GiB 중 8.3GiB 사용(6%), 137GiB 여유. 스토리지 가드 경고·위험·WAL 적체·백업 오류 없음.
- `www.jobradar.my`는 별도 프록시 A 레코드가 오래된 `20.194.25.57`을 가리켜 요청이 타임아웃된다. 자동 승인 검토가 이 별도 호스트의 DNS 변경을 거절했으므로 기록은 그대로이고, 변경 초안은 취소했다. 별도 사용자 승인이 필요하다.
- 웹 `api.ts`에 인증된 요청이 401을 받으면 해당 세션을 지우고 로그인 화면으로 이동하는 처리를 추가했다. 로컬 타입 검사와 운영 이미지 재빌드가 통과했고 웹 컨테이너를 교체해 healthy 상태를 확인했다. 교체 후 브라우저 거래 화면에서 계정 잔액·실시간 호가·체결이 표시되고 콘솔 경고/오류가 없었다.
- 03:30 KST 예약 전체 백업 `20260923-183013F` 성공(pgBackRest stanza `ok`). 마지막 빌드 뒤 캐시 정리 성공, 루트 디스크 145GiB 중 9.7GiB 사용(7%). 스토리지 가드에는 경고·위험·WAL 대기·백업 실패가 없다. 현재 가드 표본 28개로 24시간 증가율은 아직 산출할 수 없다.

## 2026-09-24 — 매일 거래 점검 (배포 대기)

- 로컬에 매일 04:10~04:20 KST 주문 제한(일반·조건부·취소·정정), 종목 화면 점검 안내, 봇 정지/재개 systemd 타이머, 04:11 이력 정리·04:12 Docker 캐시 정리 예약을 구현했다. 스토리지 가드가 봇을 정지한 상태라면 점검 종료가 재시작하지 않는다. 상세 `docs/daily-maintenance.md`.
- API 테스트 101개와 웹 프로덕션 빌드 통과. **운영 배포는 아직 안 됨**: 9/24 01:15 KST부터 `129.225.135.95` SSH와 `jobradar.my` HTTPS가 모두 타임아웃. 사용자에게 OCI 콘솔 로그인을 요청했다. 마지막 접속 시(9/23 22:23 KST) 96G 루트 중 31G 사용/66G 여유(32%), 8개 컨테이너 동작. 운영 서버에 롤백용 `/tmp/mock-kabu-before-maintenance-20260923.tar`만 생성됨. 로컬 배포 묶음은 `tmp/maintenance-deploy.tar`이나 최신 스토리지 추세 스크립트를 추가해 재생성 필요.
- 10분 거래 중단 자체는 하루 쓰기의 약 0.7%만 줄인다. 하루 한 번의 정리로 충분한지 판단하려면 운영 `storage-guard`의 24시간 이상 표본에서 순증가량과 정리 후 최저 사용량을 비교해야 한다. `scripts/ops/storage-trend.py`를 준비했으나 서버 연결 불가로 실제 값을 아직 측정하지 못했다.

다른 AI 모델/세션이 이 프로젝트 작업을 이어받기 위한 문서. 프로젝트 개요·실행법은 [README.md](README.md), 원 기획은 `docs/superpowers/specs/2026-07-11-virtual-exchange-design.md` 참고.

## 2026-09-23 — 장기 디스크 증가 억제

- 운영 45GB 디스크에서 주문 약 292만 건, 매칭 멱등 claim 약 559만 건이 누적됐다. 최근 10분 봇 주문 약 5,906건 중 약 90%가 전용 유동성 봇이었다. 한 틱 재배치 때 작은 수량 차이까지 새 주문으로 바꾸는 것이 WAL·DB 증가의 주요 원인이었다.
- `apps/bots/src/market-maker.ts`: 일반 호가 이동 기본 간격 750ms→5초, 운영 Compose에서 15초로 설정. 일반 재배치의 작은 수량 초과(25% 이내)는 기존 주문을 재사용하고, 보존 중인 부분 체결이 있는 쪽은 엄격히 보정한다. 체결 후 빈 호가 보충과 6틱 이상 급변 대응은 빠른 경로를 유지한다. 운영 관찰은 분당 약 1,000건대→7분 평균 약 226건(시장 상황이 달라 정확한 배율 보장은 아님). 봇 테스트 77개, 타입 검사, 운영 전체 이미지 빌드·거래 정합성 통과.
- `account.processed_events`에는 체결 claim 외에 `order.closed` claim이 계속 누적되는 것도 확인했다. `prune-history`가 30일 지난 비체결 claim만 정리하고 체결 행에 연결된 claim은 보존한다. `processed_at` 인덱스 마이그레이션 `20260923210000_index_processed_event_age` 운영 적용, dry-run 및 systemd 실제 실행 성공(현재 만료 대상 0). 정리 타이머는 매일 04:10 KST로 변경했다.
- 미사용 Docker 빌드 캐시(2GB 보존)와 태그 없는 이미지 정리 타이머를 매일 02:30 KST에 추가·운영 활성화했다. 최종 빌드 뒤 캐시 정리, 약 67% 사용/15GB 여유, WAL 보관 대기 0, 백업 오류 없음. 기존 앱 이미지 `mock-kabu2-app:pre-storage-churn-20260923`은 롤백용으로 보존했다. 30일 지난 기록이 아직 없어 실제 삭제 경로는 미검증이며 이후 타이머 로그 확인이 필요하다.

## 2026-09-23 — 배포 후 보안 점검

- 운영 Next.js `15.5.20` 등 의존성 취약점 확인 후 Next.js `15.5.24`와 관련 하위 의존성 수정 버전으로 업데이트했다. `pnpm build`, `pnpm test`, `pnpm audit --prod --audit-level low` 통과(알려진 취약점 0건). 운영 이미지 빌드 및 웹·API·정산·매칭·봇 순차 교체 완료. 홈페이지·거래 헬스·보안 헤더·거래 원장 정합성 통과. 기존 이미지 `mock-kabu2-app:pre-security-20260923` 보존. 상세 `docs/incidents/2026-09-23-security-audit.md`.
- 운영 HTTPS 헤더·내부 API 차단 통과, DB/Redis 공개 포트 없음. SSH 비밀번호 로그인은 이미 꺼져 있었고, 9/23 root SSH 로그인·X11 포워딩도 해제했다. `ubuntu` 공개키 재접속·sudo 확인, Ubuntu `sudo` 보안 패치 적용. 외부 SSH 탐색은 계속 관찰한다.
- 디스크 증가 경고에 대응해 추가 차등 백업을 성공시켜 사용률 65%에서 44%로 낮춘 뒤 배포했다. 이후 약 55%/여유 20GB. OCI 게시 IAM 정책과 서버 알림 설정은 활성이고 테스트 발행·Gmail 수신을 모두 확인했다.

## 2026-09-23 — 예방 보호 장치

- `scripts/ops/storage-guard.py`, 1분 systemd timer 운영 반영. 48시간 bounded 측정값, 디스크/inode/WAL 적체/백업 노후 점검. 위험 시 봇만 중지하고 수동 해제까지 유지한다. 사용자 주문 쓰기는 계속 가능하므로 고갈 방지의 절대 보장은 아니다.
- 백업 실패 시 15분 재시도, 2시간 최대 3회. 테스트 6개 및 운영 실제 수집/서비스 실행 통과.
- 02:00 KST 디스크 41%/여유 27GB, DB 1.73GB, WAL 대기 0, 백업 오류 없음.
- OCI Notifications `mock-kabu-storage-alerts` 토픽을 전용 `mock-kabu-alerting` 컴파트먼트에 생성·이동하고 `stomailce0206@gmail.com` 구독 활성 확인. 운영 서버에 OCI SDK와 `storage-notify.py`를 배포했다. 단일 인스턴스 `ONS_TOPIC_PUBLISH` 정책과 `/etc/mock-kabu/notifications.json`이 활성이다. 테스트 발행·메일 수신 확인 완료. 외부 Object Storage 백업은 미구성. 상세 `docs/storage-guard.md`.

## 2026-09-22 — jobradar.my 디스크 고갈 복구

- 운영 45GB 루트 디스크 100%: 미사용 빌드 캐시 14.47GB + pgBackRest 설정 오류로 미보관 WAL 약 19GB 누적. PostgreSQL 재시작 반복으로 거래 중단.
- 캐시만 정리하고 DB/Redis 데이터는 보존했다. OCI의 빈 S3 환경 변수 제거 wrapper + `PGBACKREST_PG1_USER` 설정, stanza 초기화로 아카이브를 복구했다. wrapper 실행 권한 및 LF 유지 필요.
- 사용자가 승인한 정책: 매일 03:30 KST full, 09:30/15:30/21:30 diff. 로컬 full 2개/diff 6개, WAL은 최신 diff부터 유지(과거 PITR 범위 제한). 백업 실행 OS 사용자는 postgres.
- 배포 bootstrap은 DB healthy/stanza 확인 및 빌드 캐시 2GB 보존 정리를 수행한다. 기존 `/opt/mock-kabu2`는 git 저장소가 아니므로 실제 변경은 scp로 반영했다.
- 외부 HTTPS 200, 거래 health 전체 up, 정합성 검사 전체 통과. 실시간 2연결×10초에 296 메시지/연결·HTTP 오류 0. 브라우저 차트·호가·체결 갱신 확인.
- 상세: `docs/incidents/2026-09-22-disk-full.md`. 로컬 백업은 물리 디스크 장애를 보호하지 않으므로 장기 운영은 별도 저장소·용량 관찰이 필요하다.
- 최종 23:57 KST: 디스크 31%/여유 31GB, 전체 백업 `20260922-145613F` 성공(DB 1.3GB → 암호화·압축 411.8MB), pgBackRest check/status 정상. 다음 자동 백업 9/23 03:30 KST.

## 2026-09-22 — 운영 CLI·보안 헤더 실제 배포

- `docs/server-operations.md`: SSH 접속 후 `bash scripts/ops/ops.sh status|users|health|traffic|network|watch|security|load` 사용. load는 URL/인원/초를 받고 시세 HTTP+Socket.IO만 생성, 주문 쓰기 없음. 최대 동접 측정은 별도 머신에서 단계적으로 실행한다.
- API `/internal/operations`: 실제 loopback peer만 허용(Caddy public 404), 현재 소켓/인증 소켓/고유 인증 계정/프로세스 메모리. 사람 수와 탭 수를 혼동하지 말 것. Caddy JSON access log 집계는 최근 최대 100,000줄, WebSocket 프레임 제외.
- 웹 middleware CSP nonce + root `force-dynamic` + no-store(정적 HTML 캐시 제거), Next X-Powered-By off. Caddy Permissions-Policy/COOP/CORP 및 식별 헤더 제거, API 제한 CSP. 외부 폰트 때문에 style/font 출처 유지, script unsafe-inline/unsafe-eval 없음. COEP는 보고서의 향후 권고이지 확정 취약점이 아니므로 강제하지 않았다.
- 실제 `/opt/mock-kabu2`에 해당 파일만 전송 후 전체 8개 패키지 Docker build 통과, gateway/operations 6개 테스트 통과, api/web만 재생성, Caddy 재시작. DB migration/seed/주문 작업 없음. 이전 이미지 `mock-kabu2-app:before-ops`, 원본 설정 백업 `/tmp/mock-kabu-before-ops.tar.gz` 유지. 이미지 태그를 이전 것으로 지정해 api/web 재생성하고 Caddyfile 원본 복원/재시작하면 롤백 가능.
- 검증: 홈페이지 2회·거래·주문 페이지 CSP/nonce 일치 및 재사용 없음, 운영 API 외부 404, health 전부 up. 5연결×30초: 모든 연결 메시지 수신, 2,291 메시지, HTTP 31건/오류 0, p95 23ms(서버 자체 생성기이며 용량 보장 아님). 브라우저 거래 화면 차트/호가 렌더와 콘솔 오류 없음 확인.

## 프로젝트 개요

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

## 2026-09-22 — 낙폭 제거·모바일·뉴스 다양화 (최신 작업)

- 뉴스: `MacroChannel`에 `COMMODITY` 추가(회사 프로필 베타: SAKU −0.55, MOCK −0.4, KABU 0.2, NEKO 0.5, TANU 0.95), vocab `commodity`/`centralBank`/`region`. 템플릿 160종(매크로 43, 종목 84, 후속 17). 매크로 풀은 상승/하락 방향 수 차이 ≤2 테스트가 있으니 추가할 때 짝을 맞출 것. 후속 보도 테스트는 첫 후속이 나올 때까지(최대 하루) 돌리도록 바꿈.
- 모바일: `.tbl td`가 `white-space: nowrap`(표는 `overflow-x-auto` 래퍼 안에서 가로 스크롤), 640px 이하에서 표 간격·글자 축소, `.field` 16px. `MobileSectionBar`(거래 페이지 하단 고정, `lg:hidden`, 섹션 id `chart/orderbook/order/trades` + `scroll-mt-28`). 폰 확인은 헤드리스 크롬+CDP 스크립트로 했다(로컬 Chrome 창은 최대화라 resize가 안 먹음) — 필요하면 `Emulation.setDeviceMetricsOverride` 390×844로 다시 찍으면 된다.

## 2026-09-22 — 사용자 피드백 6건

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
