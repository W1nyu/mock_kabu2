import { describe, expect, test } from "vitest";
import { advancesWatermark, conditionMet, describeCondition, inferTriggerDirection, trailingTrigger } from "@mock-kabu/shared";

describe("conditional order trigger rules", () => {
  test("AT_OR_ABOVE fires at the boundary and above, never below", () => {
    expect(conditionMet("AT_OR_ABOVE", 1_000, 999)).toBe(false);
    expect(conditionMet("AT_OR_ABOVE", 1_000, 1_000)).toBe(true);
    expect(conditionMet("AT_OR_ABOVE", 1_000, 1_500)).toBe(true);
  });

  test("AT_OR_BELOW fires at the boundary and below, never above", () => {
    expect(conditionMet("AT_OR_BELOW", 1_000, 1_001)).toBe(false);
    expect(conditionMet("AT_OR_BELOW", 1_000, 1_000)).toBe(true);
    expect(conditionMet("AT_OR_BELOW", 1_000, 10)).toBe(true);
  });

  test("infers the direction from where the trigger sits against the reference price", () => {
    expect(inferTriggerDirection(1_100, 1_000, "SELL")).toBe("AT_OR_ABOVE");
    expect(inferTriggerDirection(900, 1_000, "SELL")).toBe("AT_OR_BELOW");
    // 같은 값: 매도는 손절, 매수는 돌파
    expect(inferTriggerDirection(1_000, 1_000, "SELL")).toBe("AT_OR_BELOW");
    expect(inferTriggerDirection(1_000, 1_000, "BUY")).toBe("AT_OR_ABOVE");
  });

  test("labels the four intents", () => {
    expect(describeCondition("AT_OR_BELOW", "SELL")).toBe("손절 매도");
    expect(describeCondition("AT_OR_ABOVE", "SELL")).toBe("익절 매도");
    expect(describeCondition("AT_OR_ABOVE", "BUY")).toBe("돌파 매수");
    expect(describeCondition("AT_OR_BELOW", "BUY")).toBe("눌림 매수");
  });
});

describe("trailing stop rules", () => {
  test("sell trigger trails the high-water mark downward, floored to an integer", () => {
    expect(trailingTrigger("SELL", 10_000, 300)).toBe(9_700);
    expect(trailingTrigger("SELL", 10_001, 300)).toBe(9_700); // 9700.97 → 내림
  });

  test("buy trigger trails the low-water mark upward, ceiled to an integer", () => {
    expect(trailingTrigger("BUY", 10_000, 250)).toBe(10_250);
    expect(trailingTrigger("BUY", 9_999, 250)).toBe(10_249); // 10248.975 → 올림
  });

  test("only a new extreme moves the watermark", () => {
    expect(advancesWatermark("SELL", 10_000, 10_001)).toBe(true);
    expect(advancesWatermark("SELL", 10_000, 10_000)).toBe(false);
    expect(advancesWatermark("SELL", 10_000, 9_000)).toBe(false);
    expect(advancesWatermark("BUY", 10_000, 9_999)).toBe(true);
    expect(advancesWatermark("BUY", 10_000, 11_000)).toBe(false);
  });
});
