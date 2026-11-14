import {
  ResponsesModel,
  ToolOutput,
  runWorkerTurn,
  runWorkerText,
  type WorkerTextOptions,
} from '../../src/runtime/workerd';
import { z } from 'zod';
import { standaloneTool } from '../../src/runtime/workerd';

export const mediaResult = new ToolOutput([
  { type: 'inputText', text: 'local media' },
  ...ToolOutput.image({ fileId: 'image-id', detail: 'low' }).contentItems,
  ...ToolOutput.file({ file_id: 'file-id' }).contentItems,
  ...ToolOutput.image(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+4eQAAAAASUVORK5CYII=',
  ).contentItems,
  ...ToolOutput.file({
    file_data: 'data:application/pdf;base64,JVBERi0xLjc=',
    filename: 'sample.pdf',
  }).contentItems,
  ...ToolOutput.file({ file_url: 'https://example.com/signed.pdf?token=one' })
    .contentItems,
]);

export async function toolMediaFixture(
  control: () => WorkerTextOptions<undefined>['control'],
  client: ConstructorParameters<typeof ResponsesModel>[0],
) {
  let snapshot: string | null = null,
    mediaCalls = 0,
    approvalCalls = 0,
    guards = 0;
  const session = {
    id: 'tool-media-session',
    store: {
      async acquire() {
        return 'lease';
      },
      async read() {
        return snapshot;
      },
      async commit(
        _id: string,
        _lease: string,
        _write: string,
        expected: number,
        value: string,
      ) {
        if (
          (snapshot === null ? 0 : JSON.parse(snapshot).revision) !== expected
        )
          throw Error('Revision changed');
        snapshot = value;
      },
      async release() {},
    },
  };
  const options = () => ({
    control: control(),
    model: 'fixture',
    instructions: 'Use local media.',
    session,
    provider: new ResponsesModel(client, 'fixture'),
    tools: [
      standaloneTool({
        name: 'media',
        parameters: z.object({}),
        execute() {
          mediaCalls++;
          return mediaResult;
        },
      }),
      standaloneTool({
        name: 'approval',
        parameters: z.object({}),
        execute() {
          approvalCalls++;
          return 'approved';
        },
      }),
    ],
    approve: { approval: () => null },
    toolGuardrails: {
      media: [
        {
          name: 'media view',
          after({ output, response }: any) {
            guards++;
            if (
              typeof output !== 'string' ||
              response?.contentItems[1]?.fileId !== 'image-id'
            )
              throw Error('Guard lost native media');
            // A changed guard view has no authority over the captured native result.
            response.contentItems.splice(0, response.contentItems.length, {
              type: 'function_call',
              name: 'forged',
            });
            return { action: 'allow' as const };
          },
        },
      ],
    },
  });
  const paused = await runWorkerTurn('Use media and approval.', options());
  if (paused.type !== 'approval' || mediaCalls !== 1 || approvalCalls !== 0)
    throw Error('Partial result was not paused');
  const partialSnapshot = JSON.parse(snapshot!);
  const completed = await runWorkerTurn(
    { callId: paused.callId, revision: paused.revision, approved: true },
    options(),
  );
  if (completed.type !== 'completed')
    throw Error('Approved media turn did not complete');
  const cold = await runWorkerText('cold follow-up', options());
  if (mediaCalls !== 1 || Number(approvalCalls) !== 1 || guards !== 1)
    throw Error('A cold controller replayed a tool effect');
  return {
    completed,
    cold,
    mediaCalls,
    approvalCalls,
    guards,
    partialSnapshot,
    snapshot: JSON.parse(snapshot!),
  };
}
