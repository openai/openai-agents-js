import { NativeError } from './native-error';

export type FeatureName =
  | 'nativeOutput'
  | 'promptedOutput'
  | 'manualSuspend'
  | 'nativeOutputManualRestore'
  | 'toolSelection'
  | 'functionPolicy'
  | 'mcpBeforePolicy'
  | 'mcpResultPolicy'
  | 'environmentBeforePolicy'
  | 'environmentCodeResultPolicy'
  | 'nativeAgents'
  | 'remoteSkills'
  | 'checklist';
export type FeatureSupport = Readonly<{
  status: 'supported' | 'limited' | 'unsupported';
  reason: string;
  scope: string;
}>;
export interface Capabilities {
  readonly websocketsAllowed: boolean;
  get(feature: FeatureName): FeatureSupport;
  require(feature: FeatureName, options?: { allowLimited?: boolean }): void;
}
export type CheckpointStatus = Readonly<{
  status: 'ready' | 'notReady' | 'unknown';
  reasons: readonly string[];
}>;
export class CapabilityError extends NativeError {
  constructor(
    readonly feature: FeatureName,
    readonly support: FeatureSupport,
  ) {
    super(`${support.reason} ${support.scope}`);
    this.support = Object.freeze({ ...support });
  }
}

/** @internal Facts come from one healthy Session's admitted owners. */
export interface CapabilityFacts {
  manual: boolean;
  manualRestore: boolean;
  functionCallback: boolean;
  mcp: boolean;
  executor: boolean;
  codeMode: boolean;
  nativeAgents: boolean;
  local: boolean;
  remoteSkills: boolean;
  checklist: boolean;
}
const features: readonly string[] = [
  'nativeOutput',
  'promptedOutput',
  'manualSuspend',
  'nativeOutputManualRestore',
  'toolSelection',
  'functionPolicy',
  'mcpBeforePolicy',
  'mcpResultPolicy',
  'environmentBeforePolicy',
  'environmentCodeResultPolicy',
  'nativeAgents',
  'remoteSkills',
  'checklist',
];

/** @internal No native calls, policy invocation or authority transfer. */
export function createCapabilities(
  healthy: () => void,
  read: (feature: FeatureName) => FeatureSupport,
  websocketsAllowed: boolean,
): Capabilities {
  const get = (feature: FeatureName): FeatureSupport => {
    if (!features.includes(feature))
      throw new TypeError('Unknown feature name');
    healthy();
    return read(feature);
  };
  return Object.freeze({
    get websocketsAllowed() {
      healthy();
      return websocketsAllowed;
    },
    get,
    require(feature: FeatureName, options?: { allowLimited?: boolean }): void {
      const support = get(feature);
      if (
        support.status === 'unsupported' ||
        (support.status === 'limited' && options?.allowLimited !== true)
      )
        throw new CapabilityError(feature, support);
    },
  });
}

