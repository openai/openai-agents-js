import { describe, expect, it, vi } from 'vitest';

import { northflankTools } from '../../src/northflank/index';
import { DEFAULT_EXEC_TIMEOUT_MS } from '../../src/northflank/tools/exec';
import { DEFAULT_FILE_TIMEOUT_MS } from '../../src/northflank/tools/files';
import {
  DEFAULT_OUTPUT_LIMIT,
  resolveNeedsApproval,
  resolveProjectId,
  truncate,
} from '../../src/northflank/util';

/**
 * Build a stub ApiClient with deeply chained methods recorded as vi.fn(). The
 * real client is generated from OpenAPI and impractical to import in tests,
 * so we exercise the surface that our tools actually touch.
 *
 * Methods that return `ApiCallResponse` are stubbed to return `{ data }` (no
 * error). To simulate an HTTP failure, override the method to return
 * `{ data: undefined, error: { status, message } }`.
 */
function makeStubClient() {
  const calls: { method: string; args: any[] }[] = [];
  const make = (method: string, response: any = { data: { ok: true } }) =>
    vi.fn(async (...args: any[]) => {
      calls.push({ method, args });
      return response;
    });
  const client = {
    list: {
      projects: make('list.projects', {
        data: { projects: [{ id: 'p1', name: 'P1' }] },
      }),
      services: make('list.services', { data: { services: [{ id: 's1' }] } }),
      secrets: make('list.secrets', { data: { secrets: [] } }),
    },
    get: {
      project: make('get.project', { data: { id: 'p1', name: 'P1' } }),
      service: Object.assign(make('get.service', { data: { id: 's1' } }), {
        logs: make('get.service.logs', {
          data: [{ ts: new Date(0), containerId: 'c', log: 'hello' }],
        }),
        metricsRange: make('get.service.metricsRange', {
          data: { entries: [] },
        }),
      }),
    },
    create: {
      service: {
        deployment: make('create.service.deployment', {
          data: { id: 'new-svc' },
        }),
      },
    },
    patch: {
      service: {
        deployment: make('patch.service.deployment', { data: { id: 's1' } }),
      },
    },
    start: {
      service: {
        build: make('start.service.build', { data: { buildId: 'b1' } }),
      },
    },
    restart: {
      service: make('restart.service', { data: { ok: true } }),
    },
    scale: {
      service: make('scale.service', { data: { instances: 3 } }),
    },
    exec: {
      execServiceCommand: vi.fn(async () => ({
        commandResult: { exitCode: 0, status: 'Success' as const },
        stdOut: 'hi',
        stdErr: '',
      })),
      execJobCommand: vi.fn(async () => ({
        commandResult: { exitCode: 0, status: 'Success' as const },
        stdOut: '',
        stdErr: '',
      })),
      execAddonCommand: vi.fn(async () => ({
        commandResult: { exitCode: 0, status: 'Success' as const },
        stdOut: '',
        stdErr: '',
      })),
    },
    fileCopy: {
      uploadServiceFiles: vi.fn(async () => ({
        type: 'directory-upload',
        sourceDirectory: '/x',
        targetDirectory: '/y',
      })),
      downloadServiceFiles: vi.fn(async () => ({
        type: 'directory-download',
        sourceDirectory: '/y',
        targetDirectory: '/x',
      })),
    },
  };
  return { client, calls };
}

describe('northflankTools — assembly', () => {
  it('returns all default groups (~16 tools) when include is omitted', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any);
    // 4 read + 5 deploy + 3 exec + 2 files + 1 logs + 1 metrics = 16
    expect(tools).toHaveLength(16);
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('northflank_list_projects');
    expect(names).toContain('northflank_exec_service');
    expect(names).toContain('northflank_scale_service');
    // secrets is opt-in
    expect(names).not.toContain('northflank_list_secrets');
  });

  it('opting into the secrets group adds the 17th tool', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any, {
      include: [
        'read',
        'deploy',
        'exec',
        'files',
        'logs',
        'metrics',
        'secrets',
      ],
    });
    expect(tools).toHaveLength(17);
    expect(tools.map((t) => t.name)).toContain('northflank_list_secrets');
  });

  it('filters groups when include is narrowed', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any, { include: ['read'] });
    expect(tools).toHaveLength(4);
    for (const t of tools) expect(t.name.startsWith('northflank_')).toBe(true);
  });

  it('every tool exposes name/description/parameters/needsApproval', () => {
    const { client } = makeStubClient();
    for (const t of northflankTools(client as any)) {
      expect(t.type).toBe('function');
      expect(t.name).toMatch(/^northflank_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.parameters).toBeDefined();
      expect(typeof t.needsApproval).toBe('function');
    }
  });
});

