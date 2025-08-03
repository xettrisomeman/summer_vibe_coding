CREATE TABLE `daily_digests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`digest_date` text NOT NULL,
	`trending_claims` text,
	`summary` text,
	`generated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_digests_digest_date_unique` ON `daily_digests` (`digest_date`);--> statement-breakpoint
CREATE TABLE `fact_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`claim_text` text NOT NULL,
	`verification_status` text NOT NULL,
	`confidence_score` real,
	`sources` text,
	`reasoning` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webpage_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`summary` text,
	`claims_extracted` text,
	`overall_credibility` text,
	`fact_check_results` text,
	`analyzed_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webpage_analyses_url_unique` ON `webpage_analyses` (`url`);