import { execSync } from 'child_process';
import { platform, arch } from 'os';
import path from 'path';
import fs from 'fs';
import https from 'https';

const getLatestTrufflehogVersion = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    https
      .get(
        'https://api.github.com/repos/trufflesecurity/trufflehog/releases/latest',
        {
          headers: { 'User-Agent': 'node.js' }, // GitHub API requires a User-Agent
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.tag_name); // Example: "v3.63.2"
            } catch (err) {
              reject(err);
            }
          });
        },
      )
      .on('error', reject);
  });
};

interface PlatformConfig {
  os: string;
  ext: string;
}

interface PlatformInfo {
  os: string;
  arch: string;
  ext: string;
}

const getPlatformInfo = (): PlatformInfo => {
  const currentOs = platform();
  const architecture = arch();

  const platforms: Record<string, PlatformConfig> = {
    win32: { os: 'windows', ext: '.exe' },
    darwin: { os: 'darwin', ext: '' },
    linux: { os: 'linux', ext: '' },
  };

  const archs: Record<string, string> = {
    x64: 'amd64',
    arm64: 'arm64',
  };

  if (!platforms[currentOs] || !archs[architecture]) {
    throw new Error(`Unsupported platform: ${currentOs} ${architecture}`);
  }

  return {
    os: platforms[currentOs].os,
    arch: archs[architecture],
    ext: platforms[currentOs].ext,
  };
};

const getBinaryPath = (): string => {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('HOME or USERPROFILE environment variable not set');
  }
  const binDir = path.join(home, '.local', 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  return binDir;
};

const downloadFile = (url: string, dest: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error('Redirect location not found'));
          return;
        }
        file.close();
        downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {
          reject(
            new Error(
              `Failed to download file. HTTP status code: ${response.statusCode} - ${response.statusMessage}`,
            ),
          );
        });
        return;
      }

      const contentLength = parseInt(
        response.headers['content-length'] || '0',
        10,
      );
      let downloadedBytes = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (contentLength > 0) {
          const progress = (downloadedBytes / contentLength) * 100;
          process.stdout.write(`\rDownloading... ${progress.toFixed(1)}%`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        process.stdout.write('\n');
        file.close();

        const stats = fs.statSync(dest);
        if (stats.size === 0) {
          fs.unlinkSync(dest);
          reject(new Error('Downloaded file is empty'));
          return;
        }

        fs.chmodSync(dest, '755');
        resolve();
      });
    });

    request.on('error', (err: Error) => {
      fs.unlink(dest, () => reject(err));
    });

    request.setTimeout(30000, () => {
      request.destroy();
      fs.unlink(dest, () => reject(new Error('Download timeout')));
    });
  });
};

const isTrufflehogInstalled = (): boolean => {
  try {
    execSync('trufflehog --help', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const updatePathInShellConfig = async (binPath: string): Promise<void> => {
  const shell = process.env.SHELL;
  const home = process.env.HOME;

  if (!home) {
    throw new Error('HOME or USERPROFILE environment variable not set');
  }

  let configFile = '';
  if (shell?.includes('zsh')) {
    configFile = path.join(home, '.zshrc');
  } else {
    configFile = path.join(home, '.bashrc');
  }

  const pathLine = `\n# Added by trufflehog installer\nexport PATH="${binPath}:$PATH"\n`;

  try {
    const content = fs.existsSync(configFile)
      ? fs.readFileSync(configFile, 'utf-8')
      : '';

    if (!content.includes(binPath)) {
      fs.appendFileSync(configFile, pathLine);
      console.log(`Updated ${configFile} with PATH configuration`);
    }
  } catch (error) {
    console.error(
      'Failed to update shell configuration:',
      error instanceof Error ? error.message : String(error),
    );
  }
};

const installTrufflehog = async (): Promise<void> => {
  try {
    const { os, arch, ext } = getPlatformInfo();
    const TRUFFLEHOG_VERSION = await getLatestTrufflehogVersion();
    const versionNumber = TRUFFLEHOG_VERSION.startsWith('v')
      ? TRUFFLEHOG_VERSION.slice(1)
      : TRUFFLEHOG_VERSION;
    const archiveName = `trufflehog_${versionNumber}_${os}_${arch}.tar.gz`;
    const downloadUrl = `https://github.com/trufflesecurity/trufflehog/releases/download/${TRUFFLEHOG_VERSION}/${archiveName}`;

    // TODO: Add support for windows
    if (os === 'windows') {
      throw new Error(
        `Windows is not supported for trufflehog auto installation kindly install it manually from ${downloadUrl}`,
      );
    }

    const binPath = getBinaryPath();
    const archivePath = path.join(binPath, archiveName);

    console.log(`Downloading trufflehog archive from ${downloadUrl}`);
    await downloadFile(downloadUrl, archivePath);

    execSync(`tar -xzf ${archivePath} -C ${binPath}`);
    fs.unlinkSync(archivePath);

    const binaryName = `trufflehog${ext}`;
    const binaryPath = path.join(binPath, binaryName);

    // Set executable permission on the binary
    fs.chmodSync(binaryPath, 0o755);

    await updatePathInShellConfig(binPath);

    console.log('trufflehog installed successfully!');
  } catch (error) {
    console.error(
      'Failed to install trufflehog:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
};

const main = async (): Promise<void> => {
  try {
    if (!isTrufflehogInstalled()) {
      console.log('trufflehog is not installed.');
      await installTrufflehog();

      if (!isTrufflehogInstalled()) {
        throw new Error('Installation verification failed');
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

// Wait for the promise to resolve before exiting
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
