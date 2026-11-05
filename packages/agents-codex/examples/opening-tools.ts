import { Agent, tool } from '@openai/agents';
import { z } from 'zod';

/** Open separate tenant tool catalogs with the application's model credentials. */
export async function runOpeningTools() {
  // Run with configured model credentials and a built SDK/native addon.
  const agent = new Agent({
    instructions: 'Call lookup and report its result.',
  });
  const tenantTools = (tenant: string) => [
    tool({
      name: 'lookup',
      description: 'Read the current tenant name.',
      parameters: z.object({}),
      execute: () => ({ tenant }),
    }),
  ];

  async function answer(tenant: string) {
    const session = await agent.session({ tools: tenantTools(tenant) });
    try {
      const result = await (
        await session.submit('Which tenant is this?')
      ).wait();
      console.log(tenant, result.finalOutput);
    } finally {
      await session.close();
    }
  }

  const results = await Promise.allSettled([
    answer('tenant-a'),
    answer('tenant-b'),
  ]);
  const errors: unknown[] = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  try {
    await agent.provider.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, 'Tenant requests or cleanup failed');
}

if (typeof require !== 'undefined' && require.main === module) {
  runOpeningTools().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
