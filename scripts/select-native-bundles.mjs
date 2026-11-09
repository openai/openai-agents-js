import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { nativeInputs } from './native-bundle-inputs.mjs';
import {
  downloadNativeBundle,
  findNativeBundle,
  nativePlatforms,
  waitForNativeProducer,
} from './verified-native-bundle.mjs';

const inputs = nativeInputs();
const output = (name, value) =>
  appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');
output('inputs_hash', inputs);
const candidates = new Map();
function recordCandidate(run, platform) {
  if (!candidates.has(run.id))
    candidates.set(run.id, { run, platforms: new Set() });
  candidates.get(run.id).platforms.add(platform);
}
async function stageBundle(platform, { onInFlight, fallbackOnError } = {}) {
  let asset;
  let bytes;
  try {
    asset = findNativeBundle(inputs, platform, onInFlight);
    bytes = asset && (await downloadNativeBundle(asset));
  } catch (error) {
    if (!fallbackOnError) throw error;
    console.log(platform + ': Could not recheck the finished Alpha run.');
    return undefined;
  }
  if (!bytes) return undefined;
  // Cross-platform archives remain opaque bytes; preflight never executes or extracts them.
  writeFileSync(
    join(
      process.env.RUNNER_TEMP,
      'native-' + inputs + '-' + platform + '.tar.gz',
    ),
    bytes,
  );
  return asset;
}
const onInFlight =
  process.env.GITHUB_EVENT_NAME === 'pull_request'
    ? recordCandidate
    : undefined;
const staged = new Map();
for (const platform of Object.values(nativePlatforms)) {
  const asset = await stageBundle(platform, { onInFlight });
  if (asset) staged.set(platform, asset);
}
// A partial hit can start its own PR package job as soon as preflight ends.
if (staged.size === 0 && (await waitForNativeProducer(candidates.values()))) {
  for (const platform of Object.values(nativePlatforms)) {
    const asset = await stageBundle(platform, { fallbackOnError: true });
    if (asset) staged.set(platform, asset);
  }
}
for (const [key, platform] of Object.entries(nativePlatforms)) {
  const asset = staged.get(platform);
  output(key + '_hit', Boolean(asset));
  const message = asset
    ? 'Verified native artifact ' + asset.id + ' from run ' + asset.run
    : 'No qualified retained native bundle; building from source.';
  console.log(platform + ': ' + message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      'Native bundle (' + platform + ', ' + inputs + '): ' + message + '\n',
    );
}
