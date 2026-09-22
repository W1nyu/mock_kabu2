# 저비용 단일 VPS 운영 배포

이 구성은 제공된 개발 스택 권고를 따라 **한 대의 VPS에 PostgreSQL, Redis, 기존 TypeScript 서비스와
백업을 함께** 올리는 출발점이다. BaaS나 관리형 DB를 전제로 하지 않으며, 데이터베이스는 pgBackRest로
암호화 백업한다. 트래픽·가용성 요구가 커지면 관리형 DB/Redis와 별도 워커로 옮겨야 하지만, 개인 서비스나
초기 검증에는 비용과 운영 복잡도를 낮춘다.

운영 파일은 개발용 `docker-compose.yml`과 완전히 분리되어 있다.

```text
Internet (80/443)
       |
     Caddy ──────────────> Next.js web
       |
       └───────────────> NestJS api <── bots
                                 |  \
                          PostgreSQL  Redis
                              |          |
                    pgBackRest repository  AOF volume
```

PostgreSQL, Redis, API, settlement, matching-engine, bots, web에는 호스트 포트를 열지 않는다. Caddy만
80/443을 공개한다. `POST /internal/liquidity/ensure`는 Caddy에서 먼저 404 처리되므로 같은 Docker
내부 네트워크의 `bots`만 API에 직접 요청할 수 있다.

## Oracle Cloud Always Free

무료 A1 VM에 같은 구성을 올리는 절차(Terraform, cloud-init, HTTP/IP 모드, Object Storage 백업, Autonomous Database 아카이브)는 [deploy/oci/README.md](../deploy/oci/README.md)에 따로 정리했다. 이 문서의 나머지 절차(비밀값, 백업·복구, 보존 정책)는 그대로 적용된다.

## 저장 공간 보존 정책

봇 시장은 하루에 수만 건의 주문·체결을 만든다. 정리하지 않으면 로컬 2주 운영에서 DB가 4.6GB까지 자랐고,
그중 4GB가 이미 발행된 outbox 행과 오래된 멱등 claim이었다. 세 갈래로 관리한다.

1. **프로세스가 스스로 지우는 것** (별도 설정 없음): API는 발행 1시간 지난 `order.outbox`, 매칭 엔진은
   발행된 `matching.outbox_events`와 7일 지난 `processed_order_events`·`closed_order_markers`를 1분마다
   배치(5,000행, 밀리면 최대 20배치)로 지운다. 자산 스냅샷은 API가 7일/90일 격자로 압축한다.
2. **봇 이력 정리 스크립트** — 주 1회 cron 권장:
   ```bash
   docker compose -f deploy/production/compose.production.yml run --rm api prune-history            # dry-run
   docker compose -f deploy/production/compose.production.yml run --rm api prune-history --apply --compact-bot-ledger
   ```
   봇 계정의 7일 지난 종결 주문, 30일 지난 봇↔봇 체결(그 실현손익·정산 claim 포함), 30일 지난 뉴스를
   지우고 봇 원장을 계정당 한 행으로 압축한다. **사용자 계정이 한쪽이라도 낀 행은 절대 지우지 않는다.**
   실행 뒤 `run --rm api consistency`로 확인한다. 공간 회수는 autovacuum이 하며, 즉시 필요하면
   `VACUUM (FULL, ANALYZE)`를 해당 테이블에 실행한다(락 걸림 — 조용한 시간에).
3. **지우면 안 되는 것**: `account.ledger_entries`(사용자), `account.processed_events`(체결 행이 있는 동안 —
   체결의 정산 증거), `market.candles`, `account.realized_pnl`(사용자).

## 1. VPS 준비

개인/저트래픽 기준으로는 1~2 vCPU, 2 GB RAM, 40 GB SSD와 2 GB swap을 최소선으로 잡는다. 소스에서
Next.js 이미지를 빌드하는 동안 메모리가 더 필요할 수 있으므로, 안정적인 운영은 4 GB RAM 또는 CI에서
이미지를 빌드·레지스트리에 푸시하는 방식이 낫다.

production Compose는 API·web을 384 MB, 매칭·정산·봇 워커를 320 MB, PostgreSQL을 768 MB로 제한하고
Node 힙도 그보다 낮게 고정한다. Redis는 기본 `256mb`의 `noeviction` 정책이며 `REDIS_MAXMEMORY`로만
상향한다. 주문/정산 Streams는 해당 consumer group에서 ACK가 완료된 앞부분만 trim하므로, 메모리가 찼을
때 이벤트를 묵시적으로 잃지 않는다. Redis 쓰기 실패나 `/health/trading` 오류가 보이면 한도를 먼저
올리기보다 consumer lag·outbox 재시도 상태를 조사한다.

Ubuntu/Debian 계열 VPS에 Docker Engine과 Docker Compose plugin을 설치하고, 방화벽에는 다음만 연다.

- SSH 관리 포트
- TCP 80, 443

