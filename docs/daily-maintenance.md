# 매일 거래 점검 (운영)

- 시간: 매일 04:10~04:20 KST, 10분.
- API는 일반·조건부 주문의 접수/취소/정정을 503으로 거부한다. 조회와 기존 체결·정산은 계속 처리한다.
- 종목 화면에는 점검 안내를 띄우고 차트·호가·주문 UI를 잠시 숨긴다. `/health/maintenance`가 현재 상태와 다음 시간대를 반환한다.
- 04:10에 봇 컨테이너를 정지하고 04:20에 재개한다. 원래 정지 상태였거나 스토리지 가드가 경보로 정지했다면 재개하지 않는다.
- 04:11에 오래된 거래 이력 정리 및 정합성 검사, 04:12에 미사용 Docker 빌드 캐시/이미지 정리를 시작한다. 이력 정리가 길어지면 04:20 이후에도 계속될 수 있으나 거래는 예정대로 재개한다.
- 서버가 꺼져 있던 동안 놓친 타이머는 나중에 실행하지 않는다. 새로 부팅된 서버가 점검 시간대 안에 있으면 API의 주문 제한은 시간으로 적용된다.

점검은 디스크 증가의 근본 해결책이 아니다. 봇 주문 생성량 감소, 30일 경과 데이터 정리, Docker 캐시 상한, 백업 WAL 정상 보관, 1분 스토리지 가드가 주된 보호 장치다. 특히 DB·Redis 데이터나 실행 중인 이미지/볼륨은 자동으로 지우지 않는다.
정리 뒤 PostgreSQL이 삭제된 공간을 내부적으로 재사용하므로 `df` 사용량은 곧바로 감소하지 않을 수 있다. `storage-trend.py`의 24시간 순증가량과 85%까지의 단순 직선 추정일을 함께 봐야 한다. 24시간 표본이 없거나 백업·이미지 빌드가 한 번만 포함된 구간이면 장기 증가율을 확정하지 않는다.
30일 보존 데이터가 쌓이기 전에는 자연스러운 증가가 있다. 보존 기간 이후에도 하루 순증가가 계속된다면 점검을 더 자주 하는 것만으로는 누적량이 줄지 않는다. 봇 쓰기량, 보존 기간, 백업/WAL 또는 볼륨 크기를 다시 조정한다.

```bash
systemctl list-timers 'mock-kabu-*'
sudo journalctl -u mock-kabu-maintenance-start -u mock-kabu-maintenance-end -u mock-kabu-prune -u mock-kabu-build-cache-prune --since today
curl -fsS http://127.0.0.1/health/maintenance
sudo python3 /opt/mock-kabu2/scripts/ops/storage-trend.py  # 최근 1/6/24시간 순증가량
sudo cat /var/lib/mock-kabu-maintenance/bots.json  # 점검 중에만 존재
```

`bots.json`이 04:20 이후에도 남아 있으면 `sudo systemctl start mock-kabu-maintenance-end.service`로 재개를 재시도한다. 스토리지 가드의 `bots-paused.json`이 있으면 가드 경보를 먼저 해결한다.
