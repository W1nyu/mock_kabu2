# Google Cloud Compute Engine 배포

대상 프로젝트: `gen-lang-client-0924937280` (`COMMUTE`). 기존 Oracle 서버에 접근할 수 없어 새 데이터베이스로 시작한다. 기존 계정·거래 기록은 새 배포에 포함되지 않는다.

## 기본 사양

- 리전/영역: `asia-northeast3` / `asia-northeast3-a` (서울)
- VM: `e2-standard-2`, 2 vCPU / 8 GiB RAM, Ubuntu 24.04 LTS, 일반 인스턴스(Spot 사용 안 함)
- 부팅 디스크: 150 GiB `pd-balanced`, 삭제 방지 사용
- 고정 외부 IPv4: DNS 전환 뒤에도 주소가 유지되도록 VM에 연결
- 네트워크: 80/443/TCP 공개. 현재 기본 VPC의 22/TCP 허용 규칙은 모든 IPv4에서 접속 가능하며 SSH 키 인증을 사용한다. DB/Redis 포트는 공개하지 않음

Compute Engine 생성 화면의 VM+디스크 월 추정액은 생성 당시 US$82.25였다. IPv4, 스냅샷, 인터넷 송신 트래픽은 별도 과금될 수 있다. 무료 체험 크레딧은 만료 전에도 소진될 수 있으므로 결제 예산 알림을 설정한다.

## 현재 운영 상태 (2026-09-24)

동접 소켓, HTTP 트래픽, 서버 자원은 서버에서 `bash scripts/ops/ops.sh users`, `traffic 5`, `status`로 조회한다. 전체 명령과 수치의 범위는 [운영 명령](../../docs/server-operations.md)에 정리했다.

- `https://jobradar.my`가 `mock-kabu-prod`의 고정 IP `34.158.205.10`을 가리킨다. HTTPS, API 헬스, 실시간 호가·체결, 원장 정합성 검증을 통과했다. 인증 401 시 세션 초기화 처리까지 웹에 반영했다.
- `www.jobradar.my`는 별도 DNS 레코드가 이전 주소를 가리킨다. 별도 호스트 변경 승인을 받기 전에는 수정하지 않는다.
- 운영 환경 파일은 VM의 `/opt/mock-kabu2/deploy/production/.env.production`에만 있다. 관리자 로그인 닉네임은 `admin`이고, 비밀번호는 이 파일의 `ADMIN_PASSWORD`를 사용한다. 비밀번호를 Git이나 문서에 복사하지 않는다.
- pgBackRest 백업은 같은 VM 디스크에 있고, 부팅 디스크에는 일일 GCP 스냅샷 정책 `default-schedule-1`이 연결돼 있다. 2026-09-24 03:30 KST 예약 전체 백업이 성공했다.
- 1분 간격 스토리지 가드와 매일 04:10~04:20 KST 점검·정리 타이머가 켜져 있다. 하루 정리만으로 충분한지는 최소 24시간의 운영 샘플로 판단한다: `sudo python3 /opt/mock-kabu2/scripts/ops/storage-trend.py`.

## VM 준비

1. `python deploy/gcp/scripts/package-source.py`로 만든 `tmp/gcp-deploy.tar`를 새 Ubuntu VM의 `/opt/mock-kabu2`에 풀어 소스를 복사한다. `.env`, `node_modules`, `.git`, `tmp`, 개인 키는 묶음에 들어가지 않는다.
2. `sudo bash /opt/mock-kabu2/deploy/gcp/scripts/install-vm.sh`를 실행한다. Docker 그룹 권한을 적용하려면 SSH로 다시 접속한다.
3. `bash deploy/gcp/scripts/create-env.sh <GCP_STATIC_IP>`로 `/opt/mock-kabu2/deploy/production/.env.production`을 만든다. 독립적인 비밀값과 관리자 비밀번호가 생성되며 파일 권한은 `600`이다. 안전한 장소에 복사해 보관한다.
4. 생성된 환경 파일은 DNS 전 검증용 `APP_DOMAIN=localhost`, `APP_ORIGIN=http://<GCP_STATIC_IP>`, `CADDYFILE=../gcp/Caddyfile.http`를 사용한다. 운영 전환 때 `APP_DOMAIN=jobradar.my`, `APP_ORIGIN=https://jobradar.my`, `CADDYFILE=../production/Caddyfile`로 바꾸고 이미지를 재빌드한다.
5. `bash deploy/gcp/scripts/deploy.sh prepare`로 이미지를 빌드하고 PostgreSQL·Redis를 기동한다. 그다음 `bash deploy/gcp/scripts/deploy.sh start`로 migration, seed, 앱을 기동한다.

관리자 비밀번호를 지정하거나 교체할 때는 서버의 0600 환경 파일에서 `ADMIN_PASSWORD`를 수정하고 `bash deploy/gcp/scripts/deploy.sh start`를 다시 실행한다. 시드가 bcrypt 해시를 갱신하며 관리자 초기 자산은 계좌 생성 시 10^16원이다. 시드를 다시 실행해도 이미 사용 중인 계좌 잔액을 초기화하지 않는다. 관리자 로그인은 1시간 토큰, 계정별 로그인 제한, 이체 시 비밀번호 재확인을 사용한다.

## 검증 및 도메인 전환

1. `MOCK_KABU_COMPOSE_OVERLAY=deploy/gcp/compose.gcp.yml bash scripts/ops/ops.sh health`로 헬스 상태를 확인하고 HTTP/Socket.IO 실시간 흐름을 GCP IP에서 확인한다. 관리자 로그인도 확인한다.
2. GCP 방화벽 80/443을 열고 Cloudflare의 `jobradar.my` A 레코드를 GCP 고정 IP로 변경한다. HTTPS 인증서 발급 후 로그인·주문·시세를 다시 검증한다.
3. `sudo bash deploy/gcp/scripts/deploy.sh timers`로 6시간 백업, 1분 스토리지 가드, 매일 04:10~04:20 KST 점검/정리를 등록한다. 별도 디스크 스냅샷 또는 Cloud Storage 백업을 구성해 VM 디스크 장애도 대비한다.