DNS의 `A`(필요하면 `AAAA`) 레코드를 `APP_DOMAIN`에 VPS IP로 연결한다. Caddy는 이 DNS와 80/443으로
Let’s Encrypt 인증서를 자동 발급·갱신한다. IP 주소만으로 첫 배포를 하지 말고, 도메인 연결을 먼저 확인한다.

## 2. 비밀값과 환경 파일

저장소를 VPS의 예: `/srv/mock-kabu2`에 클론한 뒤 다음 파일을 만든다.

```sh
cd /srv/mock-kabu2/deploy/production
cp .env.production.example .env.production
chmod 600 .env.production
```

`APP_DOMAIN`, `CADDY_EMAIL`을 실제 값으로 바꾸고, 모든 `replace_...` 값을 서로 다른 비밀값으로
교체한다. 다음처럼 URL-safe hexadecimal 값을 쓰면 PostgreSQL/Redis 접속 URL 조립 시 인코딩 문제가 없다.

```sh
openssl rand -hex 32
```

특히 다음은 기본값을 절대 쓰지 않는다.

- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`
- `JWT_SECRET`, `LIQUIDITY_BOOTSTRAP_TOKEN`, `PGBACKREST_REPO1_CIPHER_PASS`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `BOT_PASSWORD`, `LIQUIDITY_BOT_PASSWORD`

`PGBACKREST_REPO1_CIPHER_PASS`를 잃으면 기존 백업을 복호화할 수 없다. 비밀 관리자나 오프라인
password manager에 별도로 보관한다. `.env.production`은 이미 `deploy/production/.gitignore`로 제외된다.

## 3. 최초 배포

아래 명령은 항상 운영 Compose 파일과 운영 환경 파일을 명시해 개발 Compose와 섞이지 않게 한다.

```sh
cd /srv/mock-kabu2/deploy/production

docker compose --env-file .env.production -f compose.production.yml config --quiet
docker compose --env-file .env.production -f compose.production.yml up --build -d
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs -f migrate seed api caddy
```

`migrate`와 `seed`는 한 번 실행되고 성공 상태로 끝나는 작업이다. API는 두 작업이 성공한 뒤에만
시작한다. `seed`가 실패했다면 API나 봇을 억지로 시작하지 말고 먼저 해당 컨테이너 로그와 비밀 환경 변수를
확인한다.

배포 확인은 다음처럼 한다.

```sh
curl --fail --show-error "https://$APP_DOMAIN/market/symbols"
curl --fail --show-error "https://$APP_DOMAIN/health/live"
curl --fail --show-error "https://$APP_DOMAIN/health/ready"
curl --fail --show-error "https://$APP_DOMAIN/health/trading"
docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps api consistency
```

`/health/ready`는 API 자신과 PostgreSQL·Redis 연결만 확인하므로 worker보다 먼저 API를
기동할 수 있다. `/health/trading`은 matching-engine과 settlement의 heartbeat까지 확인하는
거래 경로용 점검 endpoint다. 주문을 받는 로드밸런서나 운영 경보에는 후자를 사용한다.

브라우저용 `NEXT_PUBLIC_API_URL`은 Next.js **빌드 시점**에 `https://$APP_DOMAIN`으로 묶인다. 도메인을
바꾼 경우에는 반드시 다시 빌드한다.

```sh
docker compose --env-file .env.production -f compose.production.yml up --build -d
```

## 4. 일상 운영과 업데이트

상태와 로그 확인:

```sh
cd /srv/mock-kabu2/deploy/production
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs --tail=200 api settlement matching-engine bots caddy
```

코드 업데이트는 다음 순서로 한다. `down -v`, `docker volume rm`, `system prune --volumes`는 운영 데이터와
백업을 지울 수 있으므로 일반 업데이트에 사용하지 않는다.

```sh
cd /srv/mock-kabu2
git pull --ff-only
cd deploy/production
docker compose --env-file .env.production -f compose.production.yml up --build -d --remove-orphans
docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps api consistency
```

Compose 로그는 컨테이너마다 10 MB × 3개로 순환한다. `postgres-data`, `redis-data`,
`pgbackrest-data`, Caddy 인증서 볼륨은 개발 환경의 볼륨 이름과 다르므로 서로 충돌하지 않는다.

## 5. pgBackRest 백업

PostgreSQL 컨테이너는 WAL archive와 AES-256-CBC pgBackRest repository를 사용한다. 최초 배포 직후
full backup을 한 번 만들고, 매주 full + 나머지 날 incremental backup을 권장한다.

```sh
cd /srv/mock-kabu2
sh deploy/production/scripts/backup-postgres.sh full
sh deploy/production/scripts/verify-postgres-backup.sh
```

cron 예시(실제 저장소 경로·사용자에 맞게 수정):

