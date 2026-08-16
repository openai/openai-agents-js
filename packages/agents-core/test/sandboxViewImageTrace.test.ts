import { afterEach, describe, expect, it } from 'vitest';
import { RunContext } from '../src';
import {
  addSandboxEventSink,
  clearSandboxEventSinks,
  filesystem,
  Manifest,
  SandboxWorkspaceScope,
  type SandboxEvent,
} from '../src/sandbox';

describe('sandbox view_image tracing', () => {
  afterEach(() => {
    clearSandboxEventSinks();
  });

  it('records the same run-scoped path that view_image reads', async () => {
    const events: SandboxEvent[] = [];
    const readPaths: string[] = [];
    addSandboxEventSink((event) => {
      events.push(event);
    });

    const session = {
      state: { manifest: new Manifest() },
      createEditor: () => ({
        createFile: async () => undefined,
        updateFile: async () => undefined,
        deleteFile: async () => undefined,
      }),
      viewImage: async ({ path }: { path: string }) => {
        readPaths.push(path);
        return { type: 'image', image: 'image-ref' };
      },
    } as any;

    const capability = filesystem();
    capability
      .bind(session)
      .bindWorkspaceScope(SandboxWorkspaceScope.fromCwd('tasks/a'));
    const [viewImage] = capability.tools();

    await (viewImage as any).invoke(
      new RunContext(),
      JSON.stringify({ path: 'plot.png' }),
    );

    expect(readPaths).toEqual(['tasks/a/plot.png']);
    expect(
      events
        .filter((event) => event.name === 'sandbox.view_image')
        .map((event) => event.data?.path),
    ).toEqual(['tasks/a/plot.png', 'tasks/a/plot.png']);
  });
});
