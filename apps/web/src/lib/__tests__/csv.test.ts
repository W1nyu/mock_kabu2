import { describe, expect, test } from "vitest";
import { toCsv } from "../csv";

describe("toCsv", () => {
  test("starts with a BOM and joins rows with newlines", () => {
    const csv = toCsv(["a", "b"], [[1, "x"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe("a,b\n1,x");
  });

  test("quotes values containing commas, quotes or newlines", () => {
    const csv = toCsv(["v"], [['say "hi", ok'], ["line\nbreak"], [null]]);
    expect(csv.slice(1).split("\n").slice(1)).toEqual(['"say ""hi"", ok"', '"line', 'break"', ""]);
  });
});
