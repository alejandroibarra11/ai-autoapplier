export type ResolvedKind = 'greenhouse' | 'lever' | 'ashby' | 'other' | 'manual';
export type QuestionType = 'text' | 'textarea' | 'select' | 'multiselect' | 'boolean' | 'file' | 'identity';

export interface FormQuestion { id: string; label: string; type: QuestionType; required: boolean; options?: string[] }
export interface ApplyTarget { kind: ResolvedKind; url: string; atsToken?: string; atsJobId?: string }
/** `fillTime`: generated while filling the form (a required question the draft lacked); flagged ⚠️ on the fill card. */
export interface DraftAnswer { questionId: string; label: string; answer: string; source: 'answers' | 'generated'; fillTime?: boolean }
export interface CvSelection { skillsOrder: string[]; bulletIds: string[] }
