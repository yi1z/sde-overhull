import { describe, expect, it } from 'vitest';
import { buildAgentResponse, validateAgentResponse } from '../src/shared/agent-responses';

describe('Codex request responses', () => {
  it('uses the specific command/file protocol and never persistent approval', () => {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      expect(buildAgentResponse({ method }, 'accept')).toEqual({ decision: 'accept' });
      expect(buildAgentResponse({ method }, 'decline')).toEqual({ decision: 'decline' });
      expect(() => validateAgentResponse({ method }, { decision: 'acceptForSession' })).toThrow();
    }
  });

  it('grants only requested permissions for one turn and preserves explicit restrictions', () => {
    const deny = { access: 'deny', path: { type: 'path', path: '/project/.git' } };
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ['/docs'], write: ['/project'], entries: [deny] },
    };
    const request = { method: 'item/permissions/requestApproval', data: { permissions } };
    expect(buildAgentResponse(request, 'accept')).toEqual({ permissions, scope: 'turn' });
    expect(buildAgentResponse(request, 'decline')).toEqual({ permissions: {}, scope: 'turn' });
    expect(buildAgentResponse(request, 'accept', { network: { enabled: true } })).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    expect(() => buildAgentResponse(request, 'accept', { fileSystem: { write: ['/'] } })).toThrow('subset');
    expect(() => buildAgentResponse(request, 'accept', { fileSystem: { write: ['/project'] } })).toThrow(
      'restrictions',
    );
    expect(() => validateAgentResponse(request, { permissions, scope: 'session' })).toThrow();
    expect(() =>
      buildAgentResponse({ ...request, data: { permissions: {} } }, 'accept', { network: { enabled: true } }),
    ).toThrow('not requested');
    expect(() => buildAgentResponse(request, 'accept', { futureUnsafePermission: true })).toThrow();
    expect(
      validateAgentResponse(
        { ...request, data: { permissions: { unknownFuturePermission: true } } },
        { permissions: {}, scope: 'turn' },
      ),
    ).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('requires an actual answer per requested question and uses keyed arrays', () => {
    const request = {
      method: 'item/tool/requestUserInput',
      data: { questions: [{ id: 'stack' }, { id: 'name' }] },
    };
    expect(buildAgentResponse(request, 'accept', { stack: ' Node ', name: ['Sample'] })).toEqual({
      answers: { stack: { answers: ['Node'] }, name: { answers: ['Sample'] } },
    });
    expect(() => buildAgentResponse(request, 'accept', { stack: '' })).toThrow();
    expect(() => validateAgentResponse(request, { answers: {} })).toThrow();
  });

  it('uses MCP elicitation action/content and validates form data', () => {
    const request = {
      method: 'mcpServer/elicitation/request',
      data: {
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2 },
            count: { type: 'integer', minimum: 1, maximum: 4 },
            enabled: { type: 'boolean' },
            region: { type: 'string', enum: ['ca', 'us'] },
            tags: { type: 'array', items: { enum: ['one', 'two'] } },
          },
          required: ['name', 'count'],
        },
      },
    };
    const content = { name: 'App', count: 2, enabled: true, region: 'ca', tags: ['one'] };
    expect(buildAgentResponse(request, 'accept', content)).toEqual({ action: 'accept', content });
    expect(buildAgentResponse(request, 'decline')).toEqual({ action: 'decline', content: null });
    expect(() => buildAgentResponse(request, 'accept', {})).toThrow('required');
    expect(() => buildAgentResponse(request, 'accept', { ...content, count: 5 })).toThrow();
    expect(() => buildAgentResponse(request, 'accept', { ...content, region: 'invalid' })).toThrow('listed');
    expect(() => buildAgentResponse(request, 'accept', { ...content, unknown: true })).toThrow('Unexpected');
    expect(validateAgentResponse(request, { action: 'accept', content })).toEqual({
      action: 'accept',
      content,
    });
  });

  it('allows URL acknowledgements and declines unsupported forms without inventing content', () => {
    expect(
      buildAgentResponse({ method: 'mcpServer/elicitation/request', data: { mode: 'url' } }, 'accept'),
    ).toEqual({ action: 'accept', content: null });
    expect(
      buildAgentResponse(
        { method: 'mcpServer/elicitation/request', data: { mode: 'openai/form' } },
        'cancel',
      ),
    ).toEqual({ action: 'cancel', content: null });
    expect(() => buildAgentResponse({ method: 'unknown/requestApproval' }, 'accept')).toThrow('Unsupported');
  });
});
