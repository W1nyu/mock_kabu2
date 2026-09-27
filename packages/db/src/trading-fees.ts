/** Resolve the authoritative bot flag, including dedicated liquidity accounts. */
export async function isTradingFeeExempt(
  db: { $queryRawUnsafe(query: string, ...values: any[]): PromiseLike<unknown> },
  accountId: string,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe(
    'SELECT u.is_bot AS "isBot" FROM account.accounts a JOIN auth.users u ON u.id = a.user_id WHERE a.id = $1',
    accountId,
  ) as { isBot: boolean }[];
  if (rows.length !== 1) throw new Error(`Fee account not found: ${accountId}`);
  return rows[0].isBot;
}
