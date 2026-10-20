// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/renderer/App';
import {
  DesignRevisionSchema,
  SettingsSchema,
  type AppEvent,
  type DesignRevision,
  type ProjectView,
} from '../src/shared/types';

// Keep the real application state, event subscription, debounce, and save queue.
// Only the editor surface and desktop IPC transport are substituted.
vi.mock('../src/renderer/components/DesignWorkspace', () => ({
  DesignWorkspace: ({
    draft,
    onChange,
  }: {
    draft: DesignRevision;
    onChange: (draft: DesignRevision) => void;
  }) => (
    <input
      aria-label="Draft title"
      value={draft.title}
      onChange={(event) => onChange({ ...draft, title: event.target.value })}
    />
  ),
}));
vi.mock('../src/renderer/components/ChatPanel', () => ({ ChatPanel: () => null }));

function fixture(title = 'Original', revision = 0): ProjectView {
  return {
    root: '/project',
    manifest: {
      schemaVersion: 1,
      id: 'project-test',
      name: 'Test project',
      createdAt: new Date().toISOString(),
      activeDesignId: 'design-test',
    },
    design: DesignRevisionSchema.parse({ id: 'design-test', roundId: 'round-test', title, revision }),
    approvals: [],
    runs: [],
    messages: [],
    feedback: [],
    services: [],
    git: { head: 'a'.repeat(40), branch: 'main', ahead: 0, behind: 0, files: [], conflicts: [] },
    readOnly: false,
    warnings: [],
    serviceStatus: [],
  };
}

const request = vi.fn();
let emit: (event: AppEvent) => void;
beforeEach(() => {
  request.mockReset();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('sde', {
    request,
    onEvent: (listener: typeof emit) => {
      emit = listener;
      return () => {};
    },
  });
  request.mockImplementation(async (method, input) => {
    if (method === 'settings.get') return SettingsSchema.parse({});
    if (method === 'project.open') return fixture();
    if (method === 'design.save') return fixture(input.design.title, 1);
    throw new Error(`Unexpected IPC ${method}`);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('background refresh ordering', () => {
  it.each(['before', 'during'] as const)(
    'does not replace a saved manual edit with a read started %s the edit',
    async (timing) => {
      let finishRead!: (view: ProjectView) => void;
      const staleRead = new Promise<ProjectView>((resolve) => {
        finishRead = resolve;
      });
      const implementation = request.getMockImplementation()!;
      request.mockImplementation((method, input) =>
        method === 'project.refresh' ? staleRead : implementation(method, input),
      );
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
      const title = await screen.findByRole('textbox', { name: 'Draft title' });
      if (timing === 'before') act(() => emit({ type: 'project-changed' }));
      fireEvent.change(title, { target: { value: 'Newer manual edit' } });
      if (timing === 'during') act(() => emit({ type: 'project-changed' }));
      await waitFor(
        () =>
          expect(request).toHaveBeenCalledWith(
            'design.save',
            expect.objectContaining({ expectedRevision: 0 }),
          ),
        { timeout: 2500 },
      );
      await screen.findByText('Saved locally');
      await act(async () => {
        finishRead(fixture());
        await staleRead;
      });
      expect((title as HTMLInputElement).value).toBe('Newer manual edit');

      // A new, current read still accepts a teammate/agent update.
      request.mockResolvedValueOnce(fixture('Current remote edit', 2));
      act(() => emit({ type: 'project-changed' }));
      await waitFor(() => expect((title as HTMLInputElement).value).toBe('Current remote edit'));
    },
  );

  it('keeps the latest refresh when an older read resolves last', async () => {
    let finishOld!: (view: ProjectView) => void;
    const older = new Promise<ProjectView>((resolve) => {
      finishOld = resolve;
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
    const title = await screen.findByRole('textbox', { name: 'Draft title' });
    request.mockReturnValueOnce(older).mockResolvedValueOnce(fixture('Newest read', 2));
    act(() => {
      emit({ type: 'project-changed' });
      emit({ type: 'project-changed' });
    });
    await waitFor(() => expect((title as HTMLInputElement).value).toBe('Newest read'));
    await act(async () => {
      finishOld(fixture('Older read', 1));
      await older;
    });
    expect((title as HTMLInputElement).value).toBe('Newest read');
  });
});
