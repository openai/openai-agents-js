import type {
  Entry,
  RcloneMountPattern,
  TypedMount,
} from '@openai/agents-core/sandbox';
import { isRcloneCloudBucketMountEntry } from '../shared/inContainerMounts';

export type RunloopCloudBucketMountStrategyOptions = {
  pattern?: RcloneMountPattern;
};

export class RunloopCloudBucketMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'runloop_cloud_bucket';
  readonly pattern: RcloneMountPattern;

  constructor(options: RunloopCloudBucketMountStrategyOptions = {}) {
    this.pattern = options.pattern ?? { type: 'rclone', mode: 'fuse' };
  }
}

export function isRunloopCloudBucketMountEntry(
  entry: Entry,
): entry is TypedMount {
  return isRcloneCloudBucketMountEntry(entry, 'runloop_cloud_bucket');
}
