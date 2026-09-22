-- Oracle Autonomous Database (Always Free, 20GB) — mock-kabu2 아카이브·분석 스키마.
--
-- 주 DB는 여전히 PostgreSQL(컨테이너)이다. Prisma에 Oracle 커넥터가 없고 정산·매칭이 PostgreSQL 전용
-- SQL(FOR UPDATE, DISTINCT ON, FILTER, ON CONFLICT…) 위에 있어서 주 DB를 바꾸는 대신, 무료 ADB를
-- "오래 보관하고 SQL로 분석하는" 저장소로 쓴다. 동기화는 packages/db/scripts/oracle-sync.ts가
-- ORDS REST SQL(HTTPS)로 하므로 Oracle 드라이버가 필요 없다.
--
-- 적용: ADB 콘솔 > Database Actions > SQL 에서 ADMIN으로 실행 (1부), 이어서 새 사용자로 로그인해 2부 실행.

-- ── 1부: ADMIN ─────────────────────────────────────────────────────────────
-- CREATE USER mockkabu IDENTIFIED BY "<강한비밀번호>";
-- GRANT CONNECT, RESOURCE TO mockkabu;
-- ALTER USER mockkabu QUOTA UNLIMITED ON DATA;
-- BEGIN
--   ORDS.ENABLE_SCHEMA(p_enabled => TRUE, p_schema => 'MOCKKABU',
--                      p_url_mapping_type => 'BASE_PATH', p_url_mapping_pattern => 'mockkabu',
--                      p_auto_rest_auth => TRUE);
--   COMMIT;
-- END;
-- /
-- → ORDS_URL = https://<adb-host>/ords/mockkabu   (REST SQL 엔드포인트는 그 아래 /_/sql)

-- ── 2부: MOCKKABU 로 실행 ───────────────────────────────────────────────────

CREATE TABLE mk_sync_state (
  stream      VARCHAR2(40)  PRIMARY KEY,
  watermark   TIMESTAMP(3)  NOT NULL,
  updated_at  TIMESTAMP(3)  DEFAULT SYSTIMESTAMP NOT NULL
);

-- 1분 봉 (종목별 시계열). PostgreSQL market.candles 그대로.
CREATE TABLE mk_candles (
  symbol   VARCHAR2(16)  NOT NULL,
  ts       TIMESTAMP(3)  NOT NULL,
  open     NUMBER(12)    NOT NULL,
  high     NUMBER(12)    NOT NULL,
  low      NUMBER(12)    NOT NULL,
  close    NUMBER(12)    NOT NULL,
  volume   NUMBER(19)    NOT NULL,
  CONSTRAINT mk_candles_pk PRIMARY KEY (symbol, ts)
);

-- 사용자 계정이 한쪽이라도 낀 체결 (봇↔봇은 PostgreSQL에서 30일 뒤 지워지므로 여기서도 받지 않는다).
CREATE TABLE mk_trades (
  trade_id          VARCHAR2(36) PRIMARY KEY,
  symbol            VARCHAR2(16) NOT NULL,
  price             NUMBER(12)   NOT NULL,
  qty               NUMBER(12)   NOT NULL,
  buyer_account_id  VARCHAR2(36) NOT NULL,
  seller_account_id VARCHAR2(36) NOT NULL,
  taker_side        VARCHAR2(4)  NOT NULL,
  traded_at         TIMESTAMP(3) NOT NULL
);
CREATE INDEX mk_trades_traded_at_ix ON mk_trades (traded_at);
CREATE INDEX mk_trades_symbol_ix ON mk_trades (symbol, traded_at);

-- 매도 체결별 실현손익.
CREATE TABLE mk_realized_pnl (
  trade_id    VARCHAR2(36) PRIMARY KEY,
  account_id  VARCHAR2(36) NOT NULL,
  symbol      VARCHAR2(16) NOT NULL,
  qty         NUMBER(12)   NOT NULL,
  price       NUMBER(12)   NOT NULL,
  cost_basis  NUMBER(19)   NOT NULL,
  realized    NUMBER(19)   NOT NULL,
  traded_at   TIMESTAMP(3) NOT NULL
);
CREATE INDEX mk_realized_account_ix ON mk_realized_pnl (account_id, traded_at);

-- 분 단위 자산 스냅샷 (사용자 계정). PostgreSQL 쪽은 7일/90일 뒤 압축되지만 여기엔 원본 1분 행이 남는다.
CREATE TABLE mk_equity_snapshots (
  account_id  VARCHAR2(36) NOT NULL,
  ts          TIMESTAMP(3) NOT NULL,
  cash        NUMBER(19)   NOT NULL,
  stock_value NUMBER(19)   NOT NULL,
  equity      NUMBER(19)   NOT NULL,
  CONSTRAINT mk_equity_pk PRIMARY KEY (account_id, ts)
);

-- 사용자 디렉터리 (닉네임·가입일). 랭킹·리포트 조인용. 비밀번호는 절대 오지 않는다.
CREATE TABLE mk_accounts (
  account_id  VARCHAR2(36) PRIMARY KEY,
  nickname    VARCHAR2(60) NOT NULL,
  is_bot      NUMBER(1)    DEFAULT 0 NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL
);

-- 예시 뷰: 사용자별 일별 실현손익
CREATE OR REPLACE VIEW mk_daily_realized AS
SELECT a.nickname,
       TRUNC(r.traded_at + INTERVAL '9' HOUR) AS kst_day,
       SUM(r.realized) AS realized,
       COUNT(*)        AS fills
FROM mk_realized_pnl r
JOIN mk_accounts a ON a.account_id = r.account_id
GROUP BY a.nickname, TRUNC(r.traded_at + INTERVAL '9' HOUR);
