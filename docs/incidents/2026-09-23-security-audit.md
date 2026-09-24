# 2026-09-23 운영 보안 점검

점검 대상: `jobradar.my`, OCI Osaka VM. 이 문서는 운영 확인과 의존성 보안 패치 배포 결과를 기록한다.

## 확인된 상태

- 외부 공개 포트는 SSH 22, HTTP 80, HTTPS 443이다. 호스트 방화벽은 나머지 인바운드를 거부한다. PostgreSQL·Redis·API에는 호스트 공개 포트가 없다.
- HTTPS 헤더·요청별 CSP nonce·`/internal/*` 외부 404 검사는 운영에서 통과했다.
- 최근 24시간 SSH 로그에는 잘못된 사용자명 탐색이 다수 있었다. 성공한 공개키 로그인은 `ubuntu` 계정, 단일 출처 IP·동일 키 지문뿐이었다. 점검 당시 비밀번호 인증은 꺼져 있었으나 `PermitRootLogin without-password`와 X11 포워딩은 켜져 있었다. 아래 조치로 둘 다 해제했다.
- 최근 웹 로그에 WordPress/`.env` 탐색 요청이 있으며 `/internal/*` 요청은 404였다. `/_next/image` 요청은 관찰되지 않았다. 이 로그만으로 침해 부재를 증명할 수는 없다.
- 패치 전 운영 이미지의 Next.js `15.5.20`, Sharp `0.34.5`, Multer `2.2.0` 등은 알려진 취약 버전이었다. 최초 `pnpm audit --prod` 결과는 critical 2/high 14/moderate 9/low 1이었다. Next.js critical 1건은 Windows 호스트 전용으로 현재 Linux VM에 해당하지 않았지만, AVIF 이미지 최적화 취약점은 Linux에도 해당했다. 현재 앱 코드에는 `next/image`, AVIF 파일, Server Actions, rewrites 사용이 없다.
- OS의 `sudo` 보안 패치가 1건 대기 중이었으며 `unattended-upgrades`는 active다. 아래 조치로 패치를 적용했다.
- 운영 JWT·관리자·봇·유동성 계정 비밀값은 설정돼 있고, 확인한 기본값과 다르며 각각 24자 이상이다(값 자체는 출력하지 않았다). 일반 사용자 가입 비밀번호의 최소 길이는 4자라 약한 비밀번호 선택을 허용한다. 로그인 제한은 IP와 로그인 ID 조합당 분당 10회이며 Redis 장애 시 허용으로 전환된다. 이는 분산 추측이나 Redis 장애 중 시도에 약할 수 있다.
- 디스크는 점검 중 57%/여유 약 19GB까지 증가했다. 추가 차등 백업을 성공시켜 WAL 아카이브를 만료한 뒤 패치를 배포했다. 배포 후 사용률은 53%/여유 21GB였다. 다음 백업이 실패하면 다시 고갈될 수 있다.

## 배포한 수정

- Next.js를 `15.5.24`로, Sharp를 `0.35.4`로 올렸다. Multer, Nanoid, PostCSS, Socket.IO parser, qs, deepmerge-ts의 취약 하위 의존성도 수정 버전으로 고정했다.
- 전체 `pnpm build`, `pnpm test`, `pnpm audit --prod --audit-level low` 통과. 마지막 감사 결과는 알려진 취약점 0건이다.
- 2026-09-23 05:08 UTC까지 운영 VM에서 새 이미지를 빌드하고 웹·API·정산·매칭·봇을 순차 교체했다. 실행 중 웹 컨테이너 잠금 파일에 Next.js `15.5.24`, 새 이미지에 Sharp `0.35.4`와 Multer `2.3.0`을 확인했다. 홈페이지 HTTP 200, 거래 헬스 전체 up, HTTPS 헤더·CSP nonce·내부 API 차단 검사, 거래 원장·예약 수량 정합성 검사 모두 통과했다. 이전 앱 이미지는 `mock-kabu2-app:pre-security-20260923`으로 보존했다.
- `/etc/ssh/sshd_config.d/99-mock-kabu-hardening.conf`로 `PermitRootLogin no`, `X11Forwarding no`를 적용했다. `sshd -t`와 유효 설정을 확인한 후 reload했고, 새 `ubuntu` 공개키 접속 및 `sudo` 사용을 재검증했다. 재배포용 원본은 `deploy/oci/sshd-hardening.conf`이다.
- 공식 Ubuntu 보안 저장소에서 `sudo`를 `1.9.15p5-3ubuntu5.24.04.3`으로 업데이트했다. 설치·후속 `sudo` 실행이 성공했고 SSH·unattended-upgrades는 active다.
- OCI Notifications 테스트 발행이 성공했다(`OCI alert published`). 발행 상태 파일에 2026-09-23 05:29 UTC 시도·발송 시각과 1회 시도가 기록됐다. 사용자가 테스트 메일 수신을 확인했다. 조치 후 홈페이지 HTTP 200, 거래 헬스 전체 up, 감시 타이머 active, 디스크 약 55%/여유 20GB를 재확인했다.

## 남은 운영 조치

1. 서버 자체 장애까지 감지하려면 외부 모니터링이 필요하다. 현재 알림은 서버에서 감시 스크립트가 실행될 때 발송된다.
2. 로컬 백업과 별개인 복구 사본을 검토한다. 현재 한 VM의 디스크 장애는 로컬 DB와 백업을 함께 잃을 수 있다.
3. 신규 가입 비밀번호의 최소 길이 4자와 Redis 장애 시 로그인 제한 허용 동작은 계정 추측에 대한 잔여 위험이다. 별도 변경 시 기존 사용자·장애 시 로그인 정책의 영향을 검토한다.
