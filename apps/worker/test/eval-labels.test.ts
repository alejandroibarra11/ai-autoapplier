import { describe, it, expect } from 'vitest';
import { parseEvalLabels } from '../src/eval-labels';

describe('parseEvalLabels', () => {
  it('keeps eligible/ineligible rows, ignores unlabeled ones and reports invalid rows', () => {
    const text = [
      '{"jobId":1,"label":"eligible"}',
      '{"jobId":2,"label":null}',
      '{"jobId":3,"label":"ineligible"}',
      '{"jobId":4,"label":"Eligible"}',
      '{"jobId":5,"label":"maybe"}',
      'not json',
      '{"label":"eligible"}',
      '',
    ].join('\n');
    const r = parseEvalLabels(text);
    expect(r.rows).toEqual([{ jobId: 1, label: 'eligible' }, { jobId: 3, label: 'ineligible' }]);
    expect(r.unlabeled).toBe(1);
    expect(r.invalid.map((i) => i.line)).toEqual([4, 5, 6, 7]);
    expect(r.invalid[0]!.reason).toMatch(/label/);
    expect(r.invalid[2]!.reason).toMatch(/json/i);
    expect(r.invalid[3]!.reason).toMatch(/jobId/);
  });
});
