import { z } from 'zod';
import { tool, type Tool } from '../../tool';
import type { Entry } from '../entries';
import { SandboxSkillsConfigError } from '../errors';
import type { Manifest } from '../manifest';
import type { MaterializeEntryArgs } from '../session';
import {
  createSkillConfiguration,
  processSkillManifest,
  resolveSkillRuntimeMetadata,
  resolveSkillsMetadata,
  renderSkillsDiscoveryInstructions,
  renderSkillsInstructions,
  resolveLazySkillMatch,
  resolveLazySkillEntry,
  joinRelativePaths,
  type SkillDescriptor,
  type LocalDirLazySkillSource,
  type SkillIndexEntry,
  type SkillsArgs,
} from '../skillResources';
import { normalizeRelativePath } from '../manifest';
import { Capability, requireBoundSession } from './base';
export type {
  SkillDescriptor,
  LocalDirLazySkillSource,
  SkillIndexEntry,
  SkillsArgs,
} from '../skillResources';
export { parseSkillFrontmatter } from '../skillResources';

class SkillsCapability extends Capability {
  readonly type = 'skills';
  readonly skills: SkillDescriptor[];
  readonly from?: Entry;
  readonly lazyFrom?: LocalDirLazySkillSource;
  readonly index?: SkillIndexEntry[];
  readonly skillsPath: string;

  constructor(args: SkillsArgs) {
    super();
    const configuration = createSkillConfiguration(args);
    this.skills = configuration.skills;
    this.from = configuration.from;
    this.lazyFrom = configuration.lazyFrom;
    this.index = configuration.index;
    this.skillsPath = configuration.skillsPath;
  }

  override tools(): Tool<any>[] {
    if (!this.lazyFrom) {
      return [];
    }

    const session = requireBoundSession(this.type, this._session);
    if (!session.pathExists || !session.materializeEntry) {
      throw new SandboxSkillsConfigError(
        'Skills sandbox sessions must provide pathExists() and materializeEntry().',
      );
    }

    return [
      tool({
        name: 'load_skill',
        description:
          'Load a single lazily configured skill into the sandbox so its SKILL.md, scripts, references, and assets can be read from the workspace.',
        parameters: z.object({
          skill_name: z
            .string()
            .min(1)
            .describe('Name of the lazily configured skill to materialize.'),
        }),
        execute: async ({
          skill_name,
        }: {
          skill_name: string;
        }): Promise<{
          status: 'loaded' | 'already_loaded';
          skill_name: string;
          path: string;
        }> => {
          const match = resolveLazySkillMatch(
            this,
            skill_name,
            session.state.manifest,
          );
          const relativeSkillPath = normalizeRelativePath(
            match.path ?? match.name,
          );
          const destinationPath = joinRelativePaths(
            this.skillsPath,
            relativeSkillPath,
          );
          const skillMarkdownPath = joinRelativePaths(
            destinationPath,
            'SKILL.md',
          );

          if (await session.pathExists!(skillMarkdownPath, this._runAs)) {
            return {
              status: 'already_loaded',
              skill_name: match.name,
              path: this.modelResourcePath(
                session.state.manifest,
                destinationPath,
              ),
            };
          }

          await session.materializeEntry!({
            path: destinationPath,
            entry: resolveLazySkillEntry(
              this.lazyFrom!.source,
              relativeSkillPath,
            ),
            runAs: this._runAs,
          } satisfies MaterializeEntryArgs);

          return {
            status: 'loaded',
            skill_name: match.name,
            path: this.modelResourcePath(
              session.state.manifest,
              destinationPath,
            ),
          };
        },
      }),
    ];
  }

  override processManifest(manifest: Manifest): Manifest {
    return processSkillManifest(this, manifest);
  }

  override async instructions(manifest: Manifest): Promise<string | null> {
    const metadata = resolveSkillsMetadata(
      this,
      await resolveSkillRuntimeMetadata(this, this._session, this._runAs),
      manifest,
    ).map((skill) => ({
      ...skill,
      path: this.modelResourcePath(manifest, skill.path ?? skill.name),
    }));
    if (metadata.length === 0 && this.from) {
      return renderSkillsDiscoveryInstructions(
        this.modelResourcePath(manifest, this.skillsPath),
      );
    }
    if (metadata.length === 0) {
      return null;
    }

    return renderSkillsInstructions({
      metadata,
      lazy: Boolean(this.lazyFrom),
    });
  }
}

export type Skills = SkillsCapability;

export function skills(args: SkillsArgs): Skills;
export function skills(args: SkillsArgs): Skills {
  return new SkillsCapability(args);
}
