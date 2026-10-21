// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiagramEditor } from '../src/renderer/components/DiagramEditor';
import { DiagramSchema, type Diagram } from '../src/shared/types';

const fixture = (): Diagram =>
  DiagramSchema.parse({
    id: 'diagram-test',
    title: 'Workflow',
    kind: 'workflow',
    revision: 0,
    nodes: [{ id: 'group-test', type: 'group', position: { x: 0, y: 0 }, data: { label: 'Backend' } }],
    edges: [],
  });

beforeEach(() => {
  // Canvas geometry is covered by Electron tests; jsdom only exercises the real
  // editor's controls and synchronization effects without browser measurements.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('diagram selection across synchronized updates', () => {
  it('keeps the selected node and undo history when a saved echo normalizes JSON keys', () => {
    const onChange = vi.fn();
    const view = render(<DiagramEditor diagram={fixture()} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Node type' }), { target: { value: 'decision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), {
      target: { value: 'Approval needed?' },
    });
    const edited = onChange.mock.lastCall![0] as Diagram;
    const echo: Diagram = {
      edges: edited.edges,
      nodes: edited.nodes.map((node) => ({
        data: node.data,
        position: node.position,
        type: node.type,
        id: node.id,
      })),
      revision: 1,
      kind: edited.kind,
      title: edited.title,
      id: edited.id,
    };
    view.rerender(<DiagramEditor diagram={echo} onChange={onChange} />);
    expect((screen.getByRole('textbox', { name: 'Label' }) as HTMLInputElement).value).toBe(
      'Approval needed?',
    );
    expect((screen.getByRole('button', { name: 'Undo diagram change' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Group' }), {
      target: { value: 'group-test' },
    });
    const grouped = onChange.mock.lastCall![0] as Diagram;
    expect(grouped.revision).toBe(1);
    expect(grouped.nodes.at(-1)).toMatchObject({
      parentId: 'group-test',
      data: { label: 'Approval needed?' },
    });
  });

  it('preserves valid selection on external edits, applies every update, and clears deleted selection', () => {
    const onChange = vi.fn();
    const view = render(<DiagramEditor diagram={fixture()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
    const local = onChange.mock.lastCall![0] as Diagram;
    const external = {
      ...local,
      title: 'Workflow updated by teammate',
      nodes: local.nodes.map((node, index) =>
        index === 1 ? { ...node, data: { ...node.data, label: 'External action' } } : node,
      ),
    };
    view.rerender(<DiagramEditor diagram={external} onChange={onChange} />);
    expect((screen.getByRole('textbox', { name: 'Label' }) as HTMLInputElement).value).toBe(
      'External action',
    );
    expect((screen.getByRole('button', { name: 'Undo diagram change' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    view.rerender(<DiagramEditor diagram={local} onChange={onChange} />);
    expect((screen.getByRole('textbox', { name: 'Label' }) as HTMLInputElement).value).toBe('New action');
    expect(
      view.container.querySelector(`[data-id="${local.nodes[1].id}"] .sde-flow-node-header`)?.textContent,
    ).toBe('New action');
    view.rerender(
      <DiagramEditor diagram={{ ...local, nodes: local.nodes.slice(0, 1) }} onChange={onChange} />,
    );
    expect(screen.queryByRole('textbox', { name: 'Label' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Workflow');
  });
});
