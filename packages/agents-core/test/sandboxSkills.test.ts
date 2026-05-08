import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  skills,
  type Entry,
  type MaterializeEntryArgs,
  type SandboxSession,
  type SandboxSessionState,
  Manifest,
  SandboxSkillsConfigError,
} from '../src/sandbox';
import { localDirLazySkillSource } from '../src/sandbox/local';

class FakeSkillsSession implements SandboxSession {
  readonly state: SandboxSessionState;
  readonly existingPaths = new Set<string>();
  readonly materializeCalls: MaterializeEntryArgs[] = [];
  readonly files = new Map<string, string | Uint8Array>();

  constructor(manifest: Manifest = new Manifest()) {
    this.state = {
      manifest,
    };
  }

  async pathExists(path: string): Promise<boolean> {
    return this.existingPaths.has(path);
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    this.materializeCalls.push(args);
    this.existingPaths.add(`${args.path}/SKILL.md`);
  }

  async listDir(args: { path: string }) {
    const childNames = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(`${args.path}/`)) {
        continue;
      }
      const childName = path.slice(args.path.length + 1).split('/')[0];
      if (childName) {
        childNames.add(childName);
      }
    }
    return [...childNames].sort().map((name) => ({
      name,
      path: `${args.path}/${name}`,
      type: 'dir' as const,
    }));
  }

  async readFile(args: { path: string }): Promise<string | Uint8Array> {
    const content = this.files.get(args.path);
    if (typeof content === 'undefined') {
      throw new Error(`file not found: ${args.path}`);
    }
    return content;
  }
}

