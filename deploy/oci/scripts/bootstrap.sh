#!/usr/bin/env bash
# Oracle Cloud A1 VM에서 처음 한 번: .env 준비 → 이미지 빌드 → 기동 → 정리·백업 타이머 등록.
# cloud-init이 Docker 설치와 /opt/mock-kabu2 clone을 끝낸 뒤 ubuntu 사용자로 실행한다.
#
#   /opt/mock-kabu2/deploy/oci/scripts/bootstrap.sh            # 첫 설치
#   /opt/mock-kabu2/deploy/oci/scripts/bootstrap.sh --update   # git pull 후 재빌드·재기동
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/mock-kabu2}"
ENV_FILE="$REPO_DIR/deploy/production/.env.production"
cd "$REPO_DIR"

compose() {
  # 상대 경로 기준을 production 파일 디렉터리로 고정한다 (Caddyfile, context: ../.. 등).
  docker compose --env-file "$ENV_FILE" \
    -f deploy/production/compose.production.yml \
    -f deploy/oci/compose.oci.yml "$@"
}

if [[ "${1:-}" == "--update" ]]; then
  git pull --ff-only
  compose build
  compose run --rm migrate
  compose up -d --remove-orphans
  compose ps
  exit 0
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp deploy/production/.env.production.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  PUBLIC_IP="$(curl -fsS -m 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
  DOMAIN="$(sed -n 's/^APP_DOMAIN=//p' deploy/oci/.cloud-init-domain 2>/dev/null || true)"
  {
    echo ""
    echo "# --- Oracle Cloud (deploy/oci) ---"
    if [[ -n "$DOMAIN" ]]; then
      echo "APP_DOMAIN=$DOMAIN"
      echo "APP_ORIGIN=https://$DOMAIN"
      echo "CADDYFILE=../production/Caddyfile"
    else
      echo "# 도메인이 없으면 공인 IP + HTTP. production compose가 APP_DOMAIN을 필수로 요구해 자리표시자를 둔다."
      echo "# 도메인을 붙이면 APP_DOMAIN/APP_ORIGIN/CADDYFILE 세 줄을 바꾼다."
      echo "APP_DOMAIN=localhost"
      echo "APP_ORIGIN=http://$PUBLIC_IP"
      echo "CADDYFILE=../oci/Caddyfile.http"
    fi
    echo "# 백업을 Object Storage로 보내려면 아래 두 줄과 PGBACKREST_CONF=../oci/pgbackrest.s3.conf 를 채운다."
    echo "#OCI_S3_ACCESS_KEY="
    echo "#OCI_S3_SECRET_KEY="
    echo "#PGBACKREST_CONF=../oci/pgbackrest.s3.conf"
    echo "# Autonomous Database 아카이브 동기화 (선택, deploy/oci/README.md 참고)"
    echo "#ORACLE_ORDS_URL=https://xxxx-mockkabu.adb.ap-chuncheon-1.oraclecloudapps.com/ords/mockkabu"
    echo "#ORACLE_DB_USER=MOCKKABU"
    echo "#ORACLE_DB_PASSWORD="
  } >> "$ENV_FILE"
  # 비밀값 자동 생성 — example의 자리표시자를 채운다.
  gen() { openssl rand -hex 24; }
  for key in POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET LIQUIDITY_BOOTSTRAP_TOKEN PGBACKREST_REPO1_CIPHER_PASS BOT_PASSWORD LIQUIDITY_BOT_PASSWORD ADMIN_PASSWORD; do
    if grep -qE "^$key=(replace_with|$)" "$ENV_FILE" || grep -qE "^$key=.*replace" "$ENV_FILE"; then
      sed -i "s|^$key=.*|$key=$(gen)|" "$ENV_FILE"
    fi
  done
  echo "생성: $ENV_FILE — ADMIN_EMAIL, CADDY_EMAIL, (도메인이 있으면) APP_DOMAIN 을 확인한 뒤 다시 실행하세요."
  echo "  nano $ENV_FILE && $0"
  exit 0
fi

# 필수 값 점검
for key in APP_ORIGIN POSTGRES_PASSWORD JWT_SECRET ADMIN_EMAIL; do
  grep -qE "^$key=.+" "$ENV_FILE" || { echo "$ENV_FILE 에 $key 가 비어 있습니다"; exit 1; }
done

compose build
compose up -d
compose ps

# 정리·백업 타이머 (systemd). 실패해도 서비스에는 영향 없다.
sudo install -m 0644 deploy/oci/systemd/mock-kabu-prune.service deploy/oci/systemd/mock-kabu-prune.timer \
  deploy/oci/systemd/mock-kabu-backup.service deploy/oci/systemd/mock-kabu-backup.timer \
  deploy/oci/systemd/mock-kabu-oracle-sync.service deploy/oci/systemd/mock-kabu-oracle-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mock-kabu-prune.timer mock-kabu-backup.timer
if grep -qE "^ORACLE_ORDS_URL=https" "$ENV_FILE"; then
  sudo systemctl enable --now mock-kabu-oracle-sync.timer
fi

echo
echo "기동 완료. 상태: $0 --status 대신 'docker compose ... ps' / 헬스: curl -s localhost:80/health/ready"
echo "브라우저: $(sed -n 's/^APP_ORIGIN=//p' "$ENV_FILE")"
