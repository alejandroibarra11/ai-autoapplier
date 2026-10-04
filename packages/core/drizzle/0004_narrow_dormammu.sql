CREATE TABLE `submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`plan` text NOT NULL,
	`fill_shot` text,
	`submit_shot` text,
	`dry_run` integer DEFAULT true NOT NULL,
	`result` text NOT NULL,
	`evidence` text,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	`notified_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submissions_job` ON `submissions` (`job_id`);