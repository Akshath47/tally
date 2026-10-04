-- P1.7 acceptance queries. Prints ids, times, counts and amounts only, never merchant or
-- description text. Run after the hourly cron has had 24 hours:
--   npx wrangler d1 execute DB --remote --json --command="$(grep -v '^--' scripts/cron-report.sql)"
-- Not --file: against the remote database that returns only execution stats, no rows.
-- The comment lines are stripped because wrangler would read a leading "--" as a flag.

-- 1. Cron runs in the last 24 hours. Expect ~24 rows, gap_min ~60, status 'success'.
SELECT id, started_at, status, error_summary,
       round((julianday(started_at) - julianday(lag(started_at) OVER (ORDER BY started_at))) * 1440) AS gap_min,
       round((julianday(finished_at) - julianday(started_at)) * 86400, 1) AS duration_s
FROM import_runs
WHERE trigger = 'cron' AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
ORDER BY started_at;

-- 2. Overlapping runs in the same window (cron or manual). Expect no rows. Runs that lost the
-- lease (skipped_locked) never imported, and abandoned runs are closed late by design.
WITH r AS (
  SELECT id, trigger, started_at, coalesce(finished_at, '9999') AS finished_at
  FROM import_runs
  WHERE status != 'skipped_locked' AND error_summary IS NOT 'abandoned'
)
SELECT a.id AS run_a, a.trigger AS trigger_a, b.id AS run_b, b.trigger AS trigger_b
FROM r a
JOIN r b ON b.id > a.id
WHERE a.started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
  AND b.started_at < a.finished_at AND a.started_at < b.finished_at;

-- 3. Duplicates by (account_id, provider_txn_id). Expect 0.
SELECT count(*) AS duplicate_keys
FROM (SELECT 1 FROM transactions GROUP BY account_id, provider_txn_id HAVING count(*) > 1);

-- 4. Same fingerprint (account, date, amount, text) under more than one provider id.
-- live = 1 is a pending row retired by its posted version; live >= 2 is either two genuinely
-- identical purchases or an id change counted twice. first_runs = 1 means one response held
-- both, so Lunch Flow itself lists them as separate; first_runs >= 2 with live >= 2 is the
-- suspicious case, so check those ids against the bank app.
SELECT account_id, txn_date, amount_minor, count(*) AS n, sum(is_pending) AS pending,
       sum(vanished_at IS NULL) AS live, count(DISTINCT first_import_run_id) AS first_runs,
       group_concat(id) AS ids
FROM transactions
GROUP BY fingerprint
HAVING count(*) > 1
ORDER BY live > 1 AND first_runs > 1 DESC, live DESC, txn_date DESC;
