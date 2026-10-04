import type { Db } from '../db/client';
import type { Config } from '../config';
import { listJobsByStatus, setStatus } from '../db/repo';
import { applyRules } from '../filter/rules';

export function runFilter(db: Db, cfg: Config, now = new Date()): { passed: number; rejected: number } {
  let passed = 0;
  let rejected = 0;
  for (const job of listJobsByStatus(db, ['discovered'], 100_000)) {
    const r = applyRules(job, cfg, now);
    if (r.pass) { setStatus(db, job.id, 'passed_rules', null, { lowPay: r.lowPay }, now); passed++; }
    else { setStatus(db, job.id, 'filtered_out', r.reason, { filterReason: r.reason }, now); rejected++; }
  }
  return { passed, rejected };
}
