import { z } from 'zod';

export const DraftLLMSchema = z.object({
  coverLetter: z.string(),
  answers: z.array(z.object({ questionId: z.string(), answer: z.string() })),
  skillsOrder: z.array(z.string()),
  bulletIds: z.array(z.string()),
  claimedSkills: z.array(z.string()),
});
export type DraftLLMOutput = z.infer<typeof DraftLLMSchema>;
