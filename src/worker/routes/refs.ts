/**
 * Why a rule or override can't point at this category or account, or null if it can. A merged
 * account is hidden from the UI, so it counts as unknown; pickers hide archived categories.
 */
export async function checkRefs(db: D1Database, categoryId: number | undefined, accountId: number | null | undefined) {
  const [category, account] = await Promise.all([
    categoryId === undefined ? null : db.prepare("SELECT archived_at FROM categories WHERE id = ?1").bind(categoryId).first<{ archived_at: string | null }>(),
    accountId == null ? null : db.prepare("SELECT 1 FROM accounts WHERE id = ?1 AND merged_into_account_id IS NULL").bind(accountId).first(),
  ]);
  if ((categoryId !== undefined && !category) || (accountId != null && !account)) return { error: "not_found", status: 404 } as const;
  if (category?.archived_at) return { error: "category_archived", status: 409 } as const;
  return null;
}
