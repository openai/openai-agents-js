import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeAgents } from './native-agents';
import type { JsonObject } from './binding';

/** Capture declared role files in this Session's isolated native home. */
export async function nativeAgentConfig(
  agents: NativeAgents,
  instructions: string,
  home: string,
): Promise<JsonObject> {
  const config: JsonObject = {
    'agents.enabled': true,
    'features.multi_agent_v2': {
      subagent_developer_instructions: instructions,
      enabled: true,
      tool_namespace: 'collaboration',
      expose_spawn_agent_model_overrides: false,
      ...(agents.maxChildren === undefined
        ? {}
        : { max_concurrent_threads_per_session: agents.maxChildren + 1 }),
    },
  };
  for (const feature of [
    'view_image',
    'image_generation',
    'current_time_reminder',
    'sleep_tool',
    'request_permissions_tool',
    'token_budget',
    'deferred_executor',
    'apps',
    'plugins',
    'memory_tool',
    'tool_suggest',
    'send_message_to_user_async',
  ])
    config[`features.${feature}`] = false;
  config['tools.experimental_request_user_input.enabled'] = false;
  for (const role of agents.additionalRoles) {
    const path = join(home, `role-${role.name}.toml`);
    const fields: Record<string, string> = {
      developer_instructions: role.instructions,
    };
    if (role.model !== undefined) fields.model = role.model;
    if (role.modelSettings?.reasoningEffort !== undefined)
      fields.model_reasoning_effort = role.modelSettings.reasoningEffort;
    await writeFile(
      path,
      Object.entries(fields)
        .map(([name, value]) => `${name} = ${JSON.stringify(value)}\n`)
        .join(''),
    );
    config[`agents.${role.name}`] = {
      description: role.description,
      config_file: path,
    };
  }
  return config;
}
