import {
  SandboxWorkspaceArchiveReadError,
  SandboxWorkspaceReadNotFoundError,
} from '../errors';
import { shellQuote } from './shell';

export type SandboxPathProbeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: string | null;
  timedOut?: boolean;
  error?: Error;
};

type SandboxPathProbeOptions = {
  path: string;
  runCommand: (command: string) => Promise<SandboxPathProbeResult>;
  createError?: (result: SandboxPathProbeResult) => Error;
};

const READ_PATH_PROBE_SCRIPT = `
# OPENAI_AGENTS_READ_PATH_PROBE_V1
LC_ALL=C
export LC_ALL
original_path=$path
resolved_path=
symlink_depth=0
lookup_retries=0

resolve_probe_path() {
  if [ "$symlink_depth" -gt 40 ] || [ "\${#1}" -gt 4095 ]; then
    return 2
  fi
  if [ "$1" = / ]; then
    resolved_path=/
    return 0
  fi

  parent=\${1%/*}
  if [ -z "$parent" ] || [ "$parent" = "$1" ]; then
    parent=/
  fi
  resolve_probe_path "$parent" || return 2
  resolved_parent=$resolved_path
  base=\${1##*/}
  if [ "\${#base}" -gt 255 ]; then
    return 2
  fi
  if [ "$resolved_parent" = / ]; then
    candidate=/$base
  else
    candidate=$resolved_parent/$base
  fi

  if [ -L "$candidate" ]; then
    target_with_marker=$(readlink -n "$candidate" && printf .) || return 2
    target=\${target_with_marker%.}
    symlink_depth=$((symlink_depth + 1))
    if [ "$symlink_depth" -gt 40 ]; then
      return 2
    fi
    case "$target" in
      /*) resolve_probe_path "$target" ;;
      *) resolve_probe_path "$resolved_parent/$target" ;;
    esac
    return $?
  fi

  resolved_path=$candidate
}

resolve_probe_path "$path" || exit 2
path=$resolved_path
candidate=$path
child=

while :; do
  if [ -e "$candidate" ]; then
    if [ "$candidate" = "$path" ]; then
      exit 0
    fi
    if [ ! -d "$candidate" ] || [ ! -x "$candidate" ]; then
      exit 2
    fi
    lookup_result=$(
      find "$child" -prune -print 2>&1 >/dev/null
      lookup_status=$?
      printf '.%s' "$lookup_status"
    )
    lookup_status=\${lookup_result##*.}
    lookup_error=\${lookup_result%.*}
    if [ "$lookup_status" -eq 0 ]; then
      if [ "$lookup_retries" -ge 1 ]; then
        exit 2
      fi
      lookup_retries=$((lookup_retries + 1))
      resolved_path=
      symlink_depth=0
      resolve_probe_path "$original_path" || exit 2
      path=$resolved_path
      candidate=$path
      child=
      continue
    fi
    if [ "$lookup_status" -eq 1 ]; then
      lookup_error=$(printf %s "$lookup_error")
      case "$lookup_error" in
        *": No such file or directory") exit 1 ;;
      esac
    fi
    exit 2
  fi
  if [ "$candidate" = / ]; then
    exit 2
  fi
  child=$candidate
  candidate=\${candidate%/*}
  if [ -z "$candidate" ]; then
    candidate=/
  fi
done
`.trim();

export function isSandboxPathNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  try {
    if (error instanceof SandboxWorkspaceReadNotFoundError) {
      return true;
    }
    const code = (error as { code?: unknown }).code;
    return code === 'ENOENT' || code === 'workspace_read_not_found';
  } catch {
    return false;
  }
}

export async function probeSandboxPathExists(
  options: SandboxPathProbeOptions,
): Promise<boolean> {
  const quotedPath = shellQuote(options.path);
  const initial = await options.runCommand(`test -e ${quotedPath}`);
  if (initial.status === 0 && !hasProcessFailure(initial)) {
    return true;
  }
  if (initial.status !== 1 || hasProcessFailure(initial)) {
    throw createPathProbeError(options, initial);
  }

  const diagnostic = pathProbeDiagnostic(initial);
  if (diagnostic.length === 0 && initial.stdout?.trim()) {
    throw createPathProbeError(options, initial);
  }
  if (diagnostic.length > 0) {
    if (isMissingPathDiagnostic(diagnostic, options.path)) {
      return false;
    }
    if (!hasMissingPathDiagnostic(diagnostic)) {
      throw createPathProbeError(options, initial);
    }
  }

  const result = await options.runCommand(
    `test -e ${quotedPath} || (path=${quotedPath}; ${READ_PATH_PROBE_SCRIPT})`,
  );
  if (result.status === 0 && !hasProcessFailure(result)) {
    return true;
  }
  if (result.status === 1 && !hasProcessFailure(result)) {
    const probeDiagnostic = pathProbeDiagnostic(result);
    if (
      (!result.stdout?.trim() && probeDiagnostic.length === 0) ||
      isMissingPathDiagnostic(probeDiagnostic, options.path)
    ) {
      return false;
    }
  }
  throw createPathProbeError(options, result);
}

function hasProcessFailure(result: SandboxPathProbeResult): boolean {
  return Boolean(result.timedOut || result.signal || result.error);
}

function pathProbeDiagnostic(result: SandboxPathProbeResult): string {
  return result.stderr?.trim() ?? '';
}

function hasMissingPathDiagnostic(diagnostic: string): boolean {
  return /(?:no such file or directory|not found|does not exist|missing(?: path| file)?)/iu.test(
    diagnostic,
  );
}

function isMissingPathDiagnostic(diagnostic: string, path: string): boolean {
  if (!hasMissingPathDiagnostic(diagnostic)) {
    return false;
  }
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pathExpression = `(?:["'\\x60])?${escapedPath}(?:["'\\x60])?`;
  const missingExpression =
    '(?:no such file or directory|not found|does not exist|missing(?: path| file)?)';
  return new RegExp(
    `(?:${pathExpression}\\s*:\\s*${missingExpression}|${pathExpression}\\s+(?:was\\s+)?${missingExpression}|${missingExpression}\\s*:?\\s*${pathExpression})(?:$|[\\s.;])`,
    'iu',
  ).test(diagnostic);
}

function createPathProbeError(
  options: SandboxPathProbeOptions,
  result: SandboxPathProbeResult,
): Error {
  if (options.createError) {
    return options.createError(result);
  }
  const diagnostic = pathProbeDiagnostic(result);
  const suffix = diagnostic ? `: ${diagnostic}` : '';
  return new SandboxWorkspaceArchiveReadError(
    `Failed to determine whether sandbox path exists: ${options.path}${suffix}`,
    {
      path: options.path,
      status: result.status,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutBytes: result.stdout?.length ?? 0,
    },
  );
}
