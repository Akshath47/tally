ALTER TABLE `transactions` ADD `superseded_by` integer REFERENCES transactions(id);--> statement-breakpoint
-- Pending rows used to be retired as soon as Lunch Flow stopped returning them, but it returns
-- only one pending transaction per account. Count them again; the next import supersedes or
-- expires them under the new rule (src/worker/importer/pending.ts).
UPDATE `transactions` SET `vanished_at` = NULL WHERE `is_pending` = 1 AND `vanished_at` IS NOT NULL;
