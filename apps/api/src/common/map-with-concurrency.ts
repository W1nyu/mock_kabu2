/**
 * 결과 순서를 유지하며 최대 limit개씩만 동시에 실행한다. 종목·자산마다 쿼리를 한꺼번에 보내면
 * Prisma 커넥션 풀(운영 API 12)을 다 차지해 주문 같은 다른 요청이 줄을 서기 때문에 쓴다.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
