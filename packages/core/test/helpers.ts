import type { NormalizedJob } from '../src/types';
import { openDb } from '../src/db/client';

let seq = 0;
export function makeJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  seq += 1;
  return {
    source: 'greenhouse',
    sourceJobId: String(seq),
    company: 'Acme',
    title: `Senior AI Engineer ${seq}`,
    locationText: 'Remote - LATAM',
    description: 'We hire contractors anywhere in Latin America. TypeScript, LLMs, RAG.',
    applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${seq}`,
    ats: 'greenhouse',
    atsToken: 'acme',
    compMin: null,
    compMax: null,
    compCurrency: null,
    compPeriod: null,
    postedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

export function testDb() {
  return openDb(':memory:');
}
