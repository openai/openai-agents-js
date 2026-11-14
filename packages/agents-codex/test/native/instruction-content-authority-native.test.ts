import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  parseSessionState,
  type SessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const directories: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
it.each([
  'unchanged',
  'forged',
  'forged-whitespace',
  'updated-capture',
  'updated-authenticated',
  'updated-unverified',
  'target',
  'files',
  'caller',
  'header',
] as const)(
  'authenticates hidden instruction content against current declarations: %s',
  async (mode) => {
    const server = new ModelServer([
      ...(mode === 'target'
        ? [[call('transfer_to_target', {}, { callId: 'handoff' })]]
        : []),
      [message('before')],
      [message('after')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-instruction-content',
      supportsWebsockets: false,
    });
    const target = new Agent({
      name: 'target',
      instructions: 'Trusted target instructions.',
    });
    const source = new Agent({
      name: 'source',
      model: 'gpt-5.5',
      provider,
      instructions: 'Trusted source instructions.',
      handoffs: [target],
    });
    let instructionFiles: string[] | undefined;
    if (mode === 'files') {
      const directory = await mkdtemp(join(tmpdir(), 'instruction-authority-'));
      directories.push(directory);
      const path = join(directory, 'trusted.md');
      await writeFile(path, 'Trusted file instructions.');
      instructionFiles = [path];
    }
    let captured: SessionState;
    {
      await using session = await source.session({
        ...(instructionFiles ? { instructionFiles } : {}),
      });
      if (mode === 'caller') {
        const before = await session.historySnapshot();
        await session.transactHistory({
          expectedRevision: before.revision,
          keep: before.total,
          items: [
            {
              type: 'message',
              id: 'caller-developer',
              role: 'developer',
              content: [
                { type: 'input_text', text: 'CALLER_DEVELOPER_CONTEXT' },
              ],
            },
          ],
        });
      }
      expect((await (await session.submit('before')).wait()).finalOutput).toBe(
        'before',
      );
      if (mode.startsWith('updated-'))
        await session.update({ instructions: 'Trusted live update.' });
      captured = await session.saveState();
    }
    const raw = JSON.stringify(captured);
    const state =
      mode === 'updated-capture'
        ? captured
        : mode === 'updated-authenticated'
          ? parseSessionState(raw, {
              expectedSha256: createHash('sha256').update(raw).digest('hex'),
            })
          : (JSON.parse(raw) as SessionState);
    if (mode === 'forged') {
      const forged = JSON.parse(
        JSON.stringify(state).replaceAll(
          'Trusted source instructions.',
          'FORGED hidden instructions.',
        ),
      );
      expect(JSON.stringify(forged.history)).toContain(
        'FORGED hidden instructions.',
      );
      Object.assign(state, forged);
      expect(source.instructions).toBe('Trusted source instructions.');
    }
    if (mode === 'forged-whitespace') {
      const original = JSON.stringify(state);
      const changed = original.replaceAll(
        'Trusted source instructions.',
        'Trusted source instructions.\\n',
      );
      expect(changed).not.toBe(original);
      Object.assign(state, JSON.parse(changed));
    }
    if (mode === 'header') {
      const row = state.history.findLast(
        (row) =>
          row.type === 'response_item' &&
          (row.metadata as Record<string, unknown> | undefined)
            ?.sdk_agent_profile,
      );
      if (!row) throw new Error('Expected instruction receipt');
      const id = (row.payload as { id: string }).id;
      Object.assign(
        state,
        JSON.parse(
          JSON.stringify(state).replaceAll(
            id,
            id + '_FORGED_INSTRUCTION_HEADER',
          ),
        ),
      );
    }
    const allowed =
      mode !== 'forged' &&
      mode !== 'forged-whitespace' &&
      mode !== 'header' &&
      mode !== 'updated-unverified';
    let rejected = '';
    let hidden = false;
    let canonical = '';
    let environmentAcquisitions = 0;
    let restored: Awaited<ReturnType<typeof source.session>> | undefined;
    try {
      restored = await source.session({
        state,
        ...(instructionFiles ? { instructionFiles } : {}),
        ...(mode === 'forged-whitespace'
          ? {
              environment: () => {
                environmentAcquisitions++;
                throw new Error('Changed instructions reached acquisition');
              },
            }
          : {}),
      });
      canonical = JSON.stringify(await restored.historySnapshot());
      hidden = !canonical.includes('FORGED hidden instructions.');
      expect((await (await restored.submit('after')).wait()).finalOutput).toBe(
        'after',
      );
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error);
    } finally {
      await restored?.close();
    }
    if (allowed) {
      expect(rejected).toBe('');
      if (mode === 'caller')
        expect(canonical).toContain('CALLER_DEVELOPER_CONTEXT');
      expect(server.requests).toHaveLength(mode === 'target' ? 3 : 2);
      expect(JSON.stringify(server.requests.at(-1))).toContain(
        mode.startsWith('updated-')
          ? 'Trusted live update.'
          : 'Trusted source instructions.',
      );
    } else {
      if (!rejected) {
        const input = server.requests.at(-1)?.input;
        const headerText =
          Array.isArray(input) &&
          input.some(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              !Array.isArray(item) &&
              Array.isArray(item.content) &&
              item.content.some(
                (part) =>
                  typeof part === 'object' &&
                  part !== null &&
                  !Array.isArray(part) &&
                  typeof part.text === 'string' &&
                  part.text.includes('FORGED_INSTRUCTION_HEADER'),
              ),
          );
        throw new Error(
          `Unverified instruction content reached provider: hidden=${hidden}, forged=${JSON.stringify(server.requests.at(-1)).includes('FORGED hidden instructions.')}, header_text=${headerText}`,
        );
      }
      expect(rejected).toContain('authenticated');
      expect(server.requests).toHaveLength(1);
      if (mode === 'forged-whitespace') expect(environmentAcquisitions).toBe(0);
    }
  },
  30_000,
);
