import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DeferredTools } from '../../src/experimental/deferred';
import { deferredTool } from '../../src/experimental/deferred-tool';
import { manualTool } from '../../src/runtime/manual';

function declaration(name = 'job', built = () => {}) {
  return deferredTool({
    name,
    description: 'Prepare a job',
    schemas: (z) => {
      built();
      return {
        parameters: z.strictObject({ id: z.string() }),
        result: z.string(),
      };
    },
  });
}
const provider = () => ({
  start: vi.fn(async () => ({ status: 'completed' as const })),
  observe: vi.fn(async () => ({ status: 'unknown' as const })),
  reconcileCreation: vi.fn(async () => ({ status: 'unknown' as const })),
});
const coordinator = () =>
  new DeferredTools({
    tenant: 'tenant',
    runId: 'run',
    journal: {
      prepare: vi.fn(),
      claim: vi.fn(),
      authorize: vi.fn(),
      record: vi.fn(),
      saveResult: vi.fn(),
    },
  });

describe('private deferred registration', () => {
  it('registers captured declarations without replaying builders or invoking providers', () => {
    const built = vi.fn();
    const job = declaration('job', built);
    const backend = provider();
    const project = vi.fn(String);
    const jobs = coordinator();
    jobs.register(job, { providerId: 'backend', provider: backend, project });
    expect(built).toHaveBeenCalledTimes(1);
    for (const operation of Object.values(backend))
      expect(operation).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(() =>
      jobs.register(declaration(), {
        providerId: 'backend',
        provider: backend,
        project,
      }),
    ).toThrow('unique name');
    expect(built).toHaveBeenCalledTimes(1);
  });
  it('requires captured deferred declarations, configured providers and positive result limits', () => {
    const registration = {
      providerId: 'backend',
      provider: provider(),
      project: String,
    };
    const ordinary = manualTool({
      name: 'ordinary',
      description: '',
      parameters: z.object({ id: z.string() }),
      result: z.string(),
    });
    expect(() => coordinator().register(ordinary, registration)).toThrow(
      'deferredTool declaration',
    );
    expect(() =>
      coordinator().register(declaration(), {
        ...registration,
        providerId: '',
      }),
    ).toThrow('configured provider');
    for (const maxOutputBytes of [0, -1, 0.5, Infinity])
      expect(() =>
        coordinator().register(declaration(), {
          ...registration,
          maxOutputBytes,
        }),
      ).toThrow('positive byte counts');
  });
  it('requires strong reconciliation by default and accepts an explicitly weak provider', () => {
    const backend = provider();
    const registration = {
      providerId: 'weak',
      provider: { start: backend.start, observe: backend.observe },
      project: String,
    };
    const jobs = coordinator();
    expect(() => jobs.register(declaration(), registration)).toThrow(
      'creation reconciliation',
    );
    expect(() =>
      jobs.register(declaration(), {
        ...registration,
        requireReconciliation: false,
      }),
    ).not.toThrow();
    expect(() =>
      coordinator().register(declaration(), {
        ...registration,
        requireReconciliation: true,
      }),
    ).toThrow('creation reconciliation');
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.observe).not.toHaveBeenCalled();
  });
});
