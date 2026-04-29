import type { Capability } from './base';
import { compaction } from './compaction';
import { filesystem } from './filesystem';
import { shell } from './shell';

export { Capability } from './base';
export type { ConfigureCapabilityTools } from './base';
export {
  CompactionModelInfo,
  CompactionPolicy,
  DynamicCompactionPolicy,
  StaticCompactionPolicy,
  compaction,
} from './compaction';
export type { Compaction } from './compaction';
export { filesystem } from './filesystem';
export type { Filesystem, FilesystemArgs } from './filesystem';
export { memory } from './memory';
export { InMemoryMemoryStore } from '../memory/storage';
export type {
  Memory,
  MemoryArgs,
  MemoryGenerateConfig,
  MemoryLayoutConfig,
  MemoryReadConfig,
} from './memory';
export type { MemoryStore } from '../memory/storage';
export { shell } from './shell';
export type { Shell, ShellArgs } from './shell';
export { skills } from './skills';
export type {
  LocalDirLazySkillSource,
  SkillDescriptor,
  SkillIndexEntry,
  Skills,
  SkillsArgs,
} from './skills';

function defaultCapabilities(): Capability[] {
  return [filesystem(), shell(), compaction()];
}

export const Capabilities = {
  default: defaultCapabilities,
} as const;
