import { z } from 'zod';
import { binding, decode } from './binding';
import type { Turn } from './session';

const nativeCommandName = z.enum(['compact', 'stop', 'rename', 'review']);
const commandName = z.enum([
  'compact',
  'stop-background-terminals',
  'rename',
  'review',
]);
export type EmbeddedCommandName = z.infer<typeof commandName>;

/** Native command metadata, not a promise of eligibility in a live Session. */
export interface EmbeddedCommand {
  readonly name: EmbeddedCommandName;
  readonly description: string;
  readonly supportsInlineArguments: boolean;
}

const commandCatalog = z.array(
  z.object({
    name: nativeCommandName,
    description: z.string(),
    supports_inline_arguments: z.boolean(),
  }),
);

/** Read pinned native definitions without opening a Session or starting a model. */
export async function embeddedCommands(): Promise<readonly EmbeddedCommand[]> {
  const native = await binding();
  return Object.freeze(
    decode(commandCatalog, native._embedded_commands()).map((command) =>
      Object.freeze({
        name:
          command.name === 'stop' ? 'stop-background-terminals' : command.name,
        description: command.description,
        supportsInlineArguments: command.supports_inline_arguments,
      }),
    ),
  );
}

/** Structured native review output; fields retain their native spelling. */
export interface NativeReviewOutput {
  readonly findings: readonly {
    readonly title: string;
    readonly body: string;
    readonly confidence_score: number;
    readonly priority: number;
    readonly code_location: {
      readonly absolute_file_path: string;
      readonly line_range: { readonly start: number; readonly end: number };
    };
  }[];
  readonly overall_correctness: string;
  readonly overall_explanation: string;
  readonly overall_confidence_score: number;
}

export const nativeReviewOutput = z
  .object({
    findings: z.array(
      z.object({
        title: z.string(),
        body: z.string(),
        confidence_score: z.number(),
        priority: z.number(),
        code_location: z.object({
          absolute_file_path: z.string(),
          line_range: z.object({ start: z.number(), end: z.number() }),
        }),
      }),
    ),
    overall_correctness: z.string(),
    overall_explanation: z.string(),
    overall_confidence_score: z.number(),
  })
  .nullable();

/** Actual operation receipts. A stop receipt acknowledges enqueueing, not exit. */
export type EmbeddedCommandResult =
  | { readonly command: 'compact'; readonly turn: Turn<string> }
  | {
      readonly command: 'review';
      readonly turn: Turn<NativeReviewOutput | null>;
    }
  | {
      readonly command: 'stop-background-terminals';
      readonly sessionId: string;
      readonly operationId: string;
    }
  | {
      readonly command: 'rename';
      readonly sessionId: string;
      readonly name: string;
    };

/** @internal Parse only the supported canonical forms; aliases are not TUI input. */
export function parseEmbeddedCommand(input: string): {
  name: EmbeddedCommandName;
  arguments: string;
} {
  const match = /^\/?(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  const parsed = commandName.safeParse(match?.[1]);
  if (!parsed.success) throw new TypeError('Unsupported embedded command');
  const name = parsed.data;
  const arguments_ = match?.[2] ?? '';
  if (name === 'compact' || name === 'stop-background-terminals') {
    if (arguments_.trim())
      throw new TypeError(`${name} does not accept inline arguments`);
  } else if (!arguments_.trim()) {
    throw new TypeError(`${name} requires an argument`);
  }
  return { name, arguments: arguments_ };
}