```cron
# Sunday full; Monday-Saturday incremental. flock prevents overlapping jobs.
0 3 * * 0 flock -n /tmp/mock-kabu2-pgbackrest.lock sh /srv/mock-kabu2/deploy/production/scripts/backup-postgres.sh full >>/var/log/mock-kabu2-backup.log 2>&1
0 3 * * 1-6 flock -n /tmp/mock-kabu2-pgbackrest.lock sh /srv/mock-kabu2/deploy/production/scripts/backup-postgres.sh incr >>/var/log/mock-kabu2-backup.log 2>&1
```

현재 repository retention은 최근 full backup 2개(그에 딸린 incremental/differential backup)를 보관한다.
VPS의 디스크와 실제 DB 성장량을 측정한 뒤 retention을 늘린다. 주기적으로 다음 명령의 출력과 cron 로그를
확인한다.

```sh
sh /srv/mock-kabu2/deploy/production/scripts/verify-postgres-backup.sh
```

### VPS 자체 장애 대비

Docker named volume 안의 `pgbackrest-data`만으로는 VPS 디스크 장애를 막지 못한다. pgBackRest repository는
암호화된 상태이므로 Cloudflare R2 같은 저비용 S3 호환 스토리지에 **복사본**을 두는 것을 권장한다. `rclone`
등으로 `<compose project>-pgbackrest-data` volume을 off-site 버킷에 복사하고, 복구 키도 별도 보관한다.
처음 설정한 뒤에는 별도 테스트 VPS/볼륨에서 restore rehearsal을 한 번 수행한다.

Redis는 AOF(`appendfsync everysec`)를 별도 `redis-data` 볼륨에 유지한다. pgBackRest는 PostgreSQL용이므로
Redis AOF까지 백업하지 않는다. Redis Streams에는 전달 중인 주문 상태가 있으므로, VPS 전체 장애를 대비할
때는 **같은 유지보수 시점의 Redis volume snapshot도 함께** 외부 저장소에 보관한다. PostgreSQL만 과거 시점으로
복구하고 Redis를 새로 만드는 절차는 주문 stream 재발행을 완전히 보장하지 않으므로, 검증 없이 봇을 재개하면 안 된다.

## 6. PostgreSQL 복구

복구 스크립트는 모든 서비스를 중지하고, Compose 설정에서 확인한 `*-postgres-data` 볼륨만 삭제한 뒤
pgBackRest repository에서 새 볼륨으로 복원한다. Redis, Caddy 인증서, pgBackRest repository 볼륨은 보존한다.

1. 먼저 backup 목록을 보고 복구 대상을 정한다.

   ```sh
   sh /srv/mock-kabu2/deploy/production/scripts/verify-postgres-backup.sh
   ```

2. 최신 backup을 복구하려면 다음을 실행한다. 이 확인 문자열 없이는 스크립트가 동작하지 않는다.

   ```sh
   cd /srv/mock-kabu2
   PGBACKREST_RESTORE_CONFIRM=RESTORE_MOCK_KABU \
     sh deploy/production/scripts/restore-postgres.sh
   ```

3. 특정 pgBackRest backup label을 고르려면 `PGBACKREST_SET`도 명시한다.

   ```sh
   PGBACKREST_RESTORE_CONFIRM=RESTORE_MOCK_KABU \
   PGBACKREST_SET=20260808-030001F \
     sh /srv/mock-kabu2/deploy/production/scripts/restore-postgres.sh
   ```

4. 서비스가 다시 healthy가 된 뒤 정합성 검사와 안전한 dry-run을 실행한다.

   ```sh
   cd /srv/mock-kabu2/deploy/production
   docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps api consistency
   docker compose --env-file .env.production -f compose.production.yml run --rm --no-deps api recover-settlement
   ```

`recover-settlement`이 SAFE가 아닐 때는 `--apply`하지 말고 거래/Redis backup 상태를 조사한다. 복구 전후에는
봇을 잠시 멈춘 상태로 주문 흐름, Redis consumer lag, `check:consistency`를 검증하는 것이 안전하다.

## 7. 보안 점검표

- `docker compose ... ps`에서 공개 port가 Caddy의 `80`, `443`뿐인지 확인한다.
- `https://$APP_DOMAIN/internal/liquidity/ensure`가 404인지 확인한다. 이 경로를 외부 방화벽 예외나 다른
  프록시에 추가하지 않는다.
- `.env.production`, pgBackRest cipher key, off-site storage credentials를 Git/로그/브라우저 bundle에 넣지 않는다.
- OS/Docker/이미지 업데이트 전에는 fresh pgBackRest backup을 만든다.
- 월 1회 이상 다른 볼륨에서 restore rehearsal과 `consistency` 검사를 한다.

이 구성은 단일 VPS 장애를 자동으로 무중단 처리하지 않는다. 대신 공개 면적을 줄이고, 암호화 backup과
검증 가능한 복구 절차를 갖춘 저비용 운영 기반을 제공한다.
