/** `/market/sparks` 응답에서 숫자가 아닌 값을 걸러 종목별 종가 배열로 만든다. */
export function cleanSparks(data: Record<string, unknown>): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [symbol, values] of Object.entries(data ?? {})) {
    result[symbol] = Array.isArray(values) ? values.map(Number).filter((v) => Number.isFinite(v)) : [];
  }
  return result;
}
