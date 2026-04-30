import type {
  Entry,
  RcloneMountPattern,
  TypedMount,
} from '@openai/agents-core/sandbox';
import { isRcloneCloudBucketMountEntry } from '../shared/inContainerMounts';

export type DaytonaCloudBucketMountStrategyOptions = {
  pattern?: RcloneMountPattern;
};

export class DaytonaCloudBucketMountStrategy {
  readonly [key: string]: unknown;
  readonly type = 'daytona_cloud_bucket';
  readonly pattern: RcloneMountPattern;

  constructor(options: DaytonaCloudBucketMountStrategyOptions = {}) {
    this.pattern = options.pattern ?? { type: 'rclone', mode: 'fuse' };
  }
}

export function isDaytonaCloudBucketMountEntry(
  entry: Entry,
): entry is TypedMount {
  return isRcloneCloudBucketMountEntry(entry, 'daytona_cloud_bucket');
}
