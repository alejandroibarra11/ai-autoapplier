import { z } from 'zod';

// No numeric min/max here: structured-output backends may reject them. Clamp in code.
export const ScoreSchema = z.object({
  eligibility: z.enum(['eligible', 'likely', 'unlikely', 'ineligible']),
  eligibilityEvidence: z.string(),
  fitScore: z.number(),
  roleCategory: z.enum(['ai', 'fullstack', 'voice', 'other']),
  matched: z.array(z.string()),
  missing: z.array(z.string()),
  redFlags: z.array(z.string()),
  compEstimate: z.string().nullable(),
});
export type ScorePayload = z.infer<typeof ScoreSchema>;
