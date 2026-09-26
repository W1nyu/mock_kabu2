#!/bin/sh
# 배포마다 남기는 롤백 태그(mock-kabu2-app:pre-*)를 최근 KEEP개만 남기고 지운다.
# 태그만 떼므로 다른 태그(gcp·최근 롤백)가 가리키는 이미지 층은 그대로 남는다.
# 사용: prune-rollback-images.sh [KEEP=8]
set -eu
KEEP="${1:-8}"
docker image ls mock-kabu2-app --filter 'reference=mock-kabu2-app:pre-*' \
  --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' |
  sort -r |
  tail -n +"$((KEEP + 1))" |
  cut -d'|' -f2 |
  while read -r ref; do
    docker image rm "$ref" >/dev/null && echo "removed $ref"
  done
docker image prune -f >/dev/null
