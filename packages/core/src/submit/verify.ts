import type { FillPlan, FilledReport } from './types';

export function verifyFill(plan: FillPlan, report: FilledReport): string[] {
  const label = (id: string) => plan.entries.find((e) => e.fieldId === id)?.label ?? id;
  const out: string[] = [];
  for (const id of report.notFound) {
    const e = plan.entries.find((x) => x.fieldId === id);
    if (!e || e.required || e.source !== 'identity') out.push(`field not found: ${label(id)}`);
  }
  for (const id of report.failed) out.push(`could not set: ${label(id)}`);
  for (const l of report.requiredEmpty) out.push(`required field empty: ${l}`);
  return out;
}