/** @internal Each result is a detached, immutable configuration report. */
export function featureSupport(
  feature: FeatureName,
  facts: CapabilityFacts,
): FeatureSupport {
  const report = (
    status: FeatureSupport['status'],
    reason: string,
    scope: string,
  ): FeatureSupport => Object.freeze({ status, reason, scope });
  switch (feature) {
    case 'nativeOutput':
      return report(
        'supported',
        'Native schema output is available for new root Turns.',
        'Admitted root routes only; settled manual checkpoints retain matching schemas; children remain plain text.',
      );
    case 'promptedOutput':
      return report(
        'limited',
        facts.local
          ? 'Prompted root output with persistent storage supports zero retries.'
          : 'Prompted root output supports bounded formatting repair.',
        'Local final-output validation; corrections have no original tools or context; children remain plain text.',
      );
    case 'manualSuspend':
      if (facts.local)
        return report(
          'unsupported',
          'Persistent storage cannot export SessionState.',
          'Retain Session.id and reopen with the same storage backend; no portable manual transfer.',
        );
      if (!facts.manual)
        return report(
          'unsupported',
          'No supported manual-transfer configuration is admitted.',
          'Current configured manual slots and existing environment, MCP and Code Mode restrictions.',
        );
      return report(
        'limited',
        'Settled manual Turns can be suspended.',
        'Configuration support only; current root output, grants, joins and queue admission still govern suspend.',
      );
    case 'nativeOutputManualRestore':
      if (facts.local || !facts.manualRestore)
        return report(
          'unsupported',
          facts.local
            ? 'Persistent storage cannot export SessionState.'
            : 'No current manual declarations support portable restore.',
          'Portable restore requires current matching manual declarations and a settled checkpoint.',
        );
      return report(
        'limited',
        'Settled manual checkpoints retain the root output schema.',
        'Current declarations and output contract must match. Capture still checks grants, joins and callback selection; no active code continuation is serialized.',
      );
    case 'toolSelection':
      return report(
        'limited',
        'Root operations select one native tool plan before each model request.',
        'Selection narrows opening-admitted functions, MCP, executor, hosted and Code Mode tools. Yielded cells retain their issuing plan. Root selection is not a transitive child ceiling; children retain their separately admitted authority.',
      );
    case 'functionPolicy':
      return facts.functionCallback
        ? report(
            'supported',
            'Current function callbacks support before, after and result validation.',
            'Selected captured callbacks only, including admitted native children; callback-less manual declarations have no function policies.',
          )
        : report(
            'unsupported',
            'No function callback is currently acknowledged.',
            'Manual declarations and call metadata grant no callback policy.',
          );
    case 'mcpBeforePolicy':
      return facts.mcp
        ? report(
            'supported',
            'Selected MCP tools support configured before and approval callbacks.',
            'Acknowledged tools only, for root and admitted native children. Policy updates require closed native children and released callbacks; denial does not atomically stop a Turn.',
          )
        : report(
            'unsupported',
            'No acknowledged MCP tools are selected.',
            'Current roster only.',
          );
    case 'mcpResultPolicy':
      return facts.mcp
        ? report(
            'supported',
            'Selected MCP tools support configured result transforms.',
            'Acknowledged HTTP or stdio routes; policies do not undo effects.',
          )
        : report(
            'unsupported',
            'No acknowledged MCP tools are selected.',
            'Current roster only.',
          );
    case 'environmentBeforePolicy':
      return facts.executor
        ? report(
            'supported',
            'Admitted executor tools support configured approval and argument transforms.',
            'Current Environment; root and admitted native children; no general built-in before hook.',
          )
        : report(
            'unsupported',
            'No admitted executor tools are selected.',
            'Current Environment only.',
          );
    case 'environmentCodeResultPolicy':
      if (!facts.executor)
        return report(
          'unsupported',
          'No admitted executor tools are selected.',
          'Current Environment only.',
        );
      return report(
        'limited',
        'Controls admitted builtin results before model, code and observation publication.',
        'exec_command, write_stdin, apply_patch, project_glob and project_grep whole results only. Cannot undo committed effects or replace final cell output.',
      );
    case 'nativeAgents':
      return facts.nativeAgents
        ? report(
            'supported',
            'NativeAgents and its required Environment were admitted.',
            'Destination native child scope; no model or instruction replacement.',
          )
        : report(
            'unsupported',
            'NativeAgents was not admitted at this opening.',
            'Historical descendants and independent Sessions grant no child authority.',
          );
    case 'remoteSkills':
      return facts.remoteSkills
        ? report(
            'supported',
            'Destination remote discovery roots were selected.',
            'Current Environment roots only; no filesystem authority or proof a skill exists.',
          )
        : report(
            'unsupported',
            'No remote discovery roots are selected.',
            'No host, saved or source-root fallback; metadata grants no discovery or filesystem authority.',
          );
    case 'checklist':
      return facts.checklist
        ? report(
            'supported',
            'Native checklist updates were granted at this opening.',
            'Root and admitted native children have separate readback; ordinary leaf updates retain this fixed grant.',
          )
        : report(
            'unsupported',
            'Checklist updates were not admitted at this opening.',
            'Saved readback and local storage grant no native Checklist updates.',
          );
  }
}

/** @internal Fixed SDK text only. */
export function checkpointStatus(
  status: CheckpointStatus['status'],
  reason?: string,
): CheckpointStatus {
  return Object.freeze({
    status,
    reasons: Object.freeze(reason === undefined ? [] : [reason]),
  });
}
