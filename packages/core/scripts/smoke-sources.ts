import { join } from 'node:path';
import { buildSources, findRoot, loadConfig, openDb, seedCompanies, listActiveCompanies } from '../src/index';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const db = openDb(':memory:');
seedCompanies(db, cfg);
for (const s of buildSources(cfg, listActiveCompanies(db))) {
  try {
    const jobs = await s.fetchJobs();
    const j = jobs[0];
    console.log(`OK   ${s.name.padEnd(40)} ${String(jobs.length).padStart(4)}  ${j ? `${j.company} | ${j.title} | ${j.locationText} | ${j.postedAt.toISOString()}` : ''}`);
  } catch (e) {
    console.log(`FAIL ${s.name.padEnd(40)} ${(e as Error).message}`);
  }
}
