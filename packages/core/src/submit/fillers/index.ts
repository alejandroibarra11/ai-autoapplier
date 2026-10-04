import type { AtsFiller } from '../types';
import { greenhouseFiller } from './greenhouse';
import { leverFiller } from './lever';
import { ashbyFiller } from './ashby';

export function fillerFor(kind: string): AtsFiller | null {
  return kind === 'greenhouse' ? greenhouseFiller : kind === 'lever' ? leverFiller : kind === 'ashby' ? ashbyFiller : null;
}
