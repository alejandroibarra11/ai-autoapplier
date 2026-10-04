CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`model` text NOT NULL,
	`cover_letter` text NOT NULL,
	`answers` text NOT NULL,
	`questions` text NOT NULL,
	`cv_selection` text NOT NULL,
	`cv_pdf_path` text,
	`flags` text NOT NULL,
	`edited_by_user` integer DEFAULT false NOT NULL,
	`notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `drafts_job` ON `drafts` (`job_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `resolved_apply_url` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `resolved_kind` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `draft_attempts` integer DEFAULT 0 NOT NULL;