# Oracle Cloud Always Free 배포 가이드

무료 범위 안에서 mock-kabu2 전체(웹·API·매칭·정산·봇·PostgreSQL·Redis·Caddy)를 **Ampere A1 VM 한 대**에
올리고, 선택적으로 **Autonomous Database(Oracle DB, 20GB 무료)** 를 장기 보관·분석 저장소로 붙이는
절차다. 로컬 `docker-compose.yml`은 개발용이고, 여기서는 `deploy/production/compose.production.yml`에
`deploy/oci/compose.oci.yml`을 겹쳐 쓴다.

## 무엇이 무료 범위에 맞는가

| Always Free 자원 | 이 프로젝트가 쓰는 방식 |
|---|---|
| Ampere A1.Flex 합계 4 OCPU / 24GB | VM 1대(권장 4/24, 최소 2/12)에 컨테이너 8개. 한도 합계 ≈ 4GB, 평상시 사용 ≈ 1.5GB |
| 블록 스토리지 200GB | 부트 볼륨 100GB. DB는 보존 정책(매일 `prune-history`)으로 오래된 봇 이력을 정리한다 |
| Object Storage 20GB | pgBackRest 백업 저장소(S3 호환 API) — 선택 |
| Autonomous Database 2개 × 20GB | **주 DB로는 쓰지 않는다**(아래 "왜") — 아카이브·분석 스키마로 사용 — 선택 |
| 아웃바운드 10TB/월 | 무의미할 만큼 넉넉 |

### 왜 Oracle DB를 주 DB로 쓰지 않나
앱은 Prisma + PostgreSQL 전용 SQL(`SELECT … FOR UPDATE` 락 전략, `DISTINCT ON`, `FILTER`, `ON CONFLICT`,
`LATERAL`, 스키마 5개) 위에 있고, Prisma에는 Oracle 커넥터가 없다. 주 DB 교체는 데이터 계층 재작성이라
범위 밖이다. 대신 무료 ADB에 **드라이버 없이(ORDS REST SQL)** 봉·체결·실현손익·자산 스냅샷을 밀어 넣어
PostgreSQL 쪽 보존 정책과 무관하게 오래 보관하고, Database Actions의 SQL로 분석한다.

## 1. 계정·CLI 준비
1. Oracle Cloud 가입(홈 리전은 바꿀 수 없다 — 춘천 `ap-chuncheon-1` 또는 서울 `ap-seoul-1`). Always Free 자원은 홈 리전에서만 만들어진다.
2. 콘솔 > 프로필 > API 키 추가 → 설정 스니펫의 `tenancy_ocid`, `user_ocid`, `fingerprint`, 키 파일 경로를 `terraform/terraform.tfvars`에 넣는다(`terraform.tfvars.example` 복사).
3. Terraform ≥ 1.5 설치.

## 2. VM 만들기 (Terraform)
```bash
cd deploy/oci/terraform
cp terraform.tfvars.example terraform.tfvars   # OCID·SSH 공개키·repo_url·(선택) app_domain
terraform init
terraform apply
terraform output
```
- **"Out of host capacity"** 가 나면 A1 용량이 없는 것이다. 30분~몇 시간 간격으로 `terraform apply`를
  다시 하거나, `ocpus=2 memory_gb=12`로 줄여 잡은 뒤 콘솔에서 늘린다. 유료 업그레이드(PAYG 전환, 과금 없음)를
  하면 용량 우선순위가 올라간다는 보고가 많다.
- cloud-init이 Docker·compose 플러그인 설치, iptables 80/443 개방, 4GB 스왑, 저장소 clone(`/opt/mock-kabu2`)까지
  한다. 진행 상황은 `ssh ubuntu@IP` 후 `tail -f /var/log/cloud-init-output.log`.
- 보안 목록은 22(운영자 IP 권장)·80·443만 연다. DB·Redis는 Docker 내부 네트워크에만 있다.
- 인스턴스에는 `prevent_destroy`가 걸려 있다(A1 용량을 잃지 않게). 정말 지우려면 `main.tf`의 lifecycle 블록을 지운 뒤 `terraform destroy`.

