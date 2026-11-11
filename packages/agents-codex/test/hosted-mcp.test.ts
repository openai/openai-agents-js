import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { hostedMcp } from '../src/runtime/hosted-mcp';
import {
  assertHostedMcpConfigurations,
  hostedMcpConfigurations,
  hostedMcpBinding,
} from '../src/runtime/hosted-mcp-binding';
import { prepareManualResult } from '../src/runtime/manual';
import {
  projectHostedToolItem,
  repairItemFromWire,
} from '../src/runtime/history';
import type { JsonObject } from '../src/runtime/binding';
import {
  captureTools,
  isDirectFunctionTool,
  toolNamespace,
} from '../src/runtime/tools';

describe('native hosted MCP declarations', () => {
  it('retains live configuration and emits only qualified server identity', () => {
    const headers = { 'x-fixture-auth': 'private-fixture-value' };
    const server = hostedMcp({
      serverLabel: 'docs',
      serverUrl: 'https://example.invalid/mcp',
      headers,
      allowedTools: ['lookup'],
      allowedCallers: ['direct'],
    });
    headers['x-fixture-auth'] = 'changed-after-capture';

    expect(JSON.parse(captureTools([server]).specsJson)).toEqual([
      { type: 'hostedMcp', serverLabel: 'docs' },
    ]);
    expect(server.ref).toEqual({
      kind: 'tool_ref',
      name: 'docs',
      namespace: 'hosted_mcp',
    });
    expect(toolNamespace(server)).toBe('hosted_mcp');
    expect(isDirectFunctionTool(server)).toBe(false);
    expect(server).not.toHaveProperty('match');
    expect(hostedMcpConfigurations([server])).toEqual([
      {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://example.invalid/mcp',
        require_approval: 'never',
        allowed_tools: { tool_names: ['lookup'] },
        allowed_callers: ['direct'],
        headers: { 'x-fixture-auth': 'private-fixture-value' },
      },
    ]);
    expect(JSON.stringify(server)).not.toContain('private-fixture-value');
    expect(inspect(server)).not.toContain('private-fixture-value');
  });

  it('captures each server once and rejects conflicting profile authority', () => {
    const options = {
      serverLabel: 'docs',
      serverUrl: 'https://example.invalid/mcp',
    };
    const first = hostedMcp(options);
    expect(hostedMcpConfigurations([first, hostedMcp(options)])).toHaveLength(
      1,
    );
    expect(() =>
      hostedMcpConfigurations([
        first,
        hostedMcp({ ...options, authorization: 'different-fixture-authority' }),
      ]),
    ).toThrow('Conflicting');
  });

  it('admits only configured caller kinds before application approval', () => {
    const binding = hostedMcpBinding(
      hostedMcp({
        serverLabel: 'docs',
        allowedCallers: ['direct'],
      }),
    )!;
    expect(binding.admitsCaller(undefined)).toBe(true);
    expect(binding.admitsCaller(null)).toBe(true);
    expect(binding.admitsCaller({ type: 'direct' })).toBe(true);
    expect(
      binding.admitsCaller({ type: 'code_interpreter', tool_id: 'ci_fixture' }),
    ).toBe(false);
    expect(binding.admitsCaller({ type: 'unknown' })).toBe(false);
  });

  it('retains MCP list and call provider items in public history', () => {
    const items: JsonObject[] = [
      {
        type: 'mcp_list_tools',
        id: 'list_fixture',
        server_label: 'docs',
        tools: [{ name: 'lookup' }],
      },
      {
        type: 'mcp_call',
        id: 'call_fixture',
        status: 'completed',
        server_label: 'docs',
        name: 'lookup',
        arguments: '{"key":"A"}',
        output: 'found',
        caller: { type: 'direct' },
      },
    ];
    for (const item of items) {
      const projected = projectHostedToolItem(item, 'turn_fixture');
      expect(projected?.type).toBe(item.type);
      expect(projected?.provider_data).toEqual(item);
      if (projected)
        expect(repairItemFromWire(projected)).toMatchObject({
          type: item.type,
          provider_data: item,
        });
    }
  });

  it('allows callback replacement only with the captured provider configuration', () => {
    const options = {
      serverLabel: 'docs',
      serverUrl: 'https://example.invalid/mcp',
      requireApproval: 'always' as const,
    };
    const original = hostedMcp(options);
    const opening = hostedMcpConfigurations([original]);
    const replacement = hostedMcp({
      ...options,
      onApprovalRequest: () => ({ approve: true }),
    });
    expect(() =>
      assertHostedMcpConfigurations([replacement], opening),
    ).not.toThrow();
    expect(() => assertHostedMcpConfigurations([], opening)).not.toThrow();
    for (const changed of [
      { ...options, serverUrl: 'https://other.invalid/mcp' },
      { ...options, authorization: 'new-fixture-authority' },
      { ...options, serverLabel: 'other' },
    ])
      expect(() =>
        assertHostedMcpConfigurations([hostedMcp(changed)], opening),
      ).toThrow('fixed for this Session');
  });

  it('restricts manual replies to a decision without caller or receipt substitution', () => {
    const server = hostedMcp({
      serverLabel: 'docs',
      requireApproval: 'always',
    });
    expect(() => prepareManualResult(server, { approve: true })).not.toThrow();
    for (const reply of [
      { approve: 'yes' },
      { approve: true, requestId: 'foreign' },
      { approve: true, caller: { type: 'foreign' } },
    ])
      expect(() => prepareManualResult(server, reply)).toThrow();
  });
});
