# 운영 업데이트 배포 절차 (GCP `mock-kabu-prod`)

코드 변경을 운영 서버에 반영하는 절차다. 2026-09-25 신규 5종목 상장 배포에서 실제로 쓴 명령을 기준으로 정리했고, 그때 겪은 문제를 각 단계에 **⚠️**로 표시했다.

서버를 처음 구축하는 절차는 [deploy/gcp/README.md](../deploy/gcp/README.md), 운영 중 조회 명령은 [server-operations.md](server-operations.md), 점검 창의 동작은 [daily-maintenance.md](daily-maintenance.md)를 본다.

## 한눈에 보기

| 단계 | 어디서 | 운영 영향 | 하는 일 |
|---|---|---|---|
| 0 | 로컬 | 없음 | 바뀐 파일 묶기, 업로드 |
| 1 | 서버 | 없음 | 롤백 태그, 소스 백업, 파일 교체, **교체 확인**, 이미지 빌드 |
| 2 | 서버 | 배너 | 점검 예고(5분 뒤 시작) |
| 3 | 서버 | 주문 중단 | 봇 정지, DB 백업, 서비스 교체, (필요 시) 마이그레이션·seed·지수 편입 |
| 4 | 서버 | 복구 | 점검 해제, 봇 시작, 호가·정합성 확인 |
| 5 | 로컬 | 없음 | HANDOFF 기록 |

