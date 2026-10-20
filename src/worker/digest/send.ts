import { londonHour, londonToday, mondayOf } from "../importer/dates";
import type { Names } from "../insights/wording";
import { readDigest } from "./content";
import { renderDigestEmail } from "./email";

// Sends the weekly digest (docs/phase-2-insights-spec.md, Sending), only ever to ALLOWED_EMAIL:
// the verified destination Cloudflare delivers to for free. Logs carry status, duration and
// counts, never the email, its subject or the address.

/** Must match the digest cron in wrangler.jsonc. Cron is UTC; DIGEST_HOUR is London's. */
export const DIGEST_CRON = "0 17,18 * * SUN";
export const DIGEST_HOUR = 18;

// DIGEST_ENABLED is typed from wrangler.jsonc's current value; it's a switch, so any string.
export type DigestEnv = Pick<Env, "DB" | "DIGEST_EMAIL" | "DIGEST_FROM" | "APP_URL" | "ALLOWED_EMAIL"> & { DIGEST_ENABLED: string };
export type Delivery = { ok: true } | { ok: false; error: string };

async function readNames(db: D1Database): Promise<Names> {
  const [categories, accounts] = await Promise.all([
    db.prepare("SELECT id, name FROM categories").all<{ id: number; name: string }>(),
    db.prepare("SELECT id, name FROM accounts").all<{ id: number; name: string }>(),
  ]);
  const category = new Map(categories.results.map((r) => [r.id, r.name]));
  const account = new Map(accounts.results.map((r) => [r.id, r.name]));
  return {
    category: (id) => (id === null ? "Uncategorised" : (category.get(id) ?? "A category")),
    account: (id) => account.get(id) ?? "An account",
  };
}

/** An Email Service error's code (E_…), never its message, which can carry addresses. */
const errorCode = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" && /^E_[A-Z_]{1,60}$/.test(e.code) ? e.code : "unknown";

/**
 * Builds this week's digest and sends it to the owner. Never throws. A failure is the Email
 * Service's code, or `build_failed` when the digest couldn't be read or rendered.
 */
export async function deliverDigest(env: DigestEnv, now: Date, trigger: "cron" | "manual"): Promise<Delivery> {
  const started = Date.now();
  let counts = { insights: 0, categories: 0 };
  let result: Delivery;
  let email: ReturnType<typeof renderDigestEmail> | null = null;
  try {
    const [digest, names] = await Promise.all([readDigest(env.DB, now), readNames(env.DB)]);
    counts = { insights: digest.insights.length, categories: digest.categories.length };
    email = renderDigestEmail(digest, names, env.APP_URL);
    await env.DIGEST_EMAIL.send({ from: env.DIGEST_FROM, to: env.ALLOWED_EMAIL, ...email });
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: email === null ? "build_failed" : errorCode(e) };
  }
  console.log(JSON.stringify({ event: "digest_send", trigger, status: result.ok ? "sent" : "failed", error: result.ok ? undefined : result.error, durationMs: Date.now() - started, ...counts }));
  return result;
}

/**
 * A manual send that worked settles the latest week's row if it didn't (failed, or stuck
 * sending), so the app stops offering Send now. It never creates a row: that would be this
 * week's claim, and Sunday's cron would then skip.
 */
export async function settleLatestSend(db: D1Database, now: Date) {
  await db
    .prepare("UPDATE digest_sends SET status = 'sent', sent_at = ?1, error = NULL WHERE week_start = (SELECT max(week_start) FROM digest_sends) AND status <> 'sent'")
    .bind(now.toISOString())
    .run();
}

/** The Sunday cron: claims the week, then sends once, at 18:00 London. */
export async function runScheduledDigest(env: DigestEnv, now: Date) {
  if (env.DIGEST_ENABLED !== "true") return "disabled" as const;
  // The cron fires at 17:00 and 18:00 UTC; exactly one of them is 18:00 in London.
  if (londonHour(now) !== DIGEST_HOUR) return "not_send_hour" as const;
  const weekStart = mondayOf(londonToday(now));
  const claim = await env.DB.prepare("INSERT INTO digest_sends (week_start, status, attempted_at) VALUES (?1, 'sending', ?2) ON CONFLICT (week_start) DO NOTHING")
    .bind(weekStart, now.toISOString())
    .run();
  if (claim.meta.changes === 0) return "already_claimed" as const;
  const result = await deliverDigest(env, now, "cron");
  await env.DB.prepare("UPDATE digest_sends SET status = ?2, sent_at = ?3, error = ?4 WHERE week_start = ?1")
    .bind(weekStart, result.ok ? "sent" : "failed", result.ok ? new Date().toISOString() : null, result.ok ? null : result.error)
    .run();
  return result.ok ? ("sent" as const) : ("failed" as const);
}
