import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@openai/agents';
import { jsonArtifactTool } from '@openai/agents/artifacts';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

/** Check and repair a JSON artifact with the packaged tool and native Session. */
export async function runPackagedArtifact(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agents-packaged-artifact-'));
  const path = join(directory, 'report.json');
  try {
    await withScriptedResponses(
      [
        [toolCall('publish_report', { json: '{' }, { callId: 'syntax' })],
        [
          toolCall(
            'publish_report',
            { json: '{"title":""}' },
            { callId: 'schema' },
          ),
        ],
        [
          toolCall(
            'publish_report',
            { json: '{"title":"Quarterly results"}' },
            { callId: 'corrected' },
          ),
        ],
        [text('Published checked report.')],
      ],
      async (peer) => {
        const agent = new Agent({
          instructions:
            'Publish the report. Repair JSON rejected by publish_report.',
          provider: peer.provider,
          tools: [
            jsonArtifactTool({
              name: 'publish_report',
              path,
              schema: z.strictObject({ title: z.string().min(1) }),
            }),
          ],
        });
        await using session = await agent.session();
        const result = await (
          await session.submit('Publish the report.')
        ).wait();
        assert.match(
          peer.toolOutput('syntax') ?? '',
          /JSON syntax check failed/,
        );
        assert.match(peer.toolOutput('schema') ?? '', /schema check failed/);
        const content = await readFile(path, 'utf8');
        assert.deepEqual(JSON.parse(content), { title: 'Quarterly results' });
        console.log(result.finalOutput);
        process.stdout.write(content);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// tsx runs source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  runPackagedArtifact().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
