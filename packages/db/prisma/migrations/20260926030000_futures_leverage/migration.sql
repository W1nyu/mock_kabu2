-- 선물 레버리지: 계좌·종목마다 1~20배. NULL이면 상품의 거래소 기준 증거금률을 쓴다.
-- 포지션·미체결 주문이 없을 때만 바꿀 수 있다(API가 검사). 포지션이 없어도 설정만 담는 행(qty 0)을 둔다.
ALTER TABLE "account"."futures_positions" ADD COLUMN "leverage" INTEGER;
ALTER TABLE "account"."futures_positions"
  ADD CONSTRAINT "futures_positions_leverage_check" CHECK ("leverage" IS NULL OR ("leverage" BETWEEN 1 AND 20));
