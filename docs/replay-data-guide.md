# 실전 리플레이 데이터 가이드

## 목적과 분리 원칙

`/replay`의 **실전 리플레이**는 과거 일봉을 한 봉씩 공개하며 매매 연습을 하는 별도 학습 화면이다.
현재 대상은 AAPL, MSFT, NVDA이며 가격은 USD cent 정수로 전달된다. 이 데이터는 기존 대시보드의
KABU·MOCK·NEKO·SAKU·TANU와 별개다.

리플레이 API는 읽기 전용이다. `market.symbols`, Redis 호가창, `matching.trades`, 주문, 계좌,
정산 테이블에는 리플레이 종목·주문·체결을 추가하지 않는다. 기간·속도·시나리오를 바꿔도 기존
모의거래의 가격, 봇, 보유 수량, 잔고에는 영향이 없다.

## 기간과 재생 속도

일봉 요청에는 다음 기간을 사용할 수 있다.

| 값 | 의미 |
| --- | --- |
| `1mo`, `3mo`, `6mo` | 최근 1·3·6개월 |
| `1y`, `2y`, `5y`, `10y` | 최근 1·2·5·10년 |
| `max` | 선택한 데이터 소스가 제공하는 최대 일봉 이력 |

`max`는 모든 종목에 같은 기간이나 모든 상장일 자료가 있다는 보증이 아니다. 상장 시점, 결측,
데이터 계약과 제공자 보존 정책에 따라 실제 반환 봉 수가 달라질 수 있다. 긴 기간은 응답과 초기
처리 시간이 짧은 기간보다 커질 수 있다.

리플레이는 일봉 하나를 1x에서 1초로 재생한다. `x0.25`는 한 봉에 약 4초, `x0.5`는 약 2초,
`x2`는 약 0.5초를 쓴다. 진행 중인 봉은 관측된 가격만 차트에 보이도록 처리하므로 미래의
고가·저가·종가를 미리 공개하지 않는다.

## 데이터 소스와 기본 동작

`source=auto`의 선택 순서는 다음과 같다.

1. 사용자가 명시적으로 설정한 로컬 CSV (`REPLAY_HISTORICAL_CSV_DIR`)
2. 사용자가 명시적으로 설정한 Alpha Vantage API 키 (`ALPHA_VANTAGE_API_KEY`)
3. 두 소스가 없거나 AAPL의 승인된 외부 요청이 실패한 경우, AAPL 내장 fixture

아무 환경 변수를 설정하지 않은 기본 상태에서는 **외부 네트워크 요청을 전혀 보내지 않는다**.
이때 AAPL은 fixture로 연습할 수 있고, fixture가 없는 MSFT·NVDA는 왜 실제 데이터를 불러올 수
없는지 설명하는 `503 Service Unavailable`을 반환한다. 임의의 가격을 만들거나 다른 종목 데이터를
대신 보여 주지 않는다.

소스 결과는 API 프로세스 메모리에 `종목:기간` 단위로 5분 캐시된다. 같은 요청은 하나로 합쳐지고,
API를 재시작하면 캐시도 사라진다. 이 캐시는 PostgreSQL이나 Redis에 외부 가격을 저장하지 않는다.

## 1. 사용자 권한 로컬 CSV

온라인 API를 쓰지 않거나 장기 데이터를 재현 가능하게 연습하려면, 사용자가 취득·보관할 권한을
확인한 CSV를 사용할 수 있다. 루트 `.env`에 절대 경로를 설정한 뒤 API를 재시작한다.

```dotenv
REPLAY_HISTORICAL_CSV_DIR=C:\data\licensed-replay-csv
```

카탈로그 종목마다 다음 이름의 파일을 둔다.

```text
C:\data\licensed-replay-csv\aapl-us.csv
C:\data\licensed-replay-csv\msft-us.csv
C:\data\licensed-replay-csv\nvda-us.csv
```

필수 헤더는 `date`(또는 `timestamp`/`ts`), `open`, `high`, `low`, `close`이며 `volume`은 선택이다.
가격은 USD 소수값으로 작성하고 서버가 cent 정수로 변환한다. UTF-8 CSV 예시는 다음과 같다.

```csv
date,open,high,low,close,volume
2020-01-02,74.06,75.15,73.80,75.09,135480400
2020-01-03,74.29,75.14,74.13,74.36,146322800
```

서버는 다음을 검증하며, 실패한 사용자 파일을 fixture나 인터넷 데이터로 조용히 바꾸지 않는다.

- HTTP 요청에서 파일 경로를 받지 않고 카탈로그 소유 id로만 `<dataset-id>.csv`를 선택한다.
- 설정 디렉터리와 파일의 실제 경로를 확인하고, symlink를 포함해 디렉터리 밖으로 나가는 경로를 거부한다.
- 20MB를 초과하는 파일, 누락된 필수 열, 잘못된 날짜·가격, 중복 날짜, 모순된 OHLC를 거부한다.
- `5y`, `10y`, `max`를 포함한 모든 기간은 파일의 최신 봉을 기준으로 달력 범위만 잘라 사용한다.

로컬 CSV는 API 키보다 우선한다. 해당 종목 파일이 없을 때만 다음 단계인 Alpha Vantage를 시도한다.
파일의 라이선스, 기업행동 처리, 재배포 가능 여부는 파일을 제공한 사용자가 확인해야 하며, 브라우저
메타데이터에는 절대 로컬 경로를 노출하지 않는다.

