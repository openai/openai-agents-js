import {
  ResponsesModel,
  runWorkerText,
  type WorkerTextOptions,
  type WorkerUserInput,
} from '../../src/runtime/workerd';

export const mediaInput: WorkerUserInput = {
  role: 'user',
  content: [
    { type: 'input_text', text: '海豚 🐬' },
    {
      type: 'input_image',
      image_url: 'data:image/png;base64,eA==',
      detail: 'low',
    },
    { type: 'input_image', file_id: 'image-id' },
    {
      type: 'input_file',
      file_data: 'data:application/pdf;base64,eA==',
      filename: 'sample.pdf',
    },
    {
      type: 'input_file',
      file_url: 'https://example.com/signed.pdf?token=one',
    },
    { type: 'input_file', file_id: 'file-id' },
  ],
};

export async function mediaInputFixture(
  control: () => WorkerTextOptions<undefined>['control'],
  client: ConstructorParameters<typeof ResponsesModel>[0],
) {
  let snapshot: string | null = null;
  let guardInput: WorkerUserInput | undefined;
  const session = {
    id: 'media-session',
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
        revision: number,
        value: string,
      ) {
        if (
          (snapshot === null ? 0 : JSON.parse(snapshot).revision) !== revision
        )
          throw Error('Revision changed');
        snapshot = value;
      },
      async release() {},
    },
  };
  const options = () => ({
    control: control(),
    provider: new ResponsesModel(client, 'fixture'),
    model: 'fixture',
    instructions: 'Read user media.',
    session,
  });
  const output = await runWorkerText(mediaInput, {
    ...options(),
    inputGuardrails: [
      {
        name: 'media source',
        callback({ text, input }) {
          if (
            text !== '海豚 🐬' ||
            JSON.stringify(input) !== JSON.stringify(mediaInput)
          )
            throw Error('Guardrail lost original media');
          guardInput = structuredClone(input);
          // Altering this detached view cannot alter the native admitted request.
          if (
            input &&
            typeof input !== 'string' &&
            Array.isArray(input.content)
          )
            input.content.length = 0;
          return { tripwireTriggered: false, outputInfo: null };
        },
      },
    ],
  });
  const next = await runWorkerText('next question', options());
  return { output, next, guardInput, snapshot: JSON.parse(snapshot!) };
}
