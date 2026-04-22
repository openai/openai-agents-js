import type {
  Entry,
  RcloneMountPattern,
  TypedMount,
} from '@openai/agents-core/sandbox';
import { isRcloneCloudBucketMountEntry } from '../shared/inContainerMounts';

export type E2BCloudBucketMountStrategyOptions = {
  pattern?: RcloneMountPattern;
};

export class E2BCloudBucketMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'e2b_cloud_bucket';
  readonly pattern: RcloneMountPattern;

  constructor(options: E2BCloudBucketMountStrategyOptions = {}) {
    this.pattern = options.pattern ?? { type: 'rclone', mode: 'fuse' };
  }
}

export function isE2BCloudBucketMountEntry(entry: Entry): entry is TypedMount {
  return isRcloneCloudBucketMountEntry(entry, 'e2b_cloud_bucket');
}
