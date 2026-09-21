import { describe, expect, test } from "vitest";
import { conditionMet, describeCondition, inferTriggerDirection } from "@mock-kabu/shared";

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
