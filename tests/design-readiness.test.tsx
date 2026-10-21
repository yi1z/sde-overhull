// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesignWorkspace } from '../src/renderer/components/DesignWorkspace';
import { CheckSchema, DesignRevisionSchema, type VerificationCheck } from '../src/shared/types';

// Keep the real review checklist and approval buttons; these tests never open
// canvas editors, whose browser geometry is covered by the Electron suite.
vi.mock('../src/renderer/components/DiagramEditor', () => ({ DiagramEditor: () => null }));
vi.mock('../src/renderer/components/PrototypeEditor', () => ({ PrototypeEditor: () => null }));

afterEach(cleanup);

const check = (kind: 'test' | 'smoke', required = true, executable = 'node'): VerificationCheck =>
  CheckSchema.parse({ id: kind, title: `${kind} check`, kind, required, command: { executable } });

function renderReview(checks: VerificationCheck[]) {
  const onApprove = vi.fn();
  const draft = DesignRevisionSchema.parse({
    id: 'design-test',
    roundId: 'round-test',
    title: 'Task board',
    requirements: [
      { id: 'requirement', title: 'Create tasks', acceptance: 'New tasks appear on the board.' },
    ],
    tasks: [{ id: 'task', title: 'Build the board', requirementIds: ['requirement'] }],
    checks,
    reviewedDigest: 'reviewed-current-design',
  });
  render(<DesignWorkspace draft={draft} onChange={vi.fn()} onApprove={onApprove} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review design' }));
  return onApprove;
}

describe('design approval check readiness', () => {
  it.each([
    { name: 'only a required test', checks: [check('test')], missing: 'smoke' },
    { name: 'only a required smoke check', checks: [check('smoke')], missing: 'test' },
    { name: 'an optional smoke check', checks: [check('test'), check('smoke', false)], missing: 'smoke' },
    { name: 'an optional test', checks: [check('test', false), check('smoke')], missing: 'test' },
    {
      name: 'a required smoke check without an executable',
      checks: [check('test'), check('smoke', true, '   ')],
      missing: 'smoke',
    },
    {
      name: 'a required test without an executable',
      checks: [check('test', true, '   '), check('smoke')],
      missing: 'test',
    },
  ])('blocks approval with $name and explains the missing check', ({ checks, missing }) => {
    const onApprove = renderReview(checks);
    const checklist = screen.getByText(`Required ${missing} checks have executable commands`);
    expect(checklist.parentElement?.className).toBe('pending');
    for (const button of screen.getAllByRole('button', { name: /Confirm & commit/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('enables approval when both kinds have required executable checks', () => {
    const onApprove = renderReview([check('test'), check('smoke')]);
    for (const kind of ['test', 'smoke']) {
      expect(
        screen.getByText(`Required ${kind} checks have executable commands`).parentElement?.className,
      ).toBe('passed');
    }
    const button = screen.getByRole('button', { name: 'Confirm & commit design' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onApprove).toHaveBeenCalledOnce();
  });
});
