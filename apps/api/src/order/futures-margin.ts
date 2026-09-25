/**
 * 선물 때문에 쓸 수 없는 현금(원) = 포지션 위탁증거금 합계 + 미수금.
 *
 * 포지션 증거금은 계좌의 holdAmount가 아니라 account.futures_positions.margin_held에 둔다 — 손실이 나면
 * 잔액이 증거금보다 작아질 수 있는데(추가증거금 상황) 그것이 현물의 "묶음 ≤ 잔액" 불변식(DB 제약)을
 * 깨지 않게 하려는 분리다. 미수금은 손실이 잔액을 넘은 부분(account.futures_debts).
 *
 * 주문 가능 금액 = 잔액 − holdAmount − 이 값. 현물 주문·선물 주문·이체·계좌 조회가 모두 같은 식을 쓴다.
 */
interface FuturesReader {
  futuresPosition: {
    aggregate(args: {
      where: { accountId: string };
      _sum: { marginHeld: true };
    }): Promise<{ _sum: { marginHeld: bigint | null } }>;
  };
  futuresDebt: {
    findUnique(args: { where: { accountId: string } }): Promise<{ amount: bigint } | null>;
  };
}

export interface FuturesEncumbrance {
  margin: bigint;
  debt: bigint;
  total: bigint;
}

/** PrismaClient, 또는 계좌 락 안의 트랜잭션(concurrency TxLike — 모델 델리게이트가 인덱스 시그니처라 느슨하게 받는다) */
export async function futuresEncumbrance(
  db: FuturesReader | { [key: string]: any },
  accountId: string,
): Promise<FuturesEncumbrance> {
  const reader = db as FuturesReader;
  const [margin, debt] = await Promise.all([
    reader.futuresPosition.aggregate({ where: { accountId }, _sum: { marginHeld: true } }),
    reader.futuresDebt.findUnique({ where: { accountId } }),
  ]);
  const marginHeld = margin._sum.marginHeld ?? 0n;
  const owed = debt?.amount ?? 0n;
  return { margin: marginHeld, debt: owed, total: marginHeld + owed };
}

/** 주문 가능 금액 계산용 합계 */
export async function futuresMarginHeld(db: FuturesReader | { [key: string]: any }, accountId: string): Promise<bigint> {
  return (await futuresEncumbrance(db, accountId)).total;
}
