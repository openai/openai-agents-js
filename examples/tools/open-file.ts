export type FileOpenInvocation = {
  command: string;
  args: string[];
};

export function getFileOpenInvocation(
  filePath: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): FileOpenInvocation {
  if (platform === 'darwin') {
    return { command: 'open', args: [filePath] };
  }

  if (platform === 'win32') {
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', filePath],
    };
  }

  return { command: 'xdg-open', args: [filePath] };
}
