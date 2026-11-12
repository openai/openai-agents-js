import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
} from '../../../src';

async function main() {
  const { initial, forced, childDefault, baseUrl, executorUrl, cwd, headers } =
    JSON.parse(process.argv[2]) as {
      initial: string;
      forced: string;
      childDefault: string;
      baseUrl: string;
      executorUrl: string;
      cwd: string;
      headers: Record<string, string>;
    };
  await using provider = new NativeProvider({
    baseUrl,
    apiKey: 'synthetic-model-override',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    model: initial,
    instructions: 'Delegate.',
    provider,
    tools: [
      new NativeAgents({
        additionalRoles: [
          new NativeRole({
            name: 'research',
            model: childDefault,
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
  await (await session.submit('delegate', { modelOverride: forced })).wait();
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
