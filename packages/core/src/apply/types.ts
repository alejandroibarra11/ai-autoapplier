export type ResolvedKind = 'greenhouse' | 'lever' | 'ashby' | 'other' | 'manual';
export type QuestionType = 'text' | 'textarea' | 'select' | 'multiselect' | 'boolean' | 'file' | 'identity';

export interface FormQuestion { id: string; label: string; type: QuestionType; required: boolean; options?: string[] }
export interface ApplyTarget { kind: ResolvedKind; url: string; atsToken?: string; atsJobId?: string }
export interface DraftAnswer { questionId: string; label: string; answer: string; source: 'answers' | 'generated' }
export interface CvSelection { skillsOrder: string[]; bulletIds: string[] }