describe('approvals policy', () => {
  it("'auto' marks mutating tools as needing approval and reads as not", () => {
    expect(resolveNeedsApproval('northflank_list_projects', 'auto')).toBe(
      false,
    );
    expect(resolveNeedsApproval('northflank_get_service', 'auto')).toBe(false);
    expect(resolveNeedsApproval('northflank_restart_service', 'auto')).toBe(
      true,
    );
    expect(resolveNeedsApproval('northflank_exec_service', 'auto')).toBe(true);
    expect(resolveNeedsApproval('northflank_upload_files', 'auto')).toBe(true);
    // download_files writes to the agent host filesystem — also gated.
    expect(resolveNeedsApproval('northflank_download_files', 'auto')).toBe(
      true,
    );
  });

  it("'always' / 'never' flip every tool uniformly", () => {
    expect(resolveNeedsApproval('northflank_list_projects', 'always')).toBe(
      true,
    );
    expect(resolveNeedsApproval('northflank_restart_service', 'never')).toBe(
      false,
    );
  });

  it('per-tool override beats the default', () => {
    expect(
      resolveNeedsApproval('northflank_restart_service', {
        northflank_restart_service: false,
      }),
    ).toBe(false);
    expect(
      resolveNeedsApproval('northflank_get_service', {
        northflank_get_service: true,
      }),
    ).toBe(true);
  });
});

describe('defaults & helpers', () => {
  it('resolveProjectId uses defaultProjectId when arg is missing', () => {
    expect(resolveProjectId(undefined, { defaultProjectId: 'p-default' })).toBe(
      'p-default',
    );
    expect(resolveProjectId('p-arg', { defaultProjectId: 'p-default' })).toBe(
      'p-arg',
    );
  });

  it('resolveProjectId throws a helpful error when nothing is set', () => {
    expect(() => resolveProjectId(undefined, {})).toThrow(
      /projectId is required/,
    );
  });

  it('truncate appends a clear marker past the limit', () => {
    const s = 'a'.repeat(100);
    const out = truncate(s, 10);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out).toMatch(/truncated 90 chars/);
  });

  it('truncate is a no-op under the limit', () => {
    expect(truncate('hi', DEFAULT_OUTPUT_LIMIT)).toBe('hi');
  });
});

describe('tool execution wiring', () => {
  it('list_projects calls the client and JSON-serialises the response data', async () => {
    const { client, calls } = makeStubClient();
    const tools = northflankTools(client as any);
    const listProjects = tools.find(
      (t) => t.name === 'northflank_list_projects',
    )!;

    const result = await listProjects.invoke({} as any, JSON.stringify({}));
    expect(calls[0]?.method).toBe('list.projects');
    expect(String(result)).toContain('P1');
    // We're returning .data, not the whole response.
    expect(String(result)).not.toContain('rawResponse');
  });

  it('exec_service formats stdout/stderr/exit code', async () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any, { approvals: 'never' });
    const execService = tools.find(
      (t) => t.name === 'northflank_exec_service',
    )!;
    const out = String(
      await execService.invoke(
        {} as any,
        JSON.stringify({ projectId: 'p', serviceId: 's', command: 'echo hi' }),
      ),
    );
    expect(out).toContain('exitCode=0');
    expect(out).toContain('--- stdout ---');
    expect(out).toContain('hi');
  });

  it('defaultProjectId lets the model omit projectId', async () => {
    const { client, calls } = makeStubClient();
    const tools = northflankTools(client as any, {
      defaultProjectId: 'p-default',
      approvals: 'never',
    });
    const listServices = tools.find(
      (t) => t.name === 'northflank_list_services',
    )!;
    await listServices.invoke({} as any, JSON.stringify({}));
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.method).toBe('list.services');
    expect(lastCall?.args[0]?.parameters?.projectId).toBe('p-default');
  });

  it('teamId is forwarded to read endpoints', async () => {
    const { client, calls } = makeStubClient();
    const tools = northflankTools(client as any, {
      teamId: 't-1',
      defaultProjectId: 'p',
      approvals: 'never',
    });
    const getService = tools.find((t) => t.name === 'northflank_get_service')!;
    await getService.invoke({} as any, JSON.stringify({ serviceId: 's' }));
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.args[0]?.parameters?.teamId).toBe('t-1');
  });

  it('thrown client errors are reported back to the model, not thrown', async () => {
    const { client } = makeStubClient();
    client.list.projects = vi.fn(async () => {
      throw new Error('boom');
    }) as any;
    const tools = northflankTools(client as any);
    const listProjects = tools.find(
      (t) => t.name === 'northflank_list_projects',
    )!;
    const out = String(
      await listProjects.invoke({} as any, JSON.stringify({})),
    );
    expect(out).toMatch(/Error listing projects: boom/);
  });

  it('non-2xx response.error is detected even when the client does not throw', async () => {
    // throwErrorOnHttpErrorCode: false (the JS client default) puts the
    // failure in response.error rather than throwing.
    const { client } = makeStubClient();
    client.get.service = vi.fn(async () => ({
      data: undefined,
      error: { status: 404, message: 'service not found', id: 'nf-404' },
    })) as any;
    const tools = northflankTools(client as any, { approvals: 'never' });
    const getService = tools.find((t) => t.name === 'northflank_get_service')!;
    const out = String(
      await getService.invoke(
        {} as any,
        JSON.stringify({ projectId: 'p', serviceId: 's' }),
      ),
    );
    expect(out).toMatch(/Error fetching service/);
    expect(out).toContain('HTTP 404');
    expect(out).toContain('service not found');
  });

  it('start_service_build maps commitSha to the JS-client `sha` field', async () => {
    // The JS client expects `sha`, not `buildSHA`.
    const { client, calls } = makeStubClient();
    const tools = northflankTools(client as any, {
      defaultProjectId: 'p',
      approvals: 'never',
    });
    const startBuild = tools.find(
      (t) => t.name === 'northflank_start_service_build',
    )!;
    await startBuild.invoke(
      {} as any,
      JSON.stringify({ serviceId: 's', commitSha: 'deadbeef' }),
    );
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.method).toBe('start.service.build');
    expect(lastCall?.args[0]?.data?.sha).toBe('deadbeef');
    expect(lastCall?.args[0]?.data?.buildSHA).toBeUndefined();
  });

  it('exec output splits the budget between stdout and stderr', async () => {
    // Total output must not exceed outputCharLimit even when both streams
    // are noisy.
    const { client } = makeStubClient();
    client.exec.execServiceCommand = vi.fn(async () => ({
      commandResult: { exitCode: 0, status: 'Success' as const },
      stdOut: 'o'.repeat(1000),
      stdErr: 'e'.repeat(1000),
    })) as any;
    const tools = northflankTools(client as any, {
      approvals: 'never',
      outputCharLimit: 100, // tiny cap to make truncation observable
    });
    const exec = tools.find((t) => t.name === 'northflank_exec_service')!;
    const out = String(
      await exec.invoke(
        {} as any,
        JSON.stringify({ projectId: 'p', serviceId: 's', command: 'x' }),
      ),
    );
    // Half the budget goes to each stream. Each stream of "o"/"e" should be
    // truncated to ~50 chars + truncation marker.
    const oRun = out.match(/o+/)?.[0] ?? '';
    const eRun = out.match(/e+/)?.[0] ?? '';
    expect(oRun.length).toBeLessThanOrEqual(50);
    expect(eRun.length).toBeLessThanOrEqual(50);
    expect(out).toMatch(/truncated/);
  });
});

