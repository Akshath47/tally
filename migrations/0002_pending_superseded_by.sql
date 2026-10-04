ALTER TABLE `transactions` ADD `superseded_by` integer REFERENCES transactions(id);--> statement-breakpoint
CREATE INDEX `transactions_superseded_by_idx` ON `transactions` (`superseded_by`);--> statement-breakpoint
-- Pending rows used to be retired as soon as Lunch Flow stopped returning them, but it returns
-- only one pending transaction per account. Count recent ones on imported accounts again; the
-- next import supersedes or expires them (src/worker/importer/pending.ts). Older ones stay
-- retired, since they would expire straight away.
UPDATE `transactions` SET `vanished_at` = NULL
WHERE `is_pending` = 1 AND `vanished_at` IS NOT NULL
  AND `first_seen_at` >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
  AND `account_id` IN (SELECT `id` FROM `accounts` WHERE `import_enabled` = 1);
