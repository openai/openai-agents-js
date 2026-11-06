import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { nativeInputs } from './native-bundle-inputs.mjs';
import {
  downloadNativeBundle,
  findNativeBundle,
  nativePlatforms,
} from './verified-native-bundle.mjs';

const inputs = nativeInputs();
const output = (name, value) =>
  appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');
output('inputs_hash', inputs);
for (const [key, platform] of Object.entries(nativePlatforms)) {
  const asset = findNativeBundle(inputs, platform);
  const bytes = asset && (await downloadNativeBundle(asset));
  output(key + '_hit', Boolean(bytes));
  const message = bytes
    ? 'Verified native artifact ' + asset.id + ' from run ' + asset.run
    : 'No qualified retained native bundle; building from source.';
  console.log(platform + ': ' + message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      'Native bundle (' + platform + ', ' + inputs + '): ' + message + '\n',
    );
  // Cross-platform archives remain opaque bytes; preflight never executes or extracts them.
  if (bytes)
    writeFileSync(
      join(
        process.env.RUNNER_TEMP,
        'native-' + inputs + '-' + platform + '.tar.gz',
      ),
      bytes,
    );
}
