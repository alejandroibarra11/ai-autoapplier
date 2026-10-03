import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index';

describe('core', () => {
  it('loads', () => expect(VERSION).toBe('0.1.0'));
});
