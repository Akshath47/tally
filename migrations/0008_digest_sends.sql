CREATE TABLE `digest_sends` (
	`week_start` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`attempted_at` text NOT NULL,
	`sent_at` text,
	`error` text,
	CONSTRAINT "digest_sends_status_ck" CHECK("digest_sends"."status" IN ('sending', 'sent', 'failed'))
);
