import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot } from '../src/index';
import { getJson } from '../src/http';
import { CANDIDATES } from './company-candidates';

type Ats = 'greenhouse' | 'lever' | 'ashby';

const PROBES: { ats: Ats; url: (t: string) => string; count: (body: unknown) => number }[] = [
  { ats: 'greenhouse', url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`, count: (b) => (b as { jobs?: unknown[] }).jobs?.length ?? 0 },
  { ats: 'lever', url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`, count: (b) => (Array.isArray(b) ? b.length : 0) },
  { ats: 'ashby', url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`, count: (b) => (b as { jobs?: unknown[] }).jobs?.length ?? 0 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const yaml = readFileSync(join(findRoot(), 'config.yaml'), 'utf8');
const existing = new Set([...yaml.matchAll(/token:\s*([^\s,}]+)/g)].map((m) => m[1]!.toLowerCase()));

let tried = 0;
const verified: string[] = [];
for (const c of CANDIDATES) {
  let found = false;
  for (const token of c.tokens) {
    if (found) break;
    if (existing.has(token.toLowerCase())) { found = true; break; }
    for (const p of PROBES) {
      tried++;
      try {
        const n = p.count(await getJson(p.url(token)));
        if (n >= 1) {
          verified.push(`  - { ats: ${p.ats}, token: ${token}, name: ${c.name.includes(':') || c.name.includes('&') ? JSON.stringify(c.name) : c.name} }  # ${n} jobs`);
          found = true;
          break;
        }
      } catch { /* 404 / invalid JSON / timeout = miss */ }
      await sleep(300);
    }
  }
}
console.log(verified.join('\n'));
console.log(`verified ${verified.length} / tried ${tried}`);
