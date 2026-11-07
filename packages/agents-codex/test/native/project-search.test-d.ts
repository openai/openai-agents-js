import { expectTypeOf } from 'vitest';
import { Environment, type EnvironmentOptions } from '@openai/agents';

const tools = ['project_glob', 'project_grep'] as const;
new Environment({ url: 'wss://executor.invalid', cwd: '/project', tools });
const environment = Environment.local({ cwd: '/project', tools });
expectTypeOf(environment.tools).toEqualTypeOf<
  NonNullable<EnvironmentOptions['tools']>
>();
// @ts-expect-error Search grants are captured and immutable.
environment.tools.push('project_glob');
// @ts-expect-error Search uses its fixed Environment root, not another option.
Environment.local({ cwd: '/project', tools, searchRoot: '/other' });
