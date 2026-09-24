# 운영 디스크 보호 장치

2026-09-23 운영 서버에 활성화. `mock-kabu-storage-guard.timer`가 1분마다 실행한다.

- 75% 사용: 경고 기록.
- 85% 사용 또는 사용 가능 공간 6GiB 이하, inode 85%: 봇 중지.
- 보관 대기 WAL 중 가장 오래된 것이 5분 경과: 경고, 15분 경과: 봇 중지.
- 마지막 성공 백업 8시간 경과: 경고, 12시간 경과: 봇 중지.
- 백업 서비스 실패는 경고하고 15분 간격 재시도(2시간 내 최대 3회 실행).
- 봇 자동 중지 상태는 수동 해제 전 유지한다. 사용자 주문/API/정산은 계속 실행하므로 전체 쓰기를 차단하는 기능은 아니다. 디스크 고갈을 완전히 보장해 막는 장치는 아니다.
- 데이터나 WAL을 직접 삭제하지 않는다. 48시간/최대 2880개 측정값을 보존하고 30분 이상 표본으로 증가 속도를 추정한다.

```bash
sudo cat /var/lib/mock-kabu-storage-guard/status.json
sudo journalctl -u mock-kabu-storage-guard.service -n 10
systemctl list-timers 'mock-kabu-*'
```

장애 원인 해결 및 여유 공간 확인 후 봇 재개:

```bash
sudo systemctl stop mock-kabu-storage-guard.timer
sudo systemctl stop mock-kabu-storage-guard.service
sudo rm -f /var/lib/mock-kabu-storage-guard/bots-paused.json
docker start mock-kabu2-prod-bots-1
sudo systemctl start mock-kabu-storage-guard.timer
```

OCI `mock-kabu-storage-alerts` 토픽과 사용자 지정 Gmail 구독 생성/활성 확인 완료. `storage-notify.py`와 전용 SDK 환경(`/opt/mock-kabu-notify`) 설치 및 총 12개 테스트 통과. 월 100회 발송 시도, 시간당 최대 1회, 동일 경고 6시간 간격으로 제한한다(실패·타임아웃도 상한에 포함). 수신자는 1명만 유지해야 하며 계정 전체의 다른 알림 사용량은 별도 합산된다.

토픽은 전용 `mock-kabu-alerting` 컴파트먼트에 있으며, 운영 서버의 `/etc/mock-kabu/notifications.json`은 root 소유·권한 600, `enabled: true`다. OCI 게시 IAM 정책 `mock-kabu-storage-publisher`가 활성이고 단일 인스턴스 조건의 게시 권한 한 문장만 가진다. 2026-09-23 05:29 UTC 테스트 발행은 성공했으며 서버 상태 파일에 1회 발송 시도가 기록됐다. 사용자가 `stomailce0206@gmail.com`에서 테스트 메일 수신을 확인해 발행부터 이메일 전달까지 검증됐다. 토픽 OCID: `ocid1.onstopic.oc1.ap-osaka-1.amaaaaaasootz2qaz323it6au5eoekgps7txzsrlkcctvgwwxx2cavazgfja`.

정책은 루트 컴파트먼트에 다음 한 문장으로 생성했다. `request.instance.id` 조건은 지정한 인스턴스 주체만 허용하며, 전용 컴파트먼트에는 알림 토픽만 둔다.

```text
Allow any-user to {ONS_TOPIC_PUBLISH} in compartment mock-kabu-alerting where request.instance.id = 'ocid1.instance.oc1.ap-osaka-1.anvwsljrsootz2qcma7b63nkw3w4pkftg6kgml5fdheek2cb7egrzbk2pz4q'
```

게시 API 엔드포인트는 `https://notification.ap-osaka-1.oci.oraclecloud.com`이다. 수신 확인된 테스트 제목은 `jobradar.my notification test`다. 테스트 재발행도 시간당 최대 1회·월 100회 제한에 포함된다.

외부 Object Storage 백업은 미구성이다. 로컬 보호 장치만으로 서버 자체 장애를 알리거나 백업을 보호할 수 없다.
