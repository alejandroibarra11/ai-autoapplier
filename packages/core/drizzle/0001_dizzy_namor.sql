DROP INDEX `jobs_dedupe_key`;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_source_job` ON `jobs` (`source`,`source_job_id`);--> statement-breakpoint
CREATE INDEX `jobs_dedupe_key` ON `jobs` (`dedupe_key`);