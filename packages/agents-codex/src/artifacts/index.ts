import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { tool, ToolOutput, type FunctionTool } from '../runtime/tools';

/**
 * Create a native tool that checks and publishes a named JSON artifact.
 * The model supplies a `json` string; expected check failures go back to the same
 * agent for correction. Other errors fail the turn. The trusted application
 * chooses the path and Zod schema. The parent directory must exist.
 * Non-finite JSON numbers return repair feedback instead of becoming null.
 * Rejected candidates preserve previous bytes. Concurrent successful calls use
 * the last atomic replacement; replacement does not promise crash durability.
 */
export function jsonArtifactTool(options: {
  name: string;
  path: string;
  schema: z.ZodType;
}): FunctionTool {
  const { name, schema } = options;
  const destination = resolve(options.path);
  const rejected = (problem: string) =>
    new ToolOutput(
      [
        {
          type: 'inputText',
          text: `Artifact ${basename(destination)}: ${problem}. Fix the JSON and call ${name} again.`
            .slice(0, 2048)
            .toWellFormed(),
        },
      ],
      false,
    );
  return tool({
    name,
    description: `Validate JSON and publish artifact ${basename(destination)}. Repair rejected JSON.`,
    parameters: z.strictObject({ json: z.string() }),
    execute: async ({ json }, context) => {
      let candidate: unknown;
      try {
        candidate = JSON.parse(json);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return rejected('JSON syntax check failed');
      }
      const checked = await schema.safeParseAsync(candidate);
      if (!checked.success) {
        const problems = checked.error.issues.slice(0, 5).map((issue) => {
          const location = issue.path.map(String).join('.') || '$';
          return `${location.slice(0, 160)}: ${issue.message.slice(0, 200)}`;
        });
        return rejected(`schema check failed: ${problems.join('; ')}`);
      }
      let hasNonFiniteNumber = false;
      const content = JSON.stringify(
        checked.data,
        (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value)) {
            hasNonFiniteNumber = true;
          }
          return value;
        },
        2,
      );
      if (hasNonFiniteNumber)
        return rejected('JSON value check failed: numbers must be finite');
      if (content === undefined)
        throw new TypeError('Artifact schema must produce a JSON value');
      context.signal.throwIfAborted();
      const temporary = join(
        dirname(destination),
        `.agents-artifact-${randomUUID()}`,
      );
      const output = await open(temporary, 'wx', 0o600);
      try {
        try {
          await output.writeFile(`${content}\n`, 'utf8');
        } finally {
          await output.close();
        }
        context.signal.throwIfAborted();
        await rename(temporary, destination);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      return new ToolOutput([
        {
          type: 'inputText',
          text: `Published validated JSON artifact ${name}: ${basename(destination)}`,
        },
      ]);
    },
  });
}
