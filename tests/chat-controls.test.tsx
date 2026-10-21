// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from '../src/renderer/components/ChatPanel';
import type { AgentEvent } from '../src/shared/types';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
const props = () => ({
  messages: [],
  phase: 'design' as const,
  busy: true,
  onSend: vi.fn(async () => {}),
  onCancel: vi.fn(),
  onRespond: vi.fn(async (_id: string | number, _response: unknown) => {}),
});

describe('agent request controls', () => {
  it('shows the requested permission scope and sends only a one-turn grant', async () => {
    const callbacks = props();
    const permissions = { network: { enabled: true }, fileSystem: { read: ['/project/docs'] } };
    render(
      <ChatPanel
        {...callbacks}
        events={[
          { type: 'approval', id: 1, method: 'item/permissions/requestApproval', data: { permissions } },
        ]}
      />,
    );
    expect(screen.getByText(/project\/docs/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this turn' }));
    await waitFor(() => expect(callbacks.onRespond).toHaveBeenCalledWith(1, { permissions, scope: 'turn' }));
    await waitFor(() => expect(screen.queryByText('Approval needed')).toBeNull());
  });

  it('retains a failed request and allows retry instead of silently dismissing it', async () => {
    const callbacks = props();
    callbacks.onRespond.mockRejectedValueOnce(new Error('Agent connection lost'));
    render(
      <ChatPanel
        {...callbacks}
        events={[
          {
            type: 'approval',
            id: 'command',
            method: 'item/commandExecution/requestApproval',
            data: { command: 'pnpm test' },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Agent connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(callbacks.onRespond).toHaveBeenLastCalledWith('command', { decision: 'decline' }),
    );
  });

  it('requires question answers and masks secret input', async () => {
    const callbacks = props();
    const event: AgentEvent = {
      type: 'question',
      id: 2,
      method: 'item/tool/requestUserInput',
      data: {
        questions: [
          { id: 'name', question: 'Project name?' },
          { id: 'token', question: 'Local token?', isSecret: true },
        ],
      },
    };
    render(<ChatPanel {...callbacks} events={[event]} />);
    expect((screen.getByLabelText('Local token?') as HTMLInputElement).type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(callbacks.onRespond).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Project name?'), { target: { value: 'Atlas' } });
    fireEvent.change(screen.getByLabelText('Local token?'), { target: { value: 'private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() =>
      expect(callbacks.onRespond).toHaveBeenCalledWith(2, {
        answers: { name: { answers: ['Atlas'] }, token: { answers: ['private'] } },
      }),
    );
  });

  it('validates an elicitation form before sending protocol content', async () => {
    const callbacks = props();
    render(
      <ChatPanel
        {...callbacks}
        events={[
          {
            type: 'question',
            id: 3,
            method: 'mcpServer/elicitation/request',
            data: {
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: { count: { type: 'integer', minimum: 1 } },
                required: ['count'],
              },
            },
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Agent form response'), { target: { value: '{"count":0}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(callbacks.onRespond).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Agent form response'), { target: { value: '{"count":2}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() =>
      expect(callbacks.onRespond).toHaveBeenCalledWith(3, { action: 'accept', content: { count: 2 } }),
    );
  });
});
