export function resolvedRemotePathFromValidationCommand(
  command: string,
): string | undefined {
  if (!command.includes('resolve-workspace-path.sh')) {
    return undefined;
  }
  const match = command.match(
    /"\$helper_path"\s+'[^']*'\s+'([^']*)'\s+'[01]'/u,
  );
  return match?.[1]?.replace(/'\\''/g, "'");
}
