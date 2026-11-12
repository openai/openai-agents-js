import { z } from 'zod';
import { UserError } from '../../errors';
import { normalizeRolloutSlug } from './rollouts';

export const RolloutExtractionArtifactsSchema = z.object({
  rollout_summary: z.string(),
  rollout_slug: z.string(),
  raw_memory: z.string(),
});

export type RolloutExtractionArtifacts = z.infer<
  typeof RolloutExtractionArtifactsSchema
>;

export function validateRolloutArtifacts(
  artifacts: RolloutExtractionArtifacts,
): boolean {
  const hasSlug = artifacts.rollout_slug.trim().length > 0;
  const hasSummary = artifacts.rollout_summary.trim().length > 0;
  const hasRawMemory = artifacts.raw_memory.trim().length > 0;
  if (!hasSlug && !hasSummary && !hasRawMemory) {
    return false;
  }
  if (!hasSlug || !hasSummary || !hasRawMemory) {
    throw new UserError('Phase 1 returned partially-empty memory artifacts.');
  }
  normalizeRolloutSlug(artifacts.rollout_slug);
  return true;
}

export function formatRawMemory(args: {
  updatedAt: string;
  rolloutId: string;
  rolloutPath: string;
  rolloutSummaryFile: string;
  terminalState: string;
  rawMemory: string;
}): string {
  return [
    `rollout_id: ${args.rolloutId}`,
    `updated_at: ${args.updatedAt}`,
    `rollout_path: ${args.rolloutPath}`,
    `rollout_summary_file: ${args.rolloutSummaryFile}`,
    `terminal_state: ${args.terminalState}`,
    '',
    args.rawMemory.trimEnd(),
    '',
  ].join('\n');
}

export function formatRolloutSummary(args: {
  updatedAt: string;
  rolloutPath: string;
  sessionId: string;
  terminalState: string;
  rolloutSummary: string;
}): string {
  return [
    `session_id: ${args.sessionId}`,
    `updated_at: ${args.updatedAt}`,
    `rollout_path: ${args.rolloutPath}`,
    `terminal_state: ${args.terminalState}`,
    '',
    args.rolloutSummary.trimEnd(),
    '',
  ].join('\n');
}