describe('Skills', () => {
  it('requires exactly one source', () => {
    expect(() => skills({})).toThrow(SandboxSkillsConfigError);
    expect(() => skills({})).toThrow(
      'skills capability requires `skills`, `from`, or `lazyFrom`.',
    );

    expect(() =>
      skills({
        skills: [
          {
            name: 'my-skill',
            description: 'desc',
            content: 'literal',
          },
        ],
        from: {
          type: 'dir',
          children: {},
        },
      }),
    ).toThrow(
      'skills capability accepts only one of `skills`, `from`, or `lazyFrom`.',
    );
  });

  it('materializes explicit skill descriptors into the manifest', () => {
    const capability = skills({
      skills: [
        {
          name: 'my-skill',
          description: 'desc',
          content: 'Use this skill.',
          scripts: {
            'run.sh': {
              type: 'file',
              content: 'echo run\n',
            },
          },
          references: {
            'docs/readme.md': {
              type: 'file',
              content: 'reference\n',
            },
          },
          assets: {
            'images/icon.txt': {
              type: 'file',
              content: 'asset\n',
            },
          },
        },
      ],
    });

    const manifest = capability.processManifest(new Manifest());
    const entry = manifest.entries['.agents/my-skill'] as Extract<
      Entry,
      { type: 'dir' }
    >;

    expect(entry.type).toBe('dir');
    expect(entry.children).toMatchObject({
      'SKILL.md': {
        type: 'file',
        content: 'Use this skill.',
      },
      scripts: {
        type: 'dir',
      },
      references: {
        type: 'dir',
      },
      assets: {
        type: 'dir',
      },
    });
  });

  it('renders instructions for explicit skills', async () => {
    const capability = skills({
      skills: [
        {
          name: 'z-skill',
          description: 'z description',
          content: 'z',
        },
        {
          name: 'a-skill',
          description: 'a description',
          content: 'a',
        },
      ],
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain('## Skills');
    expect(instructions).toContain(
      '- a-skill: a description (file: .agents/a-skill)',
    );
    expect(instructions).toContain(
      '- z-skill: z description (file: .agents/z-skill)',
    );
    expect(instructions!.indexOf('- a-skill: a description')).toBeLessThan(
      instructions!.indexOf('- z-skill: z description'),
    );
  });

  it('derives instructions for bundled skill directories without a manual index', async () => {
    const capability = skills({
      from: {
        type: 'dir',
        children: {
          'z-skill': {
            type: 'dir',
            description: 'z description',
            children: {
              'SKILL.md': {
                type: 'file',
                content: 'z',
              },
            },
          },
          'a-skill': {
            type: 'dir',
            description: 'a description',
            children: {
              'SKILL.md': {
                type: 'file',
                content: 'a',
              },
            },
          },
        },
      },
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain(
      '- a-skill: a description (file: .agents/a-skill)',
    );
    expect(instructions).toContain(
      '- z-skill: z description (file: .agents/z-skill)',
    );
    expect(instructions!.indexOf('- a-skill: a description')).toBeLessThan(
      instructions!.indexOf('- z-skill: z description'),
    );
  });

  it('accepts GitRepo sources and renders runtime discovery guidance', async () => {
    const capability = skills({
      from: {
        type: 'git_repo',
        repo: 'openai/skills',
        ref: 'main',
      },
    });
    const manifest = capability.processManifest(new Manifest());
    const instructions = await capability.instructions(manifest);

    expect(manifest.entries['.agents']).toMatchObject({
      type: 'git_repo',
      repo: 'openai/skills',
    });
    expect(instructions).toContain('Skills are materialized under .agents');
  });

  it('validates lazy path overlap against the manifest', () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });

    expect(() =>
      capability.processManifest(
        new Manifest({
          entries: {
            '.agents': {
              type: 'dir',
              children: {},
            },
          },
        }),
      ),
    ).toThrow(
      'skills lazyFrom path overlaps existing manifest entries: .agents',
    );
  });

  it('exposes load_skill for lazy sources and materializes one skill at a time', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });
    const session = new FakeSkillsSession();
    capability.bind(session);

    const tools = capability.tools();

    expect(tools.map((tool) => tool.name)).toEqual(['load_skill']);

    const first = await (tools[0] as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );
    const second = await (tools[0] as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );

    expect(first).toEqual({
      status: 'loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
    expect(second).toEqual({
      status: 'already_loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
    expect(session.materializeCalls).toEqual([
      {
        path: '.agents/dynamic-skill',
        entry: {
          type: 'local_dir',
          src: 'skills/dynamic-skill',
        },
        runAs: undefined,
      },
    ]);
  });

  it('discovers lazy local directory skill metadata from SKILL.md frontmatter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-'));
    try {
      const skillsRoot = join(root, 'skills');
      const skillDir = join(skillsRoot, 'sheet-tools');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: "spreadsheet-review"',
          "description: 'Review spreadsheets quickly'",
          '---',
          '# Spreadsheet review',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource(skillsRoot),
      });
      const manifest = new Manifest({
        extraPathGrants: [{ path: skillsRoot, readOnly: true }],
      });
      const instructions = await capability.instructions(manifest);

      expect(instructions).toContain(
        '- spreadsheet-review: Review spreadsheets quickly (file: .agents/sheet-tools)',
      );

      const session = new FakeSkillsSession(manifest);
      capability.bind(session);
      const [tool] = capability.tools();

      const result = await (tool as any).invoke(
        undefined,
        JSON.stringify({ skill_name: 'spreadsheet-review' }),
      );

      expect(result).toEqual({
        status: 'loaded',
        skill_name: 'spreadsheet-review',
        path: '.agents/sheet-tools',
      });
      expect(session.materializeCalls).toEqual([
        {
          path: '.agents/sheet-tools',
          entry: {
            type: 'local_dir',
            src: `${skillsRoot}/sheet-tools`,
          },
          runAs: undefined,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not discover lazy local directory metadata outside the base directory without a grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-outside-'));
    try {
      const skillsRoot = join(root, 'skills');
      const skillDir = join(skillsRoot, 'hidden-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource(skillsRoot),
      });
      const instructions = await capability.instructions(new Manifest());

      expect(instructions).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers lazy local directory metadata outside the base directory with a grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-granted-'));
    try {
      const skillsRoot = join(root, 'skills');
      const skillDir = join(skillsRoot, 'hidden-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource(skillsRoot),
      });
      const instructions = await capability.instructions(
        new Manifest({
          extraPathGrants: [{ path: skillsRoot, readOnly: true }],
        }),
      );

      expect(instructions).toContain(
        '- hidden-skill: Outside the base directory (file: .agents/hidden-skill)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not discover lazy local directory metadata through a symlinked source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-symlink-'));
    try {
      const base = join(root, 'base');
      const outsideSkillsRoot = join(root, 'outside-skills');
      const outsideSkillDir = join(outsideSkillsRoot, 'hidden-skill');
      mkdirSync(base);
      mkdirSync(outsideSkillDir, { recursive: true });
      writeFileSync(
        join(outsideSkillDir, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );
      symlinkSync(outsideSkillsRoot, join(base, 'skills'), 'dir');

      const capability = skills({
        lazyFrom: localDirLazySkillSource({
          src: 'skills',
          baseDir: base,
        }),
      });
      const instructions = await capability.instructions(new Manifest());

      expect(instructions).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not discover lazy local directory metadata through a symlinked SKILL.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-file-symlink-'));
    try {
      const base = join(root, 'base');
      const skillDir = join(base, 'skills', 'hidden-skill');
      const outside = join(root, 'outside');
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(outside);
      writeFileSync(
        join(outside, 'SKILL.md'),
        [
          '---',
          'name: hidden-skill',
          'description: Outside the base directory',
          '---',
          '# Hidden skill',
        ].join('\n'),
        'utf8',
      );
      symlinkSync(join(outside, 'SKILL.md'), join(skillDir, 'SKILL.md'));

      const capability = skills({
        lazyFrom: localDirLazySkillSource({
          src: 'skills',
          baseDir: base,
        }),
      });
      const instructions = await capability.instructions(new Manifest());

      expect(instructions).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves lazy local directory skill sources against baseDir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-skills-base-'));
    try {
      const skillDir = join(root, 'skills', 'relative-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: relative-skill',
          'description: Uses a relative baseDir source',
          '---',
          '# Relative skill',
        ].join('\n'),
        'utf8',
      );

      const capability = skills({
        lazyFrom: localDirLazySkillSource({
          src: 'skills',
          baseDir: root,
        }),
      });
      const session = new FakeSkillsSession();
      capability.bind(session);
      const [tool] = capability.tools();

      const result = await (tool as any).invoke(
        undefined,
        JSON.stringify({ skill_name: 'relative-skill' }),
      );

      expect(result).toMatchObject({
        status: 'loaded',
        skill_name: 'relative-skill',
        path: '.agents/relative-skill',
      });
      expect(session.materializeCalls).toEqual([
        {
          path: '.agents/relative-skill',
          entry: {
            type: 'local_dir',
            src: `${root}/skills/relative-skill`,
          },
          runAs: undefined,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads materialized from skill metadata from the bound session', async () => {
    const capability = skills({
      from: {
        type: 'dir',
        children: {},
      },
    });
    const session = new FakeSkillsSession();
    session.files.set(
      '.agents/sheet-tools/SKILL.md',
      [
        '---',
        'name: "spreadsheet-review"',
        "description: 'Review spreadsheets quickly'",
        '---',
        '# Spreadsheet review',
      ].join('\n'),
    );
    capability.bind(session);

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain(
      '- spreadsheet-review: Review spreadsheets quickly (file: .agents/sheet-tools)',
    );
  });

  it('renders lazy loading guidance for lazy skill sources', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });

    const instructions = await capability.instructions(new Manifest());

    expect(instructions).toContain('### Lazy loading');
    expect(instructions).toContain('Call `load_skill`');
    expect(instructions).toContain(
      '- dynamic-skill: dynamic (file: .agents/dynamic-skill)',
    );
  });

  it('supports capability-level indexes for lazy sources', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: 'skills',
        },
      },
      index: [
        {
          name: 'dynamic-skill',
          description: 'dynamic',
        },
      ],
    });
    const session = new FakeSkillsSession();
    capability.bind(session);

    const instructions = await capability.instructions(new Manifest());
    const [tool] = capability.tools();
    const result = await (tool as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );

    expect(instructions).toContain(
      '- dynamic-skill: dynamic (file: .agents/dynamic-skill)',
    );
    expect(result).toEqual({
      status: 'loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
  });

  it('materializes lazy skills from GitRepo subpaths', async () => {
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'git_repo',
          repo: 'openai/skills',
          ref: 'main',
          subpath: 'bundled',
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });
    const session = new FakeSkillsSession();
    capability.bind(session);

    const tools = capability.tools();
    await (tools[0] as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );

    expect(session.materializeCalls).toEqual([
      {
        path: '.agents/dynamic-skill',
        entry: {
          type: 'git_repo',
          repo: 'openai/skills',
          ref: 'main',
          subpath: 'bundled/dynamic-skill',
        },
        runAs: undefined,
      },
    ]);
  });
});
