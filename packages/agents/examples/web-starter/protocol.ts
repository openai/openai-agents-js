import { z } from 'zod';

export const owners = ['alice', 'bob'] as const;
export type Owner = (typeof owners)[number];
export const ownerSchema = z.enum(owners);
export const taskSchema = z.strictObject({
  requestKey: z.string().min(1).max(80),
  task: z
    .string()
    .min(1)
    .max(2000)
    .refine((task) => task.trim().length > 0, 'Task must not be blank.'),
});
export const approvalSchema = z.strictObject({
  token: z.string().uuid(),
  approve: z.boolean(),
});
export const presentationSchema = z.strictObject({
  slides: z
    .array(z.strictObject({ text: z.string().min(1).max(2000) }))
    .min(1)
    .max(12),
});
export const resultSchema = z.strictObject({
  summary: z.string().min(1).max(1000),
});
export type Result = z.infer<typeof resultSchema>;
export type Phase =
  | 'queued'
  | 'running'
  | 'approval'
  | 'stopping'
  | 'completed'
  | 'denied'
  | 'stopped'
  | 'expired'
  | 'failed'
  | 'unknown';
export interface Snapshot {
  receipt: string;
  revision: number;
  phase: Phase;
  deadlineAt: number;
  approval?: { token: string; summary: string };
  result?: Result;
  artifact?: { handle: string; filename: 'presentation.json' };
  error?: string;
}
export const terminal = (phase: Phase): boolean =>
  ['completed', 'denied', 'stopped', 'expired', 'failed', 'unknown'].includes(
    phase,
  );
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
