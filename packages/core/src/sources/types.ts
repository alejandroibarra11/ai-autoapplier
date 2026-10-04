import type { NormalizedJob } from '../types';

export interface Source {
  name: string;
  companyId?: number; // set for per-company ATS sources (deactivated on 404)
  fetchJobs(): Promise<NormalizedJob[]>;
}
