// Home's named lines beyond a single category (src/web/lines.ts), which
// GET /api/months/:month/transactions lists the rows of. One list, so the Worker, the SPA's routes
// and the dev mock can't disagree about which exist.

export const NAMED_LINES = ["misc", "uncategorised-pending", "posted", "pending"] as const;
export type NamedLine = (typeof NAMED_LINES)[number];

export const isNamedLine = (s: string): s is NamedLine => (NAMED_LINES as readonly string[]).includes(s);
