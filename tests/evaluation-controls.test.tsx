// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EvaluateWorkspace } from '../src/renderer/components/EvaluateWorkspace';
import { DesignRevisionSchema, RunSchema, type EvaluationItem, type ProjectView } from '../src/shared/types';

afterEach(cleanup);

function setup(overrides: Partial<ProjectView> = {}) {
  const feedback = (id: string): EvaluationItem => ({
    id,
    title: `Feedback ${id}`,
    body: `Observation ${id}`,
    kind: 'idea',
    priority: 'medium',
    status: 'open',
    roundId: 'round-test',
    author: 'Developer',
    createdAt: '2026-10-20T12:00:00.000Z',
    comments: [],
    attachments: [],
  });
  const store = new Map(['A', 'B'].map((id) => [id, feedback(id)]));
  const project: ProjectView = {
    root: '/project',
    manifest: {
      schemaVersion: 1,
      id: 'project-test',
      name: 'Test project',
      createdAt: '2026-10-20T12:00:00.000Z',
      activeDesignId: 'design-test',
    },
    design: DesignRevisionSchema.parse({ id: 'design-test', roundId: 'round-test', title: 'Test design' }),
    approvals: [],
    runs: [],
    messages: [],
    feedback: [...store.values()],
    services: [],
    git: { head: 'a'.repeat(40), branch: 'main', ahead: 0, behind: 0, files: [], conflicts: [] },
    readOnly: false,
    warnings: [],
    serviceStatus: [],
    ...overrides,
  };
  const onSave = vi.fn(async (item: EvaluationItem) => {
    store.set(item.id, structuredClone(item));
  });
  const onAttach = vi.fn(async (id: string) => {
    const item = structuredClone(store.get(id)!);
    item.attachments.push('.sde/attachments/screenshot.png');
    store.set(id, item);
    return item;
  });
  function Harness() {
    const [view, setView] = useState(project);
    const refresh = () => setView((current) => ({ ...current, feedback: [...store.values()] }));
    return (
      <EvaluateWorkspace
        project={view}
        onSave={async (item) => {
          await onSave(item);
          refresh();
        }}
        onAttach={async (id) => {
          const item = await onAttach(id);
          refresh();
          return item;
        }}
        onNewRound={vi.fn(async () => {})}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Feedback A' }));
  return { store, onSave, onAttach };
}

const writeComment = (text: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Add a comment' }), { target: { value: text } });

describe('feedback editing and attachments', () => {
  it('creates feedback for a new design round without linking the prior design run', async () => {
    const { onSave } = setup({
      design: DesignRevisionSchema.parse({ id: 'design-next', roundId: 'round-next', title: 'Next design' }),
      runs: [
        RunSchema.parse({
          id: 'run-previous',
          designId: 'design-test',
          designDigest: 'previous-digest',
          approvalCommit: 'a'.repeat(40),
          baselineCommit: 'b'.repeat(40),
          status: 'complete',
          startedAt: '2026-10-20T12:00:00.000Z',
        }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add feedback' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Feedback on the next design' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Feedback on the next design',
        roundId: 'round-next',
        runId: undefined,
      }),
    );
  });

  it('does not carry a canceled comment from one feedback item into another', async () => {
    const { store } = setup();
    writeComment('This belongs only to A');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Feedback B' }));
    expect((screen.getByRole('textbox', { name: 'Add a comment' }) as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(store.get('A')!.comments).toEqual([]);
    expect(store.get('B')!.comments).toEqual([]);
  });

  it('saves a pending comment once when attaching and retains the attachment on later save', async () => {
    const { store, onSave } = setup();
    writeComment('The screenshot shows the issue');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await screen.findByText('.sde/attachments/screenshot.png');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Add a comment' }) as HTMLTextAreaElement).value).toBe('');
    expect(store.get('A')!.comments).toHaveLength(1);
    const commentId = store.get('A')!.comments[0].id;
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(store.get('A')!.comments.map((comment) => comment.id)).toEqual([commentId]);
    expect(store.get('A')!.attachments).toEqual(['.sde/attachments/screenshot.png']);
    fireEvent.click(screen.getByRole('button', { name: 'Feedback A' }));
    expect(screen.getAllByText('The screenshot shows the issue')).toHaveLength(1);
    expect(screen.getByText('.sde/attachments/screenshot.png')).toBeTruthy();
  });

  it('keeps the feedback open with saved edits when the file picker is canceled', async () => {
    const { store, onAttach } = setup();
    onAttach.mockImplementationOnce(async (id) => structuredClone(store.get(id)!));
    fireEvent.change(screen.getByRole('textbox', { name: 'Observation or suggestion' }), {
      target: { value: 'Keep this detailed observation' },
    });
    writeComment('Keep this comment too');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Attach file' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Observation or suggestion' }) as HTMLTextAreaElement).value,
    ).toBe('Keep this detailed observation');
    expect(screen.getByText('Keep this comment too')).toBeTruthy();
    expect(store.get('A')!.attachments).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an attachment error and retries without duplicating a saved comment', async () => {
    const { store, onAttach } = setup();
    onAttach.mockRejectedValueOnce(new Error('Attachments must be smaller than 10 MB.'));
    writeComment('Retry this attachment');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('smaller than 10 MB');
    expect(alert.textContent).toContain('Your feedback is saved');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(store.get('A')!.comments).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await screen.findByText('.sde/attachments/screenshot.png');
    expect(store.get('A')!.comments).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves unsaved text and skips the picker if saving feedback fails', async () => {
    const { store, onSave, onAttach } = setup();
    onSave.mockRejectedValueOnce(new Error('The project is read-only.'));
    writeComment('Preserve this unsaved comment');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Your edits are still here');
    expect((screen.getByRole('textbox', { name: 'Add a comment' }) as HTMLTextAreaElement).value).toBe(
      'Preserve this unsaved comment',
    );
    expect(onAttach).not.toHaveBeenCalled();
    expect(store.get('A')!.comments).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(store.get('A')!.comments).toHaveLength(1);
  });

  it('prevents duplicate actions or closing the draft while an attachment is pending', async () => {
    const { store, onSave, onAttach } = setup();
    let finish!: (item: EvaluationItem) => void;
    onAttach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    writeComment('One operation at a time');
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: 'Save feedback' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => finish(structuredClone(store.get('A')!)));
    expect((screen.getByRole('button', { name: 'Save feedback' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
