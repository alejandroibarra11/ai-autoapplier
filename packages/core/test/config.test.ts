import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, loadConfig } from '../src/config';
import { findRoot } from '../src/root';

describe('config', () => {
  it('loads the committed config.yaml', () => {
    const cfg = loadConfig(join(findRoot(), 'config.yaml'));
    expect(cfg.scoring.model).toBe('claude-haiku-4-5');
    expect(cfg.pay.rejectBelowHourly).toBe(40);
    expect(cfg.seedCompanies.length).toBeGreaterThan(5);
  });
  it('rejects an invalid regex with a clear message', () => {
    const text = readFileSync(join(findRoot(), 'config.yaml'), 'utf8')
      .replace('rejectPatterns:\n', 'rejectPatterns:\n    - "([unclosed"\n');
    expect(() => parseConfig(text)).toThrow(/invalid regex/i);
  });
  it('rejects pollIntervalHours outside 1..23', () => {
    const text = readFileSync(join(findRoot(), 'config.yaml'), 'utf8');
    expect(() => parseConfig(text.replace(/pollIntervalHours:\s*\d+/, 'pollIntervalHours: 24'))).toThrow();
    expect(() => parseConfig(text.replace(/pollIntervalHours:\s*\d+/, 'pollIntervalHours: 0'))).toThrow();
  });
  it('rejects missing sections', () => {
    expect(() => parseConfig('pollIntervalHours: 3')).toThrow();
  });
});
