import type { Config } from '../config';
import type { CompPeriod, NormalizedJob } from '../types';
import { normalizeKey } from '../text';

export interface RuleResult { pass: boolean; reason: string | null; lowPay: boolean }

const HOURS_PER_YEAR = 2080;
const PLACEHOLDER_LOCATIONS = /^(remote|hybrid|on-?site|in office|anywhere)?$/i;

export function toHourly(value: number, period: CompPeriod): number {
  if (period === 'hour') return value;
  if (period === 'month') return (value * 12) / HOURS_PER_YEAR;
  return value / HOURS_PER_YEAR;
}

function hasWord(haystack: string, term: string): boolean {
  return ` ${haystack} `.includes(` ${normalizeKey(term)} `);
}

const reject = (reason: string): RuleResult => ({ pass: false, reason, lowPay: false });

export function applyRules(job: NormalizedJob, cfg: Config, now = new Date()): RuleResult {
  const title = normalizeKey(job.title);
  if (!cfg.roles.titleInclude.some((t) => hasWord(title, t))) return reject('title: no include match');
  const excluded = cfg.roles.titleExclude.find((t) => hasWord(title, t));
  if (excluded) return reject(`title: excluded "${excluded}"`);

  const ageDays = (now.getTime() - job.postedAt.getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays)) return reject('age: invalid postedAt');
  if (ageDays > cfg.maxAgeDays) return reject(`age: ${Math.floor(ageDays)} days old`);

  const fullText = `${job.locationText}\n${job.description}`;
  const hit = cfg.eligibility.rejectPatterns.find((p) => new RegExp(p, 'i').test(fullText));
  if (hit) return reject(`eligibility: matched /${hit}/`);

  const segments = job.locationText.split(/[;|·]/).map((s) => s.trim().toLowerCase()).filter((s) => !PLACEHOLDER_LOCATIONS.test(s));
  const usOnly = segments.length > 0 && segments.every((seg) =>
    cfg.eligibility.usOnlyLocationPatterns.some((p) => new RegExp(p, 'i').test(seg)));
  const allowed = cfg.eligibility.allowedRegionPatterns.some((p) => new RegExp(p, 'i').test(fullText))
    || cfg.eligibility.allowedLocationOnlyPatterns.some((p) => new RegExp(p, 'i').test(job.locationText));
  if (usOnly && !allowed) return reject(`location: US only (${job.locationText})`);

  let lowPay = false;
  const pay = job.compMax ?? job.compMin;
  if (pay !== null && job.compPeriod && job.compCurrency?.toUpperCase() === 'USD') {
    const hourly = toHourly(pay, job.compPeriod);
    if (hourly < cfg.pay.rejectBelowHourly) return reject(`pay: ~$${hourly.toFixed(0)}/hr`);
    lowPay = hourly < cfg.pay.lowPriorityBelowHourly;
  }
  return { pass: true, reason: null, lowPay };
}
