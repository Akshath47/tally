export { formatMoney, formatTimestamp } from "../worker/display";

/** What a transaction is called on screen; bank text is untrusted and rendered as text only. */
export const merchantLabel = (t: { merchant: string; description: string }) => t.merchant || t.description || "Unknown merchant";

