import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1').each([
  ['workspace-write', 'user'],
  ['danger-full-access', 'user'],
  ['workspace-write', 'guardian'],
] as const)(
  'keeps run overrides within admitted approval authority (%s, %s)',
  async (sandbox, reviewer) => {
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { models: { slug: string; supported_in_api: boolean }[] };
    const [initial, forced] = catalog.models
      .filter((model) => model.supported_in_api)
      .map((model) => model.slug);
    const directory = await mkdtemp(join(tmpdir(), 'agents-run-authority-'));
    await writeFile(
      join(directory, 'requirements.toml'),
      `[auto_review]\nrequired_on_models = [${JSON.stringify(forced)}]\n`,
    );
    const addon = await binding();
    const create = addon.create_engine;
    const policy = {
      sandbox_mode: sandbox,
      approvals_reviewer: reviewer,
      'features.guardian_approval': true,
    };
    const loader = {
      managed_config_path: join(directory, 'managed.toml'),
      system_config_path: join(directory, 'system.toml'),
      system_requirements_path: join(directory, 'requirements.toml'),
      ignore_managed_requirements: false,
      ignore_user_config: true,
      ignore_project_config: true,
    };
    const spy = vi
      .spyOn(addon, 'create_engine')
      .mockImplementation(async (config, runtime, ...args) => {
        const engine = await Reflect.apply(create, addon, [
          JSON.stringify({ ...JSON.parse(config), ...policy }),
          JSON.stringify({
            ...JSON.parse(runtime),
            loader,
            strict_config: true,
          }),
          ...args,
        ]);
        const start = engine.start_replaceable_thread.bind(engine);
        vi.spyOn(engine, 'start_replaceable_thread').mockImplementation(
          (options, ...rest) => {
            const opening = JSON.parse(options);
            opening.config = { ...opening.config, ...policy };
            opening.runtime = {
              ...opening.runtime,
              loader,
              strict_config: true,
            };
            return start(JSON.stringify(opening), ...rest);
          },
        );
        return engine;
      });
    const server = new ModelServer(
      reviewer === 'guardian'
        ? [[message('forced model')], [message('default model')]]
        : [[message('default model')]],
    );
    const config = await server.config();
    try {
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-run-authority',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        model: initial,
        instructions: 'Answer.',
        provider,
      });
      await using session = await agent.session();
      const override = async () =>
        (
          await session.submit('requires stronger authority', {
            modelOverride: forced,
          })
        ).wait();
      if (reviewer === 'user') {
        await expect(override()).rejects.toThrow(/review|guardian/i);
        expect(server.requests).toHaveLength(0);
        await session.close();
        await using compatible = await agent.session();
        await (await compatible.submit('retain default')).wait();
        expect(server.requests.map((request) => request.model)).toEqual([
          initial,
        ]);
      } else {
        await override();
        await (await session.submit('retain default')).wait();
        expect(server.requests.map((request) => request.model)).toEqual([
          forced,
          initial,
        ]);
      }
      server.assertExhausted();
    } finally {
      spy.mockRestore();
      await ModelServer.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
