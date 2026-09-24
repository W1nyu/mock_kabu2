# 배포 서버 운영 명령

Google Cloud Shell에서 운영 서버 접속:

```bash
gcloud compute ssh mock-kabu-prod --zone=asia-northeast3-a --project=gen-lang-client-0924937280
```

이 스크립트는 현재 GCP Compose 구성을 기본으로 사용한다. OCI 환경에서는 `MOCK_KABU_COMPOSE_OVERLAY=deploy/oci/compose.oci.yml`을 지정한다.

서버에서 `cd /opt/mock-kabu2` 후 실행한다. 운영 계정에 Docker 권한이 없으면 아래처럼 `sudo`를 사용한다. 별도 공개 모니터링 포트나 비밀번호는 없다.

```bash
sudo bash scripts/ops/ops.sh review 5    # 아래 핵심 지표를 한 번에 조회(최근 5분 트래픽)

sudo bash scripts/ops/ops.sh status       # CPU, RAM, swap, 디스크, 컨테이너 상태/자원
sudo bash scripts/ops/ops.sh users        # 현재 소켓, 인증 소켓, 고유 로그인 계정 수
sudo bash scripts/ops/ops.sh health       # DB/Redis/매칭/정산 상태
sudo bash scripts/ops/ops.sh traffic 5    # 최근 5분 HTTP 요청량/상태 코드/p50/p95/응답 바이트
sudo bash scripts/ops/ops.sh network      # NIC 누적 바이트와 2초간 송수신 속도
sudo bash scripts/ops/ops.sh security     # 실제 HTTPS 헤더/nonce/운영 API 외부 차단 검사
sudo bash scripts/ops/ops.sh watch        # 5초마다 접속/자원 관찰, Ctrl+C 종료
```

`users`는 현재 API 프로세스의 소켓 수다. 여러 탭은 여러 연결이며 익명 사용자는 사람별 구분이 불가능하다. 고유 인증 계정은 연결 시 JWT 인증 기준이다. HTTP만 사용하거나 실시간 연결을 열지 않은 방문자는 포함되지 않는다. 봇은 주로 HTTP 주문이므로 소켓 동접 수로 봇 부하를 판단하지 않는다.

`traffic`은 Docker에 보존된 Caddy JSON 로그 중 최대 100,000줄을 집계한다(기본 로테이션 10MB × 3). 재시작/회전 직후에는 지정 구간의 일부만 남을 수 있다. IP 수는 동접자 수가 아니다. WebSocket 프레임 트래픽은 HTTP 로그에 없으므로 `network`와 함께 본다. NIC 수치는 SSH 등 다른 트래픽도 포함한다. 원본 로그에는 IP/URL이 있으므로 외부 공유를 피한다.

## 읽기 전용 부하 테스트

```bash
sudo bash scripts/ops/ops.sh load https://jobradar.my 5 30
# 한 단계씩 실행하고 다른 SSH 창에서 watch/health/network를 함께 관찰
sudo bash scripts/ops/ops.sh load https://jobradar.my 20 60
sudo bash scripts/ops/ops.sh load https://jobradar.my 50 60
sudo bash scripts/ops/ops.sh load https://jobradar.my 100 60
```

각 가상 사용자는 Socket.IO로 한 종목 호가·체결을 구독하고 5초마다 `/market/symbols`를 조회한다. 인원 1~500, 시간 5~600초로 제한한다. 가입/로그인/주문/취소/DB 쓰기는 하지 않는다. 연결 실패, HTTP 오류, 실시간 메시지를 받지 못한 사용자가 있으면 종료 코드 1을 반환한다. Ctrl+C로 종료한다.

오류 발생, p95가 목표(예: 500ms)를 초과, 매칭/정산 health 실패, 지속적인 CPU 포화나 swap 증가가 있으면 단계를 높이지 않는다. 이 시나리오의 성공 인원을 주문 가능한 최대 동접 수로 해석하지 않는다. 주문 시나리오는 별도 시험 DB/전용 계정/정합성 검사로 설계해야 한다.

서버 자체에서 부하를 만들면 생성기도 CPU와 네트워크를 사용한다. 정확한 용량 시험은 별도 머신의 동일 저장소에서 의존성 설치 후 실행한다:

```bash
LOAD_WEB_PACKAGE="$PWD/apps/web/package.json" node scripts/ops/load.mjs https://jobradar.my 100 60
```

## 보안 진단 대응

2026-09-22 PDF의 누락 항목은 CSP와 Permissions-Policy, 정보 노출 항목은 X-Powered-By였다.

- Next.js 요청마다 새로운 nonce로 inline script를 허용하며 HTML은 동적으로 렌더하고 저장하지 않는다. 운영 스크립트에 unsafe-inline/unsafe-eval을 허용하지 않는다. 차트/React 스타일 속성만 unsafe-inline을 허용한다.
- 폰트 CDN과 같은 출처 API/WebSocket만 필요한 범위로 허용한다. 기존 폰트 외부 요청을 위해 스타일/폰트 출처를 명시한다.
- Caddy가 카메라·마이크·위치·결제·USB 권한을 차단하고 서버/Next.js 식별 헤더를 제거한다. API 응답에도 제한적 CSP를 설정한다.
- COOP/CORP는 same-origin이다. 보고서의 Upcoming Headers는 모두 확정 취약점을 의미하지 않는다. COEP는 외부 폰트 리소스의 CORS/CORP 호환성에 영향을 주며 이 서비스에 교차 출처 격리 요구가 없어 강제하지 않는다.
- `/internal/operations`는 Caddy에서 404, API에서도 실제 TCP peer가 loopback인 경우만 허용한다. X-Forwarded-For를 신뢰하지 않는다.

참고: https://nextjs.org/docs/15/app/guides/content-security-policy 및 https://caddyserver.com/docs/caddyfile/directives/log

헤더 스캔 수정은 전체 서비스의 취약점 부재를 보장하는 종합 침투 테스트가 아니다. nonce로 정적 HTML 캐시를 없앴으므로 웹 페이지 SSR 비용도 용량 시험에 별도로 포함해야 한다.
