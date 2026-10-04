import type { AtsFiller } from '../types';
import { greenhouseFiller } from './greenhouse';

export function fillerFor(kind: string): AtsFiller | null {
  return kind === 'greenhouse' ? greenhouseFiller : null;
}