## 2. Alpha Vantage 온라인 일봉

온라인 실제 데이터는 사용자가 권한을 가진 Alpha Vantage API 키를 직접 설정한 경우에만 사용한다.
키를 커밋하거나 브라우저에 전달하지 말고 루트 `.env`에만 두고 API를 재시작한다.

```dotenv
ALPHA_VANTAGE_API_KEY=사용자_개인_키
```

서버는 `TIME_SERIES_DAILY`만 호출하며 API 키는 서버 내부 요청에만 붙인다. 응답의 `sourceUrl`에는
키를 제거한 공개 요청 형태만 표시한다. `1mo`와 `3mo`는 `compact` 일봉 응답을 쓰고, `6mo` 이상과
`5y`·`10y`·`max`는 `full` 일봉 응답을 요구한다. Alpha Vantage 문서에 따르면 `compact`는 최근
100개 데이터 포인트이고 `full`은 긴 이력용이며 현재 premium 권한이 필요할 수 있다.

선택한 긴 기간에 대해 공급자가 `full` 대신 `compact` 응답을 보내면 서버는 100개 봉을 5년/10년으로
잘못 표시하지 않고 설명적 오류를 반환한다. 이 경우 해당 데이터 권한을 확인하거나 권한 있는 로컬
CSV를 사용한다. 제공자 데이터의 지연, 정정, 결측, 분할 등은 투자 판단의 기준 데이터로 사용하면 안
된다.

Alpha Vantage 사용 전에는 사용자의 API 키 권한과 [공식 API 문서](https://www.alphavantage.co/documentation/),
[이용 약관](https://www.alphavantage.co/terms_of_service/)을 확인한다. 이 프로젝트는 키 또는 데이터에
대한 재배포 권한을 부여하지 않는다.

## 3. 오프라인 fixture (`source=fixture`)

**오프라인 학습 fixture**는 네트워크 요청을 전혀 하지 않는 결정론적 소형 샘플이다. 현재 AAPL에만
제공하며 Plotly `finance-charts-apple.csv`의 MIT 라이선스 시각화 데이터를 cent 단위로 변환한
2015-08-03부터 2015-09-04까지 25개 일봉이다.

- AAPL에서만 명시적으로 `source=fixture`를 선택할 수 있다.
- `5y`, `10y`, `max`를 골라도 fixture는 위 25개 봉으로 고정된다. 긴 기간의 대체 데이터가 아니다.
- AAPL의 Alpha Vantage 키 미설정·네트워크·제공자 응답 실패는 fixture로 대체될 수 있으며, 응답의
  `source.isFallback`과 안내문으로 항상 드러난다.
- 손상된 로컬 CSV나 예상하지 못한 서버 오류는 fixture로 감추지 않는다.

원본과 라이선스는 [Plotly datasets](https://github.com/plotly/datasets/blob/master/finance-charts-apple.csv) 및
[MIT License](https://github.com/plotly/datasets/blob/master/LICENSE)에서 확인할 수 있다.

## 실제 시세 모드와 봇 혼합 모드

| 모드 | 가격 경로 | 기존 봇·거래소와의 관계 |
| --- | --- | --- |
| 실제 시세 | 선택한 소스의 과거 OHLCV 기준 경로를 그대로 재생 | 봇 없음. `apps/bots`나 실호가창을 읽거나 바꾸지 않음 |
| 봇 혼합 | 기준 경로에 seed 기반의 가상 압력을 더함 | 가상 MM/모멘텀 압력은 리플레이 엔진 안에서만 계산되며 기존 봇 계정과 무관 |

혼합 모드의 가상 가격은 선택한 한도(±1%, ±2.5%, ±5%; 기본 ±5%) 안에 항상 제한된다. 이 한도는
기준 과거 가격에 대한 상한·하한이며 실제 `apps/bots` 프로세스나 Redis 주문장에 주문을 넣는 기능이
아니다. 같은 데이터·시나리오 seed·설정이면 같은 가상 압력이 재현된다.

리플레이 화면의 초기 USD 100,000 가상 계좌와 현재가 모의 매수/매도도 브라우저의 연습 상태다.
실제 로그인 계정의 주문 API를 호출하지 않으므로 대시보드의 체결, 잔고, 기존 5개 종목 호가창에
영향을 주지 않는다. 반대로 기존 봇의 활동도 순수 리플레이의 가격 경로에는 들어오지 않는다.

## API 상태와 문제 해결

- `GET /replay/datasets`는 각 데이터 소스의 설정 여부와 우선순위를 `dataSourceConfiguration`으로
  알려 준다. 비밀 값이나 로컬 경로는 반환하지 않는다.
- `GET /replay/datasets/:datasetId/candles?range=<기간>&source=auto`는 위 우선순위로 데이터를 찾는다.
- `400 Bad Request`: 허용하지 않은 `range` 또는 `source` 값을 보낸 경우다.
- `404 Not Found`: 리플레이 카탈로그에 없는 dataset id를 요청한 경우다.
- `503 Service Unavailable`: 권한 있는 소스가 없거나, API 키 권한이 부족하거나, 로컬 CSV 검증이
  실패한 경우다. 오류 문구를 확인해 키/CSV/기간을 바로잡는다.

리플레이는 투자 조언이나 실제 주문 기능이 아니다. 외부 배포 또는 장기 보존을 계획한다면 데이터
권리, 제공자 약관, 기업행동 처리, 통화·가격 단위, 감사·보존 정책을 별도로 설계해야 한다.
