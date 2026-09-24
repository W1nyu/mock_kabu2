-- 관리자 시장 시나리오: 기간 동안 특정 종목의 상승/하방 압력을 강화한다 (봇 전용, 비공개).
CREATE TABLE "market"."scenarios" (
  "id" TEXT NOT NULL,
  "symbols" TEXT[] NOT NULL,
  "direction" TEXT NOT NULL,
  "intensity" INTEGER NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "created_by" TEXT NOT NULL,
  "canceled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scenarios_direction_check" CHECK ("direction" IN ('UP', 'DOWN')),
  CONSTRAINT "scenarios_intensity_check" CHECK ("intensity" BETWEEN 1 AND 3),
  CONSTRAINT "scenarios_window_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "scenarios_symbols_check" CHECK (cardinality("symbols") > 0)
);

CREATE INDEX "scenarios_ends_at_idx" ON "market"."scenarios"("ends_at");
