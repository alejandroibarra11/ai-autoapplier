import { describe, it, expect } from 'vitest';
import { computeEligibilityMetrics } from '../src/eval/metrics';

describe('computeEligibilityMetrics', () => {
  it('treats eligible/likely as positive and reports errors', () => {
    const m = computeEligibilityMetrics([
      { jobId: 1, label: 'eligible', predicted: 'eligible' },
      { jobId: 2, label: 'eligible', predicted: 'unlikely' },
      { jobId: 3, label: 'ineligible', predicted: 'likely' },
      { jobId: 4, label: 'ineligible', predicted: 'ineligible' },
    ]);
    expect(m).toEqual({ n: 4, accuracy: 0.5, falsePositives: [3], falseNegatives: [2] });
  });
  it('handles empty input', () => {
    expect(computeEligibilityMetrics([])).toEqual({ n: 0, accuracy: 0, falsePositives: [], falseNegatives: [] });
  });
});
