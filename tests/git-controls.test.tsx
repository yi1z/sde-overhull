// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitDialog } from '../src/renderer/components/GitDialog';
import { DesignRevisionSchema, type ProjectView } from '../src/shared/types';

const request = vi.fn();
const fixture = (): ProjectView => ({
  root: '/project',
  manifest: {
    schemaVersion: 1,
    id: 'project-test',
    name: 'Test project',
    createdAt: new Date().toISOString(),
    activeDesignId: 'design-test',
  },
  design: DesignRevisionSchema.parse({ id: 'design-test', roundId: 'round-test', title: 'Test design' }),
  approvals: [],
  runs: [],
  messages: [],
  feedback: [],
  services: [],
  git: {
    head: 'a'.repeat(40),
    branch: 'main',
    ahead: 0,
    behind: 0,
    files: [{ path: 'src/app.ts', index: ' ', worktree: 'M', conflicted: false }],
    conflicts: [],
  },
  readOnly: false,
  warnings: [],
  serviceStatus: [],
});

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal('sde', { request, onEvent: () => () => {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Git error recovery controls', () => {
  it('retains the commit message and selected files when committing fails', async () => {
    const error = new Error('Configure your Git identity before committing.');
    request.mockRejectedValue(error);
    const onError = vi.fn();
    const onRefresh = vi.fn();
    render(<GitDialog project={fixture()} onClose={vi.fn()} onRefresh={onRefresh} onError={onError} />);
    const message = screen.getByRole('textbox', { name: 'Commit message' }) as HTMLInputElement;
    fireEvent.change(message, { target: { value: 'Preserve this carefully written commit message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1 files' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(message.value).toBe('Preserve this carefully written commit message');
    expect((screen.getByRole('checkbox', { name: 'Commit src/app.ts' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Commit 1 files' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('keeps the edited conflict resolution open when metadata validation fails', async () => {
    const project = fixture();
    const file = '.sde/feedback/item.json';
    project.git.files = [{ path: file, index: 'U', worktree: 'U', conflicted: true }];
    project.git.conflicts = [file];
    const error = new Error('Resolved metadata must be valid JSON.');
    request.mockImplementation(async (method: string) => {
      if (method === 'git.conflict')
        return { path: file, base: '{}', ours: '{"title":"Local"}', theirs: '{"title":"Remote"}' };
      if (method === 'git.resolve') throw error;
      throw new Error(`Unexpected request: ${method}`);
    });
    const onError = vi.fn();
    const onRefresh = vi.fn();
    render(<GitDialog project={project} onClose={vi.fn()} onRefresh={onRefresh} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conflicts (1)' }));
    fireEvent.click(screen.getByRole('button', { name: file }));
    const resolution = (await screen.findByRole('textbox', {
      name: 'Resolved content',
    })) as HTMLTextAreaElement;
    fireEvent.change(resolution, { target: { value: '{"title":"Carefully merged but unfinished' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and stage resolution' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(screen.getByRole('textbox', { name: 'Resolved content' })).toBe(resolution);
    expect(resolution.value).toBe('{"title":"Carefully merged but unfinished');
    expect(
      (screen.getByRole('button', { name: 'Validate and stage resolution' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