## 3. 앱 기동
```bash
ssh ubuntu@<public_ip>
/opt/mock-kabu2/deploy/oci/scripts/bootstrap.sh      # 1회: .env.production 생성(비밀값 자동 채움)
nano /opt/mock-kabu2/deploy/production/.env.production
#   ADMIN_EMAIL, CADDY_EMAIL 확인. 도메인이 있으면 APP_DOMAIN / APP_ORIGIN=https://도메인 / CADDYFILE=../production/Caddyfile
#   없으면 자동으로 APP_DOMAIN=localhost(자리표시자), APP_ORIGIN=http://공인IP, CADDYFILE=../oci/Caddyfile.http (HTTP 전용)
/opt/mock-kabu2/deploy/oci/scripts/bootstrap.sh      # 빌드(A1에서 5~10분) → 기동 → 타이머 등록
```
- 처음 `ubuntu` 공개키 접속을 확인한 뒤 SSH를 축소할 수 있다. `deploy/oci/sshd-hardening.conf`는 root SSH 로그인과 X11 포워딩을 끈다. 적용 전 현재 SSH 세션을 유지하고, 구문 검사 후 reload한 다음 새 터미널에서 `ubuntu` 재접속을 확인한다.
  ```bash
  sudo install -m 0644 /opt/mock-kabu2/deploy/oci/sshd-hardening.conf /etc/ssh/sshd_config.d/99-mock-kabu-hardening.conf
  sudo /usr/sbin/sshd -t && sudo systemctl reload ssh
  sudo /usr/sbin/sshd -T | grep -E '^(permitrootlogin|x11forwarding|passwordauthentication) '
  ```
- 도메인을 쓰면 A 레코드를 공인 IP로 가리키고 80/443이 열려 있으면 Caddy가 Let's Encrypt 인증서를 받는다.
  IP만 쓰는 HTTP 모드에서는 브라우저 시스템 알림(Notification API)이 동작하지 않는다.
- 업데이트: `bootstrap.sh --update` (git pull → 빌드 → migrate → 재기동).
- 확인: `curl -s http://localhost/health/trading`, 브라우저에서 `APP_ORIGIN`.

### 등록되는 systemd 타이머
| 타이머 | 주기 | 하는 일 |
|---|---|---|
| `mock-kabu-backup` | 03:30·09:30·15:30·21:30 KST | 03:30 full, 나머지 diff — 로컬 볼륨 또는 Object Storage |
| `mock-kabu-maintenance-start/end` | 매일 04:10/04:20 KST | 새 주문 차단 시간 동안 봇 정지/재개. 디스크 보호 장치가 작동 중이면 재개하지 않음 |
| `mock-kabu-prune` | 매일 04:11 KST | 오래된 봇 이력·주문 종료 정산 claim 정리 후 `consistency` |
| `mock-kabu-build-cache-prune` | 매일 04:12 KST | 사용하지 않는 빌드 캐시를 2GB만 남기고 정리, 태그 없는 미사용 이미지 정리 |
| `mock-kabu-oracle-sync` | 매시 | ADB 동기화 (`.env`에 `ORACLE_ORDS_URL`이 있을 때만 활성) |

`systemctl list-timers 'mock-kabu-*'`, 로그는 `journalctl -u mock-kabu-prune`.

로컬 저장소는 full 2개·diff 6개를 보관하며 연속 복구 WAL은 최신 diff부터 유지한다.
이전 백업 자체의 시점 복원은 가능하지만 그 사이 임의 시점 복구는 보장하지 않는다.
배포는 stanza 초기화를 확인하고 빌드 캐시를 2GB만 남긴다.
디스크 고갈 복구 및 원인: [장애 기록](../../docs/incidents/2026-09-22-disk-full.md).

