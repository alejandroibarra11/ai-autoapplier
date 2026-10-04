import type { FormQuestion } from './types';

export const COMMON_QUESTIONS: FormQuestion[] = [
  { id: 'why_company', label: 'Why do you want to work at this company?', type: 'textarea', required: false },
  { id: 'why_role', label: 'Why are you a strong fit for this role?', type: 'textarea', required: false },
  { id: 'work_auth', label: 'Are you legally authorized to work in the United States?', type: 'text', required: false },
  { id: 'sponsorship', label: 'Will you now or in the future require visa sponsorship?', type: 'text', required: false },
  { id: 'salary', label: 'What are your salary expectations?', type: 'text', required: false },
  { id: 'notice', label: 'What is your notice period?', type: 'text', required: false },
  { id: 'location', label: 'Where are you located?', type: 'text', required: false },
  { id: 'timezone', label: 'Which time zone are you in?', type: 'text', required: false },
  { id: 'linkedin', label: 'LinkedIn profile', type: 'text', required: false },
  { id: 'github', label: 'GitHub profile', type: 'text', required: false },
];
