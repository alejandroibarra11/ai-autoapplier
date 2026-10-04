export interface EvalRow {
  jobId: number;
  label: 'eligible' | 'ineligible';
  predicted: 'eligible' | 'likely' | 'unlikely' | 'ineligible';
}

export function computeEligibilityMetrics(rows: EvalRow[]) {
  const falsePositives: number[] = [];
  const falseNegatives: number[] = [];
  let correct = 0;
  for (const r of rows) {
    const positive = r.predicted === 'eligible' || r.predicted === 'likely';
    if (positive === (r.label === 'eligible')) correct++;
    else if (positive) falsePositives.push(r.jobId);
    else falseNegatives.push(r.jobId);
  }
  return { n: rows.length, accuracy: rows.length ? correct / rows.length : 0, falsePositives, falseNegatives };
}
