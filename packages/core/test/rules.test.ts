import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { applyRules, toHourly } from '../src/filter/rules';
import { runFilter } from '../src/pipeline/filter';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import { makeJob, testDb } from './helpers';
import { getJob, insertJobs, listJobsByStatus } from '../src/db/repo';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const now = new Date('2026-10-03T00:00:00Z');
const ok = (o: Parameters<typeof makeJob>[0] = {}) => applyRules(makeJob({ postedAt: new Date('2026-10-02T00:00:00Z'), ...o }), cfg, now);

describe('toHourly', () => {
  it('converts periods', () => {
    expect(toHourly(104000, 'year')).toBe(50);
    expect(toHourly(8000, 'month')).toBeCloseTo(46.15, 2);
    expect(toHourly(60, 'hour')).toBe(60);
  });
});

describe('applyRules', () => {
  it('passes a good LATAM AI job', () => expect(ok()).toEqual({ pass: true, reason: null, lowPay: false }));

  it('title include / exclude use whole words', () => {
    expect(ok({ title: 'Account Executive' }).reason).toMatch(/^title/);
    expect(ok({ title: 'Engineering Manager, LLM Platform' }).reason).toMatch(/^title: excluded "manager"/);
    expect(ok({ title: 'Junior Full-Stack Developer' }).reason).toMatch(/^title: excluded "junior"/);
    expect(ok({ title: 'Senior Full-Stack Engineer' }).pass).toBe(true);
    expect(ok({ title: 'Staff LLM Platform Engineer' }).pass).toBe(true);
    expect(ok({ title: 'Agentic Systems Engineer' }).pass).toBe(true);
  });

  it('rejects old postings', () => {
    expect(ok({ postedAt: new Date('2026-09-20T00:00:00Z') }).reason).toMatch(/^age/);
  });

  it('rejects invalid postedAt dates', () => {
    expect(ok({ postedAt: new Date('nope') }).reason).toBe('age: invalid postedAt');
  });

  it('rejects explicit US authorization requirements', () => {
    const r = ok({ description: 'Candidates must be authorized to work in the United States without sponsorship.' });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^eligibility/);
    expect(ok({ description: 'This is a W2 only position.' }).pass).toBe(false);
    expect(ok({ description: 'Requires active security clearance.' }).pass).toBe(false);
  });

  it('rejects US-only locations unless an allowed region is mentioned', () => {
    expect(ok({ locationText: 'Remote - US', description: 'Great team.' }).reason).toMatch(/^location/);
    expect(ok({ locationText: 'United States', description: 'Great team.' }).reason).toMatch(/^location/);
    expect(ok({ locationText: 'San Francisco, CA; New York, NY', description: 'Great team.' }).reason).toMatch(/^location/);
    expect(ok({ locationText: 'Remote - US', description: 'We also hire contractors in LATAM.' }).pass).toBe(true);
    expect(ok({ locationText: 'Remote (US); Remote (Mexico)', description: 'x' }).pass).toBe(true);
    expect(ok({ locationText: 'Remote', description: 'Great team.' }).pass).toBe(true);
    expect(ok({ locationText: '', description: 'Great team.' }).pass).toBe(true);
  });

  it('applies the USD pay floor and low-pay flag', () => {
    expect(ok({ compMax: 70000, compCurrency: 'USD', compPeriod: 'year' }).reason).toMatch(/^pay/);
    expect(ok({ compMin: 35, compMax: 45, compCurrency: 'USD', compPeriod: 'hour' })).toEqual({ pass: true, reason: null, lowPay: true });
    expect(ok({ compMin: 120000, compMax: 160000, compCurrency: 'USD', compPeriod: 'year' }).lowPay).toBe(false);
  });

  it('ignores the USD floor for other currencies and missing pay', () => {
    expect(ok({ compMax: 800000, compCurrency: 'INR', compPeriod: 'year' }).pass).toBe(true);
    expect(ok({ compMax: 30000, compCurrency: 'MXN', compPeriod: 'month' }).pass).toBe(true);
    expect(ok({ compMax: null, compCurrency: null, compPeriod: null }).pass).toBe(true);
  });
});

describe('runFilter', () => {
  it('moves discovered jobs to passed_rules or filtered_out with reason', () => {
    const db = testDb();
    insertJobs(db, [
      makeJob({ title: 'Senior AI Engineer', postedAt: new Date('2026-10-02T00:00:00Z') }),
      makeJob({ title: 'Sales Director', postedAt: new Date('2026-10-02T00:00:00Z') }),
    ]);
    expect(runFilter(db, cfg, now)).toEqual({ passed: 1, rejected: 1 });
    const [rejected] = listJobsByStatus(db, ['filtered_out']);
    expect(getJob(db, rejected!.id)!.filterReason).toMatch(/^title/);
    expect(runFilter(db, cfg, now)).toEqual({ passed: 0, rejected: 0 });
  });
});
