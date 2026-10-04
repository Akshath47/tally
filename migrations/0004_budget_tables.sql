CREATE TABLE `categories` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text COLLATE NOCASE NOT NULL,
	`kind` text NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "categories_name_ck" CHECK("categories"."name" = trim("categories"."name") AND "categories"."name" <> ''),
	CONSTRAINT "categories_kind_ck" CHECK("categories"."kind" IN ('budgeted', 'tracked', 'excluded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_uq` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `category_budgets` (
	`category_id` integer NOT NULL,
	`effective_month` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`category_id`, `effective_month`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "category_budgets_effective_month_ck" CHECK(date("category_budgets"."effective_month" || '-01') IS "category_budgets"."effective_month" || '-01'),
	CONSTRAINT "category_budgets_amount_minor_ck" CHECK(typeof("category_budgets"."amount_minor") = 'integer' AND "category_budgets"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE `merchant_rules` (
	`id` integer PRIMARY KEY NOT NULL,
	`match_type` text NOT NULL,
	`pattern` text NOT NULL,
	`account_id` integer,
	`account_scope` integer GENERATED ALWAYS AS (coalesce("account_id", 0)) VIRTUAL NOT NULL,
	`category_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merchant_rules_pattern_ck" CHECK("merchant_rules"."pattern" = trim("merchant_rules"."pattern") AND "merchant_rules"."pattern" <> '' AND "merchant_rules"."pattern" = lower("merchant_rules"."pattern")),
	CONSTRAINT "merchant_rules_match_type_ck" CHECK("merchant_rules"."match_type" IN ('exact', 'contains'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_rules_scope_uq` ON `merchant_rules` (`match_type`,`pattern`,`account_scope`);--> statement-breakpoint
CREATE TABLE `monthly_budgets` (
	`effective_month` text PRIMARY KEY NOT NULL,
	`amount_minor` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "monthly_budgets_effective_month_ck" CHECK(date("monthly_budgets"."effective_month" || '-01') IS "monthly_budgets"."effective_month" || '-01'),
	CONSTRAINT "monthly_budgets_amount_minor_ck" CHECK(typeof("monthly_budgets"."amount_minor") = 'integer' AND "monthly_budgets"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE `transaction_overrides` (
	`transaction_id` integer PRIMARY KEY NOT NULL,
	`category_id` integer,
	`excluded` integer DEFAULT false NOT NULL,
	`counted_amount_minor` integer,
	`counted_date` text,
	`note` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transaction_overrides_excluded_ck" CHECK("transaction_overrides"."excluded" IN (0, 1)),
	CONSTRAINT "transaction_overrides_counted_amount_minor_ck" CHECK("transaction_overrides"."counted_amount_minor" IS NULL OR typeof("transaction_overrides"."counted_amount_minor") = 'integer'),
	CONSTRAINT "transaction_overrides_counted_date_ck" CHECK(date("transaction_overrides"."counted_date") IS "transaction_overrides"."counted_date"),
	CONSTRAINT "transaction_overrides_note_ck" CHECK("transaction_overrides"."note" IS NULL OR (typeof("transaction_overrides"."note") = 'text' AND length("transaction_overrides"."note") <= 500))
);
