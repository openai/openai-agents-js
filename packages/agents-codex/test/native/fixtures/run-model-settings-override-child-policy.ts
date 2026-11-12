import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
} from '../../../src';

async function main() {
  const { forced, baseUrl, executorUrl, cwd, headers } = JSON.parse(
    process.argv[2],
  ) as {
    forced: string;
    baseUrl: string;
    executorUrl: string;
    cwd: string;
    headers: Record<string, string>;
  };
  let firstCalls = 0;
  let secondCalls = 0;
  await using provider = new NativeProvider({
    baseUrl,
    apiKey: 'synthetic-child-policy',
    supportsWebsockets: false,
    requestMaxRetries: 0,
    streamMaxRetries: 0,
  });
  await using session = await new Agent({
    model: forced,
    instructions: 'Delegate.',
    provider,
    tools: [
      new NativeAgents({
        additionalRoles: [
          new NativeRole({
            name: 'research',
            model: forced,
            description: 'Research.',
            instructions: 'Answer.',
          }),
        ],
      }),
    ],
  }).session({
    environment: new Environment({
      url: executorUrl,
      cwd,
      headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    }),
  });
  await (
    await session.submit('delegate', {
      modelSettingsOverride: {
        retry: {
          maxRetries: 1,
          policy: () => {
            firstCalls++;
            return { retry: true, delayMs: 0 };
          },
        },
      },
    })
  ).wait();
  (globalThis as { gc?: () => void }).gc?.();
  await (
    await session.submit('another independent root', {
      modelSettingsOverride: {
        retry: {
          maxRetries: 1,
          policy: () => {
            secondCalls++;
            return { retry: false };
          },
        },
      },
    })
  ).wait();
  let output: unknown;
  for await (const child of session.subagents())
    output = (await child.turn!.wait()).finalOutput;
  console.log(JSON.stringify({ firstCalls, secondCalls, output }));
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
