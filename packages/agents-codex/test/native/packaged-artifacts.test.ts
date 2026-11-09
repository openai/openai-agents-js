import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, tool } from '../../src';
import { jsonArtifactTool } from '../../src/artifacts';
import { text, toolCall, withScriptedResponses } from '../../src/testing';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agents-artifacts-test-'));
  directories.push(path);
  return path;
}
const schema = z.strictObject({ title: z.string().min(1) });

it('repairs malformed and invalid JSON in the same native session before publishing', async () => {
  const root = await directory();
  const path = join(root, 'report.json');
  const previous = '{"title":"Previous"}\n';
  await writeFile(path, previous, 'utf8');
  await withScriptedResponses(
    [
      [toolCall('report', { json: '{' }, { callId: 'bad-json' })],
      [toolCall('inspect_previous', {}, { callId: 'after-json' })],
      [toolCall('report', { json: '{"title":""}' }, { callId: 'bad-schema' })],
      [toolCall('inspect_previous', {}, { callId: 'after-schema' })],
      [
        toolCall(
          'report',
          { json: '{"title":"Corrected café"}' },
          { callId: 'corrected' },
        ),
      ],
      [text('Published')],
    ],
    async (peer) => {
      const agent = new Agent({
        provider: peer.provider,
        instructions: 'Publish the report, repairing rejected JSON.',
        tools: [
          jsonArtifactTool({ name: 'report', path, schema }),
          tool({
            name: 'inspect_previous',
            parameters: z.strictObject({}),
            execute: () => readFile(path, 'utf8'),
          }),
        ],
      });
      await using session = await agent.session();
      const turn = await session.submit('Publish the report.');
      expect((await turn.wait()).finalOutput).toBe('Published');
      const turnIds = new Set<string>();
      let calls = 0;
      for await (const item of session.items()) {
        if (item.type === 'function_call') {
          turnIds.add(item.turnId);
          calls++;
        }
      }
      expect(turnIds).toEqual(new Set([turn.turnId]));
      expect(calls).toBe(5);
      expect(peer.toolOutput('bad-json')).toContain(
        'Artifact report.json: JSON syntax check failed',
      );
      expect(peer.toolOutput('bad-schema')).toContain(
        'Artifact report.json: schema check failed: title:',
      );
      expect(peer.toolOutput('after-json')).toBe(previous);
      expect(peer.toolOutput('after-schema')).toBe(previous);
      expect(peer.toolOutput('corrected')).toContain(
        'Published validated JSON artifact report',
      );
      expect(JSON.stringify(peer.requests[1])).toContain(
        'JSON syntax check failed',
      );
      expect(JSON.stringify(peer.requests[3])).toContain('schema check failed');
    },
  );
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    title: 'Corrected café',
  });
  expect(await readdir(root)).toEqual(['report.json']);
}, 30_000);

it('bounds schema diagnostics and preserves the previous artifact', async () => {
  const root = await directory();
  const path = join(root, 'report.json');
  await writeFile(path, 'previous', 'utf8');
  await withScriptedResponses(
    [
      [
        toolCall(
          'report',
          { json: JSON.stringify({ titles: Array(40).fill('bad') }) },
          { callId: 'bad' },
        ),
      ],
      [text('Rejected')],
    ],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Publish the requested JSON artifact.',
        provider: peer.provider,
        tools: [
          jsonArtifactTool({
            name: 'report',
            path,
            schema: z.strictObject({ titles: z.array(z.number()) }),
          }),
        ],
      });
      await agent.run('Try the report.');
      expect(peer.toolOutput('bad')).toContain('schema check failed');
      expect(peer.toolOutput('bad')!.length).toBeLessThan(2048);
    },
  );
  expect(await readFile(path, 'utf8')).toBe('previous');
  expect(await readdir(root)).toEqual(['report.json']);
}, 30_000);

it('fails on I/O errors without asking the model to repair valid JSON', async () => {
  const root = await directory();
  const path = join(root, 'missing', 'report.json');
  await withScriptedResponses(
    [[toolCall('report', { json: '{"title":"Valid"}' }, { callId: 'valid' })]],
    async (peer) => {
      const agent = new Agent({
        instructions: 'Publish the requested JSON artifact.',
        provider: peer.provider,
        tools: [jsonArtifactTool({ name: 'report', path, schema })],
      });
      await expect(agent.run('Publish the report.')).rejects.toThrow(/ENOENT/);
      expect(peer.requests).toHaveLength(1);
    },
  );
  expect(await readdir(root)).toEqual([]);
}, 30_000);
