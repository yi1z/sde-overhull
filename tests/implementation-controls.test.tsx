// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImplementWorkspace } from '../src/renderer/components/ImplementWorkspace';
import { DesignRevisionSchema, RunSchema, type ProjectView } from '../src/shared/types';

afterEach(cleanup);

function fixture(): ProjectView {
  const design = DesignRevisionSchema.parse({
    id: 'design-current',
    roundId: 'round-current',
    title: 'Task board',
    tasks: [{ id: 'task-board', title: 'Build the task board' }],
    checks: [{ id: 'test-board', title: 'Task board tests', kind: 'test', command: { executable: 'node' } }],
  });
  return {
    root: '/project',
    manifest: {
      schemaVersion: 1,
      id: 'project',
      name: 'Task board',
      createdAt: '2026-10-20T00:00:00Z',
      activeDesignId: design.id,
    },
    design,
    approvals: [
      {
        id: 'approval',
        designId: design.id,
        designDigest: 'design-digest',
        baselineCommit: 'a'.repeat(40),
        author: 'Developer',
        createdAt: '2026-10-20T00:00:00Z',
      },
    ],
    runs: [
      RunSchema.parse({
        id: 'run-current',
        designId: design.id,
        designDigest: 'design-digest',
        approvalCommit: 'b'.repeat(40),
        baselineCommit: 'a'.repeat(40),
        status: 'blocked',
        startedAt: '2026-10-20T00:01:00Z',
        summary: 'Agent authentication expired',
      }),
    ],
    messages: [],
    feedback: [],
    services: [],
    git: { head: 'b'.repeat(40), branch: 'main', ahead: 0, behind: 0, files: [], conflicts: [] },
    readOnly: false,
    warnings: [],
  };
}

const callbacks = () => ({
  logs: [],
  onStart: vi.fn(async () => {}),
  onCancel: vi.fn(async () => {}),
  onVerify: vi.fn(async () => {}),
  onServices: vi.fn(async () => {}),
  onOpen: vi.fn(),
  onSaveServices: vi.fn(async () => {}),
  onEnv: vi.fn(async () => {}),
});

describe('implementation ownership and round controls', () => {
  it('restores the retry action after startup fails and retains its error summary', () => {
    const project = fixture();
    const handlers = callbacks();
    const { rerender } = render(
      <ImplementWorkspace {...handlers} project={{ ...project, activeRunId: 'run-current' }} />,
    );
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeTruthy();

    rerender(<ImplementWorkspace {...handlers} project={project} />);
    expect(screen.getByText('Agent authentication expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run checks' })).toBeNull();
    const start = screen.getByRole('button', { name: 'Implement design' }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(handlers.onStart).toHaveBeenCalledOnce();
  });

  it('does not infer an active run from reopened blocked history', () => {
    const handlers = callbacks();
    render(<ImplementWorkspace {...handlers} project={fixture()} />);
    expect(screen.getByText('Agent authentication expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Implement design' }));
    expect(handlers.onStart).toHaveBeenCalledOnce();
  });

  it('keeps stop and verification controls for a blocked run the host still owns', () => {
    const handlers = callbacks();
    render(<ImplementWorkspace {...handlers} project={{ ...fixture(), activeRunId: 'run-current' }} />);
    expect(screen.queryByRole('button', { name: 'Implement design' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run checks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(handlers.onVerify).toHaveBeenCalledOnce();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
  });

  it('shows pending evidence for a new round even when it reuses earlier task and check IDs', () => {
    const project = fixture();
    project.runs[0] = {
      ...project.runs[0],
      status: 'complete',
      summary: 'Earlier round completed',
      taskEvidence: { 'task-board': 'Earlier round implementation evidence' },
      checks: [
        {
          checkId: 'test-board',
          title: 'Task board tests',
          status: 'passed',
          exitCode: 0,
          startedAt: '2026-10-20T00:02:00Z',
          finishedAt: '2026-10-20T00:03:00Z',
          output: 'Earlier round test output',
        },
      ],
    };
    project.design = { ...project.design, id: 'design-next', roundId: 'round-next' };
    project.manifest.activeDesignId = project.design.id;
    render(<ImplementWorkspace {...callbacks()} project={project} />);
    expect(screen.getByText('Not started')).toBeTruthy();
    expect(screen.getByText('0 checks passed')).toBeTruthy();
    expect(screen.queryByText('Earlier round implementation evidence')).toBeNull();
    expect(screen.queryByText('Earlier round completed')).toBeNull();
    expect(screen.queryByText('Changed since verification')).toBeNull();
    expect((screen.getByRole('button', { name: 'Implement design' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Verification' }));
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getByText('This check has not run yet.')).toBeTruthy();
    expect(screen.queryByText('Earlier round test output')).toBeNull();
  });
});
