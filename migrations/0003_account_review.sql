-- The CHECKs are inline, added by hand: a table-level check() in schema.ts would make
-- drizzle-kit rebuild `accounts`, which `transactions` references. SQLite tests inline
-- CHECKs on ADD COLUMN against existing rows.
ALTER TABLE `accounts` ADD `backfill_floor_date` text CHECK (`backfill_floor_date` IS NULL OR date(`backfill_floor_date`) IS `backfill_floor_date`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `needs_review` integer DEFAULT false NOT NULL CHECK (`needs_review` IN (0, 1));--> statement-breakpoint
ALTER TABLE `accounts` ADD `merged_into_account_id` integer REFERENCES accounts(id);
