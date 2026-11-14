import {
  runWorkerText,
  transactWorkerHistory,
  type WorkerTextOptions,
} from '../../src/runtime/workerd';

const check = (condition: unknown, label: string) => {
  if (!condition) throw Error(label);
};

export function historyStore() {
  let stored: string | null = null,
    revision = 0,
    commits = 0,
    held: string | null = null,
    serial = 0;
  const store = {
    async acquire() {
      check(held === null, 'Exclusive writer');
      return (held = 'lease-' + ++serial);
    },
    async read(_id: string, fence: string) {
      check(fence === held, 'Current read lease');
      return stored;
    },
    async commit(
      _id: string,
      fence: string,
      _write: string,
      expected: number,
      checkpoint: string,
    ) {
      check(
        fence === held && expected === revision,
        'Atomic conditional write',
      );
      stored = checkpoint;
      revision++;
      commits++;
    },
    async release(_id: string, fence: string) {
      check(fence === held, 'Current release lease');
      held = null;
    },
  };
  return {
    session: { id: 'native-history', store },
    stored: () => stored,
    revision: () => revision,
    commits: () => commits,
    held: () => held,
  };
}

export async function historyFixture(
  control: () => WorkerTextOptions<undefined>['control'],
) {
  const owner = historyStore();
  const requests: any[] = [];
  const options = () => ({ control: control(), session: owner.session });
  const modelOptions = () => ({
    ...options(),
    model: 'fixture',
    instructions: 'History control',
    provider: {
      complete({ body }: any) {
        requests.push(structuredClone(body));
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'answer-' + requests.length },
              ],
            },
          ],
        };
      },
    },
  });
  await runWorkerText('first question', modelOptions());
  const before = await transactWorkerHistory({ type: 'read' }, options());
  check(
    before.items.length === 2 && before.revision === 1 && owner.commits() === 1,
    'Read without a new revision',
  );
  const tail = await transactWorkerHistory(
    { type: 'read', limit: 1 },
    options(),
  );
  const huge = await transactWorkerHistory(
    { type: 'read', limit: Number.MAX_SAFE_INTEGER },
    options(),
  );
  const none = await transactWorkerHistory(
    { type: 'read', limit: -1 },
    options(),
  );
  check(
    huge.items.length === 2 && none.items.length === 0,
    'Bounded tail reads on both pointer widths',
  );
  // Read values remain detached from the opaque checkpoint and current owner.
  (before.items[0] as any).content[0].text = 'forged view';
  const pop = await transactWorkerHistory(
    { type: 'pop' },
    { ...options(), expectedRevision: tail.revision },
  );
  check(
    JSON.stringify(pop.popped) === JSON.stringify(tail.items),
    'Pop exact native tail',
  );
  await transactWorkerHistory(
    {
      type: 'append',
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'native append' }],
        },
      ],
    },
    { ...options(), expectedRevision: pop.revision },
  );
  await runWorkerText('after edit', modelOptions());
  const edited = JSON.stringify(requests[1].input);
  check(
    edited.includes('first question') &&
      edited.includes('native append') &&
      edited.includes('after edit') &&
      !edited.includes('answer-1') &&
      !edited.includes('forged view'),
    'Cold native edited history',
  );
  const clear = await transactWorkerHistory({ type: 'clear' }, options());
  const empty = await transactWorkerHistory(
    { type: 'read', limit: undefined },
    options(),
  );
  check(
    empty.items.length === 0 &&
      clear.revision === empty.revision &&
      owner.commits() === 5,
    'Native clear and read without a commit',
  );
  await runWorkerText('after clear', modelOptions());
  const cleared = JSON.stringify(requests[2].input);
  check(
    cleared.includes('after clear') &&
      !cleared.includes('first question') &&
      !cleared.includes('native append') &&
      !cleared.includes('answer-2'),
    'Cold native clear',
  );
  check(owner.held() === null, 'Writer released');
  return {
    requests,
    popped: pop.popped,
    final: await transactWorkerHistory({ type: 'read' }, options()),
    commits: owner.commits(),
  };
}
