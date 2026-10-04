import type { Page } from 'playwright';
import type { ApplyTarget } from '../apply/types';

export type IdentityKey = 'firstName' | 'lastName' | 'fullName' | 'email' | 'phone' | 'country' | 'location' | 'linkedin' | 'github' | 'portfolio' | 'currentCompany' | 'resume' | 'coverLetter';
export type EntryKind = 'text' | 'textarea' | 'select' | 'multiselect' | 'choice' | 'checkbox' | 'file';
export type EntrySource = 'identity' | 'answers' | 'draft' | 'fill_time' | 'decline';
export interface FillEntry { fieldId: string; label: string; kind: EntryKind; value: string; source: EntrySource; required: boolean; options?: string[] }
export interface FillPlan { entries: FillEntry[]; missingRequired: { fieldId: string; label: string }[]; manualReasons: string[] }
export interface FilledReport { filled: string[]; notFound: string[]; failed: string[]; requiredEmpty: string[] }
export interface SubmitOutcome { kind: 'confirmed' | 'captcha' | 'error' | 'unknown'; evidence: string }
export interface AtsFiller {
  kind: 'greenhouse' | 'lever' | 'ashby';
  formUrl(target: ApplyTarget): string;
  fill(page: Page, plan: FillPlan): Promise<FilledReport>;
  submit(page: Page, timeoutMs: number): Promise<SubmitOutcome>;
}
export type SubmissionResult = 'filled' | 'blocked' | 'dry_run' | 'submitted' | 'failed' | 'cancelled';
