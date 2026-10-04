import type { FillPlan, FilledReport } from './types';

export function verifyFill(plan: FillPlan, report: FilledReport): string[] {
  const label = (id: string) => plan.entries.find((e) => e.fieldId === id)?.label ?? id;
  const out: string[] = [];
  for (const id of report.notFound) {
    const e = plan.entries.find((x) => x.fieldId === id);
    if (!e || e.required || e.source !== 'identity') out.push(`field not found: ${label(id)}`);
  }
  const reported = new Set([...report.filled, ...report.notFound, ...report.failed]);
  for (const e of plan.entries) if (e.source !== 'identity' && !reported.has(e.fieldId)) out.push(`field not reported: ${e.label}`);
  for (const id of report.failed) out.push(`could not set: ${label(id)}`);
  for (const l of report.requiredEmpty) out.push(`required field empty: ${l}`);
  return out;
}