웹만 바뀌는 등 작은 변경은 2~3단계를 생략하고 해당 서비스만 교체해도 된다([작은 변경](#작은-변경-점검-없이)).

## 알아둘 구조

- 서버 소스는 `/opt/mock-kabu2`이고 **git 저장소가 아니다.** 바뀐 파일만 복사해 덮어쓴다.
- api·web·matching-engine·settlement·bots·seed·migrate는 모두 **하나의 이미지 `mock-kabu2-app:gcp`** 를 쓴다. `build api` 한 번으로 모든 서비스의 새 이미지가 만들어지고, 어떤 서비스에 반영할지는 `up -d --no-deps <서비스>`로 고른다.
- 이미지는 서버 소스로 빌드된다. **소스가 안 바뀌면 빌드는 캐시로 금방 끝나고 옛 코드가 그대로 나온다.**
- `/opt/mock-kabu2`는 SSH 사용자(`winyu-mock-kabu`)가 쓸 수 없다. 파일을 바꿀 때는 `sudo`가 필요하다.

## 터미널 사용 팁 (먼저 읽기)

- **접속**: 로컬 PowerShell에서 `ssh mock-kabu` (Windows OpenSSH + ssh-agent. Git Bash의 ssh는 키를 못 찾는다).
- ⚠️ **SSH 창에서 Ctrl+V가 안 된다.** 대신 아래 중 하나를 쓴다.
  - 기본 PowerShell 창: **마우스 오른쪽 클릭**
  - Windows Terminal: **Ctrl+Shift+V**
  - 대부분의 터미널: **Shift+Insert**
  - 여러 줄 붙여넣기 확인 창이 뜨면 "붙여넣기"를 누른다.
- 붙여넣기가 끝내 안 되면 명령을 메모장에 저장(예: `step1.sh`)한 뒤 로컬 PowerShell에서 보낸다. 메모장의 CRLF는 `tr`이 지운다.
  ```powershell
  Get-Content step1.sh -Raw | ssh mock-kabu "tr -d '\r' | bash -s"
  ```
- ⚠️ **셸 변수는 SSH 세션마다 사라진다.** 새로 접속했으면 먼저 아래 두 줄을 입력한다. 아래 모든 단계가 `$C`를 쓴다.
  ```bash
  cd /opt/mock-kabu2
  C="sudo docker compose --env-file deploy/production/.env.production -f deploy/production/compose.production.yml -f deploy/gcp/compose.gcp.yml"
  ```
- ⚠️ `for ... ; do ... ; done` 은 **한 줄 전체가 명령 하나**다. 중간에서 끊지 말고 `done`까지 입력한다. 프롬프트가 `>`로 바뀌어 기다리면 `done`을 입력하고 Enter.
- ⚠️ `| tail -N`이 붙은 명령은 **끝날 때까지 아무것도 안 보인다.** 오래 걸리는 명령(빌드)에는 붙이지 않는다.

## 0. 로컬: 바뀐 파일 묶기

서버에 마지막으로 배포된 커밋(`BASE`)부터 지금까지 바뀐 파일만 묶는다. `BASE`는 HANDOFF의 마지막 운영 적용 기록이나 서버의 `/opt/mock-kabu2/DEPLOYED_COMMIT`(5단계에서 남김)으로 확인한다.

```bash
# Git Bash, 저장소 루트
BASE=<서버에 배포된 커밋>
mkdir -p tmp/deploy
git diff --name-only --diff-filter=ACMR $BASE HEAD > tmp/deploy/files.txt
git diff --name-only --diff-filter=D $BASE HEAD > tmp/deploy/deleted.txt   # 삭제된 파일(있으면 서버에서 따로 지운다)
git -c core.autocrlf=false archive -o tmp/deploy/release.tar HEAD $(cat tmp/deploy/files.txt)
git rev-parse --short HEAD > tmp/deploy/commit.txt
cat tmp/deploy/files.txt
```

```powershell
# PowerShell
cd C:\Users\Winyu\Documents\Project\mock_kabu2
scp tmp\deploy\release.tar tmp\deploy\files.txt tmp\deploy\commit.txt mock-kabu:/tmp/
```

- `core.autocrlf=false`로 묶어야 서버에 LF로 들어간다.
- `tmp/`는 커밋하지 않는 로컬 작업 폴더다.

## 1. 서버: 준비 (운영 영향 없음)

```bash
ssh mock-kabu
cd /opt/mock-kabu2
C="sudo docker compose --env-file deploy/production/.env.production -f deploy/production/compose.production.yml -f deploy/gcp/compose.gcp.yml"
TAG=pre-<변경이름>-$(date +%Y%m%d)        # 예: pre-add5b-20260925
```

### 1-1. 롤백 태그와 소스 백업

```bash
sudo docker tag mock-kabu2-app:gcp mock-kabu2-app:$TAG
# 서비스별로 실제 실행 중인 이미지가 다를 수 있다(부분 배포 이력). 각각 태그해 둔다.
for s in api web bots matching-engine settlement; do sudo docker tag $(sudo docker inspect -f '{{.Image}}' mock-kabu2-prod-$s-1) mock-kabu2-app:$TAG-$s; done
sudo tar czf /tmp/src-before-$TAG.tgz --ignore-failed-read $(cat /tmp/files.txt)
ls -la /tmp/src-before-$TAG.tgz
```

- ⚠️ **백업(`tar czf`)은 파일 교체 전에 한 번만.** 교체 뒤에 다시 실행하면 새 파일로 백업을 덮어써 롤백 원본이 사라진다.
- 새로 추가되는 파일은 서버에 없으므로 `--ignore-failed-read`가 경고만 내고 넘어간다.

### 1-2. 파일 교체 — 반드시 sudo, 반드시 확인

```bash
sudo tar xf /tmp/release.tar -C /opt/mock-kabu2 --no-same-owner
echo "exit=$?"
```

바로 확인한다. 이번 변경에서 **새로 들어간 문자열 하나**를 골라 grep 한다.

```bash
grep -c '<이번 변경에만 있는 문자열>' <바뀐 파일>     # 예: grep -c DDAM packages/shared/src/constants.ts → 1 이상
```

- ⚠️ **실제로 겪은 문제**: `sudo` 없이 `tar xf`를 해서 권한 오류로 교체가 안 됐는데, 출력이 스크롤로 넘어가 못 봤다. 그 상태로 빌드가 캐시로 끝나 옛 코드가 배포됐고, 3단계 seed가 `symbols: 10 upserted`(15여야 함)를 찍고서야 드러났다. **grep 결과가 0이면 빌드로 넘어가지 않는다.**

### 1-3. 이미지 빌드

```bash
$C build api
```

- 5~10분, 길면 15분 걸린다(서버 vCPU 4, Next.js 빌드가 가장 무겁다). 단계 로그가 계속 올라가면 정상.
- 끝에 `Image mock-kabu2-app:gcp Built`가 나오면 성공.
- 빌드 중에도 운영 컨테이너는 옛 이미지로 계속 돈다(CPU를 써서 잠깐 느려질 수 있음).
- ⚠️ **Ctrl+C로 끊지 않는다.** 끊어도 운영엔 영향이 없다(태그는 성공해야 바뀐다). 다시 `$C build api`만 실행하면 되고, 1-1·1-2는 다시 하지 않는다.
- 진행 확인이 필요하면 다른 창에서 `ssh mock-kabu "top -bn1 | head -15"`.
- 빌드된 이미지에 새 코드가 들어갔는지 확인:
  ```bash
  sudo docker run --rm --entrypoint grep mock-kabu2-app:gcp -c '<새 문자열>' /app/<바뀐 파일>
  ```

## 2. 서버: 점검 예고

주문을 막아야 하는 변경(종목 추가·DB 마이그레이션·매칭엔진/정산 교체)만 점검을 건다.

```bash
START=$(date -u -d '+5 min' +%Y-%m-%dT%H:%M:00Z); END=$(date -u -d '+25 min' +%Y-%m-%dT%H:%M:00Z)
VALUE="{\"startAt\":\"$START\",\"endAt\":\"$END\",\"message\":\"<안내 문구>\"}"
sudo docker exec -e VALUE="$VALUE" mock-kabu2-prod-redis-1 sh -c 'redis-cli --no-auth-warning -a "$REDIS_PASSWORD" SET mock-kabu2:maintenance:manual "$VALUE" EX 7200'
echo "KST $(TZ=Asia/Seoul date -d $START +%H:%M) ~ $(TZ=Asia/Seoul date -d $END +%H:%M)"
```

- `OK`가 나오면 모든 화면 상단에 예고 배너가 뜨고, 시작 시각부터 주문·취소·정정이 503으로 막힌다.
- ⚠️ **작업이 길어지면 연장한다.** 문제 해결 중 종료 시각이 지나면 주문이 다시 열린다. 지금부터 30분으로 다시 거는 명령:
  ```bash
  START=$(date -u +%Y-%m-%dT%H:%M:00Z); END=$(date -u -d '+30 min' +%Y-%m-%dT%H:%M:00Z)
  VALUE="{\"startAt\":\"$START\",\"endAt\":\"$END\",\"message\":\"<안내 문구>\"}"
  sudo docker exec -e VALUE="$VALUE" mock-kabu2-prod-redis-1 sh -c 'redis-cli --no-auth-warning -a "$REDIS_PASSWORD" SET mock-kabu2:maintenance:manual "$VALUE" EX 7200'
  ```

## 3. 서버: 적용 (점검 시작 시각이 지난 뒤)

```bash
$C stop bots
$C exec -T -u postgres postgres pgbackrest --stanza=mock-kabu --type=diff backup
```

- 봇을 먼저 멈춘다. API 재시작 중에 봇이 돌면 마켓메이커가 멈춘 적이 있다.
- DB 백업은 1~2분 걸린다. 끊지 않는다.

변경 종류에 맞는 것만 실행한다.

```bash
$C up -d --no-deps postgres              # deploy/gcp/compose.gcp.yml의 postgres 설정(한도·command)이 바뀐 경우
$C ps postgres                           # (healthy)가 될 때까지 몇 번 확인 — DB 재시작 10~20초
$C run --rm migrate                      # Prisma 마이그레이션이 추가된 경우
$C up -d --no-deps api web               # 거의 항상
$C run --rm seed 2>&1 | tail -4          # 종목 추가·봇 계정 변경
$C run --rm --no-deps api index-add-members --apply 2>&1 | tail -4   # 종목 추가 시 지수 편입
$C up -d --no-deps matching-engine settlement   # shared·엔진·정산이 바뀐 경우
```

확인할 출력:

- seed: `symbols: <전체 종목 수> upserted` — ⚠️ 종목 수가 예상과 다르면 **새 코드가 이미지에 없다**는 뜻이다. 1-2로 돌아가 교체를 확인하고 다시 빌드한다(봇 정지·DB 백업은 반복하지 않는다).
- 지수 편입: `add <새 종목들> at level ...`와 `index epoch added ... with <N> members`.

## 4. 서버: 점검 해제 → 봇 시작 → 확인

```bash
sudo docker exec mock-kabu2-prod-redis-1 sh -c 'redis-cli --no-auth-warning -a "$REDIS_PASSWORD" DEL mock-kabu2:maintenance:manual'
$C up -d --no-deps bots
sleep 90
```

`sleep 90`은 마켓메이커가 호가를 까는 시간이다(1분 30초 멈춰 있는 게 정상).

```bash
sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
for s in MOCK KABU DAON; do sudo docker exec mock-kabu2-prod-api-1 node -e "fetch('http://127.0.0.1:4100/market/orderbook/$s').then(r=>r.json()).then(d=>console.log('$s',d.bids.length,d.asks.length,d.lastPrice))"; done
$C run --rm --no-deps api consistency 2>&1 | grep -E "PASS|FAIL|정합성"
```

- 컨테이너: 모두 `Up`, api·web은 `(healthy)`.
- 호가: 종목마다 `10 10 <가격>`(매수·매도 10단). 새 종목이 있으면 목록에 넣는다.
- 정합성: 마지막 줄이 `정합성 검사 전부 통과`.
- ⚠️ `consistency`를 그냥 `tail`로 보면 `INFO 총 주식 수 ...` 줄만 보여 판정을 놓친다. 위처럼 `grep`으로 판정 줄만 본다.
- 봇 에러 확인: `sudo docker logs --since 5m mock-kabu2-prod-bots-1 2>&1 | grep -iE "error|fail" | tail`

## 5. 기록

서버에 배포된 커밋을 남긴다(다음 배포의 `BASE`).

```bash
sudo cp /tmp/commit.txt /opt/mock-kabu2/DEPLOYED_COMMIT
```

로컬 `HANDOFF.md` 맨 위에 운영 적용 기록을 추가하고 `docs:` 커밋한다. 적을 것: 변경 요약, 교체한 서비스, DB 백업 여부, 롤백 태그(`$TAG`), 원본 소스 경로(`/tmp/src-before-$TAG.tgz`), 확인 결과.

## 롤백

```bash
cd /opt/mock-kabu2
C="sudo docker compose --env-file deploy/production/.env.production -f deploy/production/compose.production.yml -f deploy/gcp/compose.gcp.yml"
TAG=<1단계의 태그>
sudo tar xzf /tmp/src-before-$TAG.tgz -C /opt/mock-kabu2 --no-same-owner
sudo docker tag mock-kabu2-app:$TAG mock-kabu2-app:gcp
$C up -d --no-deps api web matching-engine settlement bots
```

- 새로 추가됐던 파일은 백업에 없으므로 남는다. 다음 빌드 전에 `files.txt`에서 새 파일을 골라 지운다.
- **DB는 되돌리지 않는다.** seed로 추가된 종목 행, 지수 구간, 마이그레이션은 남는다. DB까지 되돌려야 하면 3단계의 pgBackRest 백업으로 복구해야 하므로 [production-vps-deployment.md](production-vps-deployment.md)의 복구 절차를 따른다.
- 서비스별 실행 이미지가 달랐다면 `mock-kabu2-app:$TAG-<서비스>` 태그로 개별 복구한다.

## 작은 변경 (점검 없이)

웹 화면만 바뀌거나 API의 조회 로직만 바뀌면 점검 없이 해당 서비스만 교체한다.

```bash
# 0 → 1(1-1 ~ 1-3) 그대로 수행 후
$C up -d --no-deps web            # 웹만
$C up -d --no-deps api web        # API 조회 변경 포함
```

- bots만 바뀐 경우도 `$C up -d --no-deps bots`로 교체한다(재시작 직후 옛 주문을 채택해 호가가 점차 정리된다).
- `packages/shared`가 바뀌면 모든 서비스가 영향을 받을 수 있으니 전체 절차를 따른다.

### 예시: 웹 화면 한 파일 수정 (2026-09-25, 폰 증권 탭 거래대금 숨김, `7f8214a`)

**로컬** — 바뀐 코드가 웹 파일 하나인지 먼저 확인하고 묶는다.

```bash
# Git Bash, 저장소 루트. 1b8aabd = 서버에 올라가 있던 커밋
git diff --name-only 1b8aabd HEAD -- apps packages deploy     # → apps/web/src/app/market/page.tsx 하나
git -c core.autocrlf=false archive -o tmp/deploy/release.tar HEAD apps/web/src/app/market/page.tsx
git rev-parse --short HEAD > tmp/deploy/commit.txt
```

```powershell
# PowerShell
cd C:\Users\Winyu\Documents\Project\mock_kabu2
scp tmp\deploy\release.tar tmp\deploy\commit.txt mock-kabu:/tmp/
ssh mock-kabu
```

**서버** — 백업 → 교체 → grep 확인 → 빌드 → 웹만 교체. 점검·봇 정지·DB 백업은 하지 않는다.

```bash
cd /opt/mock-kabu2
C="sudo docker compose --env-file deploy/production/.env.production -f deploy/production/compose.production.yml -f deploy/gcp/compose.gcp.yml"
TAG=pre-phoneturnover-20260925
sudo docker tag mock-kabu2-app:gcp mock-kabu2-app:$TAG
sudo tar czf /tmp/src-before-$TAG.tgz apps/web/src/app/market/page.tsx
sudo tar xf /tmp/release.tar -C /opt/mock-kabu2 --no-same-owner
grep -c "폰은 폭이 좁아 거래대금을" apps/web/src/app/market/page.tsx    # 1이어야 한다. 0이면 멈춘다

$C build api                        # 5~10분, 끊지 않는다
$C up -d --no-deps web
sudo docker ps --format '{{.Names}}\t{{.Status}}' | grep web       # Up ... (healthy)
sudo cp /tmp/commit.txt /opt/mock-kabu2/DEPLOYED_COMMIT
```

- grep 할 문자열은 이번 수정에만 있는 줄(여기서는 새로 넣은 주석)을 고른다. 이미 있던 코드를 고르면 교체 실패를 못 잡는다.
- 웹 교체 중 몇 초간 페이지가 안 열릴 수 있다. 주문·봇·체결에는 영향이 없다.
- 확인: 폰으로 증권 탭을 새로고침해 종목 이름 아래에 코드만 보이는지, PC에서는 거래대금이 그대로 보이는지.
- 롤백:
  ```bash
  sudo tar xzf /tmp/src-before-$TAG.tgz -C /opt/mock-kabu2 --no-same-owner
  sudo docker tag mock-kabu2-app:$TAG mock-kabu2-app:gcp
  $C up -d --no-deps web
  ```

## 문제 해결 요약

| 증상 | 원인 | 해결 |
|---|---|---|
| SSH 창에 붙여넣기가 안 됨 | 터미널이 Ctrl+V를 쓰지 않음 | 우클릭 / Ctrl+Shift+V / Shift+Insert, 또는 파일로 보내 `bash -s` |
| 빌드가 아무 출력 없이 오래 걸림 | `\| tail`이 끝날 때까지 출력을 모음 | 빌드엔 `tail`을 붙이지 않는다. 5~15분 정상 |
| 빌드를 Ctrl+C로 끊음 | — | 운영 영향 없음. `$C build api`만 다시 |
| seed가 옛 종목 수를 출력 | 파일 교체 실패 → 빌드가 옛 소스 캐시 | `sudo tar xf ... --no-same-owner` 후 grep 확인, 다시 빌드 |
| `$C: command not found` 비슷한 오류 | 새 SSH 세션에서 변수 사라짐 | `cd /opt/mock-kabu2`와 `C=...` 다시 입력 |
| 프롬프트가 `>`에서 멈춤 | `for` 문을 `done` 전에 끊음 | `done` 입력 후 Enter |
| 정합성 결과에 INFO만 보임 | 판정 줄이 잘림 | `consistency 2>&1 \| grep -E "PASS\|FAIL\|정합성"` |
| 작업 중 점검 종료 시각이 다가옴 | 예상보다 오래 걸림 | 2단계의 연장 명령 |