describe('strict mode', () => {
  // Rich-body tools opt out of OpenAI Structured Outputs strict mode because
  // the Northflank service spec is too large to enumerate — strict mode would
  // require additionalProperties: false on every nested object.
  it('create_service / update_service_deployment / start_service_build are non-strict', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any);
    for (const name of [
      'northflank_create_service',
      'northflank_update_service_deployment',
      'northflank_start_service_build',
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect((t as any).strict).toBe(false);
    }
  });

  it('all other tools stay in strict mode', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any, {
      include: [
        'read',
        'deploy',
        'exec',
        'files',
        'logs',
        'metrics',
        'secrets',
      ],
    });
    const nonStrictNames = new Set([
      'northflank_create_service',
      'northflank_update_service_deployment',
      'northflank_start_service_build',
    ]);
    for (const t of tools) {
      if (nonStrictNames.has(t.name)) continue;
      expect((t as any).strict).toBe(true);
    }
  });
});

describe('timeouts', () => {
  it('exec tools inherit the default execTimeoutMs', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any);
    const exec = tools.find((t) => t.name === 'northflank_exec_service')!;
    expect((exec as any).timeoutMs).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  it('file tools inherit the default fileTimeoutMs', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any);
    const upload = tools.find((t) => t.name === 'northflank_upload_files')!;
    expect((upload as any).timeoutMs).toBe(DEFAULT_FILE_TIMEOUT_MS);
  });

  it('execTimeoutMs option overrides the default for all three exec tools', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any, { execTimeoutMs: 5_000 });
    for (const name of [
      'northflank_exec_service',
      'northflank_exec_job',
      'northflank_exec_addon',
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect((t as any).timeoutMs).toBe(5_000);
    }
  });

  it('fileTimeoutMs option overrides the default for both file tools', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any, { fileTimeoutMs: 10_000 });
    for (const name of [
      'northflank_upload_files',
      'northflank_download_files',
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect((t as any).timeoutMs).toBe(10_000);
    }
  });

  it('read/deploy/logs/metrics tools do not impose a timeout', () => {
    const { client } = makeStubClient();
    const tools = northflankTools(client as any);
    for (const name of [
      'northflank_list_projects',
      'northflank_get_service',
      'northflank_restart_service',
      'northflank_get_service_logs',
      'northflank_get_service_metrics',
    ]) {
      const t = tools.find((x) => x.name === name)!;
      expect((t as any).timeoutMs).toBeUndefined();
    }
  });
});
