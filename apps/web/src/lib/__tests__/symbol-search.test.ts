import { describe, expect, it } from "vitest";
import { matchStockCodes, searchSymbols } from "../symbol-search";

const codes = (q: string) => searchSymbols(q).map((r) => r.code);

describe("searchSymbols", () => {
  it("finds by code, case-insensitive, exact match first", () => {
    expect(codes("kabu")[0]).toBe("KABU");
    expect(codes("KABU")).toContain("KABUF");
    expect(codes("goldf")).toEqual(["GOLDF"]);
  });

  it("finds by Korean, English and Japanese names", () => {
    expect(codes("다온")).toEqual(["DAON"]);
    expect(codes("semiconductor")).toEqual(["DAON"]);
    expect(codes("ダオン")).toEqual(["DAON"]);
    expect(codes("금")).toContain("GOLD");
    expect(codes("원/달러")).toEqual(expect.arrayContaining(["USDKRW", "USDF"]));
  });

  it("finds by Korean initial consonants", () => {
    expect(codes("ㄷㅇㅂ")).toEqual(["DAON"]);
    expect(codes("ㅅㅋㄹ")).toContain("SAKU");
  });

  it("links each kind to its own screen and skips delisted symbols", () => {
    const [stock] = searchSymbols("NEKO");
    expect(stock.href).toBe("/symbol/NEKO");
    expect(searchSymbols("CORNF")[0].href).toBe("/futures/CORNF");
    expect(searchSymbols("COPPER")[0].href).toBe("/reference/COPPER");
    expect(codes("MOCK")).toEqual([]);
    expect(codes("   ")).toEqual([]);
  });
});

describe("matchStockCodes", () => {
  it("returns null for an empty query so the list is not filtered", () => {
    expect(matchStockCodes("")).toBeNull();
    expect(matchStockCodes("  ")).toBeNull();
  });

  it("matches only spot stocks by code, names and initials", () => {
    expect([...matchStockCodes("kabu")!]).toEqual(["KABU"]);
    expect([...matchStockCodes("ㄷㅇㅂ")!]).toEqual(["DAON"]);
    expect([...matchStockCodes("goldf")!]).toEqual([]);
    expect([...matchStockCodes("MOCK")!]).toEqual([]);
  });
});
