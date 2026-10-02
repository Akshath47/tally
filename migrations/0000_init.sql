CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`provider_connection_id` text,
	`name` text NOT NULL,
	`institution_name` text,
	`currency` text,
	`provider_status` text NOT NULL,
	`balance_minor` integer,
	`balance_fetched_at` text,
	`import_enabled` integer NOT NULL,
	`last_seen_in_provider_at` text,
	`last_import_attempt_at` text,
	`last_import_success_at` text,
	`last_import_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_data_change_at` text,
	`newest_txn_date` text,
	`backfill_cursor_date` text,
	`backfill_complete` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "accounts_provider_ck" CHECK("accounts"."provider" IN ('lunchflow')),
	CONSTRAINT "accounts_balance_minor_ck" CHECK("accounts"."balance_minor" IS NULL OR typeof("accounts"."balance_minor") = 'integer'),
	CONSTRAINT "accounts_import_enabled_ck" CHECK("accounts"."import_enabled" IN (0, 1)),
	CONSTRAINT "accounts_backfill_complete_ck" CHECK("accounts"."backfill_complete" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_uq` ON `accounts` (`provider`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `import_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder_run_id` integer,
	`expires_at` text,
	FOREIGN KEY (`holder_run_id`) REFERENCES `import_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_lock_single_row_ck" CHECK("import_lock"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `import_run_accounts` (
	`run_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`window_from` text,
	`window_to` text,
	`fetched` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`vanished_marked` integer DEFAULT 0 NOT NULL,
	`error` text,
	`duration_ms` integer,
	PRIMARY KEY(`run_id`, `account_id`),
	FOREIGN KEY (`run_id`) REFERENCES `import_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`error_summary` text,
	CONSTRAINT "import_runs_trigger_ck" CHECK("import_runs"."trigger" IN ('cron', 'manual')),
	CONSTRAINT "import_runs_status_ck" CHECK("import_runs"."status" IN ('running', 'success', 'partial', 'failed', 'skipped_locked'))
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`provider_txn_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`provider_amount` text NOT NULL,
	`currency` text NOT NULL,
	`txn_date` text NOT NULL,
	`merchant` text NOT NULL,
	`description` text NOT NULL,
	`is_pending` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`vanished_at` text,
	`updated_at` text NOT NULL,
	`first_import_run_id` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_import_run_id`) REFERENCES `import_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_amount_minor_ck" CHECK(typeof("transactions"."amount_minor") = 'integer'),
	CONSTRAINT "transactions_txn_date_ck" CHECK(date("transactions"."txn_date") IS "transactions"."txn_date"),
	CONSTRAINT "transactions_is_pending_ck" CHECK("transactions"."is_pending" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_account_provider_txn_uq` ON `transactions` (`account_id`,`provider_txn_id`);--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`txn_date`);--> statement-breakpoint
CREATE INDEX `transactions_fingerprint_idx` ON `transactions` (`fingerprint`);