## 4. 백업을 Object Storage로 (선택)
1. 콘솔 > Object Storage > 버킷 `mock-kabu2-backup` 생성(Private).
2. 프로필 > 고객 비밀 키(Customer Secret Keys) 생성 → Access/Secret.
3. `deploy/oci/pgbackrest.s3.conf`의 `REPLACE_NAMESPACE`(버킷 정보의 네임스페이스)와 리전을 채운다.
4. `.env.production`에 `OCI_S3_ACCESS_KEY`, `OCI_S3_SECRET_KEY`, `PGBACKREST_CONF=../oci/pgbackrest.s3.conf` 를 넣고
   `bootstrap.sh --update`. 첫 백업: `docker compose … exec -u postgres postgres pgbackrest --stanza=mock-kabu stanza-create` 후
   `… --type=full backup`.

## 5. Autonomous Database 아카이브 (선택)
1. 콘솔 > Oracle Database > Autonomous Database > 생성: **Always Free**, 워크로드 Transaction Processing(ATP),
   네트워크 접근 "Secure access from everywhere" + **mTLS 필수 해제**(TLS만) — ORDS는 HTTPS라 지갑이 필요 없다.
2. Database Actions > SQL(ADMIN)에서 `deploy/oci/oracle/schema.sql` **1부** 실행(사용자 `MOCKKABU` 생성 + `ORDS.ENABLE_SCHEMA`).
3. `MOCKKABU`로 로그인해 **2부**(테이블·뷰) 실행.
4. ORDS URL = `https://<adb-host>/ords/mockkabu` (Database Actions 주소의 `/ords/` 앞부분 + `/mockkabu`).
5. `.env.production`:
   ```
   ORACLE_ORDS_URL=https://xxxx-mockkabu.adb.ap-chuncheon-1.oraclecloudapps.com/ords/mockkabu
   ORACLE_DB_USER=MOCKKABU
   ORACLE_DB_PASSWORD=...
   ```
   `bootstrap.sh --update` 하면 타이머가 켜진다. 수동: `docker compose … run --rm api oracle-sync --dry-run`.
6. 무엇이 가나: 계정 디렉터리(닉네임·가입일), 1분 봉 전체, **사용자 계정이 낀 체결**, 사용자 실현손익, 자산 스냅샷(1분 원본).
   MERGE라 다시 돌려도 중복이 없고, 스트림별 워터마크(`mk_sync_state`)로 증분 전송한다. 한 번에 최대
   `ORACLE_SYNC_MAX_ROWS`(기본 20,000)행. 비밀번호 해시·원장·주문은 보내지 않는다.
7. 분석 예: `SELECT * FROM mk_daily_realized ORDER BY kst_day DESC;`

## 6. 자원·비용 감시
- `docker stats`로 컨테이너별 CPU/메모리. API·Postgres가 계속 높으면 `.env.production`의
  `BOT_QUOTE_RECONCILE_MS`(기본 400)·`BOT_FLOW_DELAY_SCALE`(기본 1.25)을 올린다.
- Always Free 인스턴스는 7일 연속 CPU·메모리·네트워크 사용률 20% 미만이면 회수 대상이지만, 봇이 상시 거래하는
  이 서비스는 해당하지 않는다. 그래도 콘솔 > 비용 분석에서 0원인지 가끔 확인한다.
- 디스크: `df -h /`, DB 크기 `docker compose … exec postgres psql -U $POSTGRES_USER -c "SELECT pg_size_pretty(pg_database_size(current_database()))"`.

## 7. 문제 해결
- 80/443이 안 열림: `sudo iptables -L INPUT -n --line-numbers` 에 80/443 ACCEPT가 REJECT보다 위에 있어야 한다. `sudo /usr/local/sbin/open-web-ports.sh`.
- 빌드 중 메모리 부족: 2/12 VM이면 `docker compose … build web`을 먼저 따로 돌린 뒤 나머지를 빌드한다.
- Prisma 엔진 오류(`linux-arm64-openssl-3.0.x`): 스키마의 `binaryTargets`에 포함돼 있다. 이미지를 x86에서 빌드해 옮겼다면 그대로 동작한다.
- ADB 401: `p_auto_rest_auth => TRUE`로 스키마를 REST 활성화했는지, Basic 인증 사용자명이 대문자 `MOCKKABU`인지 확인.
