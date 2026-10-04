CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`ats` text NOT NULL,
	`token` text NOT NULL,
	`source` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_polled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_ats_token` ON `companies` (`ats`,`token`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_events_job` ON `job_events` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_job_id` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`location_text` text NOT NULL,
	`description` text NOT NULL,
	`apply_url` text NOT NULL,
	`ats` text,
	`ats_token` text,
	`comp_min` real,
	`comp_max` real,
	`comp_currency` text,
	`comp_period` text,
	`posted_at` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'discovered' NOT NULL,
	`filter_reason` text,
	`low_pay` integer DEFAULT false NOT NULL,
	`score_attempts` integer DEFAULT 0 NOT NULL,
	`notified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_key` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `llm_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`stage` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`model` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scores_job` ON `scores` (`job_id`);