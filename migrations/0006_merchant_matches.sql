CREATE TABLE `merchant_matches` (
	`account_id` integer NOT NULL,
	`merchant` text NOT NULL,
	`merchant_key` text GENERATED ALWAYS AS (lower(trim("merchant"))) VIRTUAL NOT NULL,
	`rule_id` integer,
	PRIMARY KEY(`account_id`, `merchant`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`) REFERENCES `merchant_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `merchant_matches_rule_idx` ON `merchant_matches` (`rule_id`);--> statement-breakpoint
CREATE INDEX `merchant_matches_key_idx` ON `merchant_matches` (`merchant_key`);--> statement-breakpoint
CREATE INDEX `transaction_overrides_counted_date_idx` ON `transaction_overrides` (`counted_date`) WHERE "transaction_overrides"."counted_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `transactions_account_merchant_idx` ON `transactions` (`account_id`,`merchant`);--> statement-breakpoint
CREATE INDEX `transactions_txn_date_idx` ON `transactions` (`txn_date`);