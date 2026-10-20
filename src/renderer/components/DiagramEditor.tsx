import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  NodeResizer,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import {
  UserRound,
  Monitor,
  Zap,
  GitBranch,
  Globe,
  Server,
  Database,
  Group,
  Plus,
  Undo2,
  Redo2,
  WandSparkles,
  Braces,
  Trash2,
  X,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { DiagramSchema, type Diagram } from '../../shared/types';
import '@xyflow/react/dist/style.css';

type NodeKind = Diagram['nodes'][number]['type'];
type NodeData = Diagram['nodes'][number]['data'] & { kind: NodeKind; editable: boolean };
type FlowNode = Node<NodeData>;
type Props = {
  diagram: Diagram;
  onChange: (diagram: Diagram) => void;
  onSelection?: (selection: { artifactId?: string; nodeId?: string }) => void;
  readOnly?: boolean;
};

const kinds: NodeKind[] = ['actor', 'screen', 'action', 'decision', 'api', 'service', 'entity', 'group'];
const nodeIcons = {
  actor: UserRound,
  screen: Monitor,
  action: Zap,
  decision: GitBranch,
  api: Globe,
  service: Server,
  entity: Database,
  group: Group,
};
const colors: Record<NodeKind, string> = {
  actor: '#a78bfa',
  screen: '#58a6ff',
  action: '#53b9a6',
  decision: '#d29922',
  api: '#79c0ff',
  service: '#8b949e',
  entity: '#f0883e',
  group: '#748396',
};
const edgeColors = {
  navigation: '#58a6ff',
  control: '#748396',
  data: '#f0883e',
  dependency: '#a78bfa',
  relationship: '#53b9a6',
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const makeId = () => crypto.randomUUID();

function DesignNode({ data, selected }: NodeProps<FlowNode>) {
  const Icon = nodeIcons[data.kind] ?? Zap;
  return (
    <div
      className={`sde-flow-node node-${data.kind}${selected ? ' selected' : ''}`}
      style={{ '--node-color': data.color || colors[data.kind] } as CSSProperties}
    >
      {data.kind === 'group' && (
        <NodeResizer minWidth={260} minHeight={180} isVisible={selected && data.editable} />
      )}
      <Handle type="target" position={Position.Left} id="in" />
      <div className="sde-flow-node-header">
        <Icon size={15} />
        <span>{data.label || 'Untitled'}</span>
      </div>
      {data.kind !== 'group' && <div className="sde-flow-node-kind">{data.kind}</div>}
      {data.description && data.kind !== 'group' && (
        <div className="sde-flow-node-description">{data.description}</div>
      )}
      {data.kind === 'entity' && data.fields.length > 0 && (
        <div className="sde-entity-fields">
          {data.fields.map((field, index) => (
            <div className="sde-entity-field" key={`${index}-${field.name}`}>
              <span>{field.name}</span>
              <small>
                {field.primary ? 'PK ' : ''}
                {field.foreign ? 'FK ' : ''}
                {field.type}
                {field.nullable ? '?' : ''}
              </small>
            </div>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
const nodeTypes = Object.fromEntries(kinds.map((kind) => [kind, DesignNode]));

function depth(node: Diagram['nodes'][number], nodes: Diagram['nodes'], seen = new Set<string>()): number {
  if (!node.parentId || seen.has(node.id)) return 0;
  seen.add(node.id);
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  return parent ? 1 + depth(parent, nodes, seen) : 0;
}
function flowNodes(diagram: Diagram, readOnly = false): FlowNode[] {
  return [...diagram.nodes]
    .sort((a, b) => depth(a, diagram.nodes) - depth(b, diagram.nodes))
    .map((node) => ({
      ...node,
      data: { ...node.data, kind: node.type, editable: !readOnly },
      ...(node.parentId ? { extent: 'parent' as const, expandParent: true } : {}),
      ...(node.type === 'group'
        ? { style: { width: node.width ?? 360, height: node.height ?? 240 }, zIndex: -1 }
        : {}),
    }));
}
function flowEdges(diagram: Diagram): Edge[] {
  return diagram.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    label: [edge.label, edge.cardinality].filter(Boolean).join(' · '),
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColors[edge.kind] },
    style: {
      stroke: edgeColors[edge.kind],
      strokeWidth: 1.5,
      ...(edge.kind === 'dependency' ? { strokeDasharray: '5 4' } : {}),
    },
    data: { kind: edge.kind },
  }));
}

/** Additional referential checks complement the shared JSON shape schema. */
export function validateDiagram(input: unknown): Diagram {
  const diagram = DiagramSchema.parse(input);
  const ids = new Set(diagram.nodes.map((node) => node.id));
  if (ids.size !== diagram.nodes.length) throw new Error('Each node must have a unique ID.');
  if (new Set(diagram.edges.map((edge) => edge.id)).size !== diagram.edges.length)
    throw new Error('Each connection must have a unique ID.');
  for (const node of diagram.nodes) {
    if (
      node.parentId &&
      !diagram.nodes.some((parent) => parent.id === node.parentId && parent.type === 'group')
    )
      throw new Error(`Node ${node.data.label} refers to a missing group.`);
    const visited = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      if (visited.has(parentId)) throw new Error('Groups cannot contain themselves or form a cycle.');
      visited.add(parentId);
      parentId = diagram.nodes.find((parent) => parent.id === parentId)?.parentId;
    }
  }
  for (const edge of diagram.edges)
    if (!ids.has(edge.source) || !ids.has(edge.target))
      throw new Error('Every connection must have an existing source and target.');
  return diagram;
}

function DiagramCanvas({ diagram, onChange, onSelection, readOnly = false }: Props) {
  const [nodes, setNodes] = useState<FlowNode[]>(() => flowNodes(diagram, readOnly));
  const [edges, setEdges] = useState<Edge[]>(() => flowEdges(diagram));
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string }>();
  const [newKind, setNewKind] = useState<NodeKind>('action');
  const [sourceMode, setSourceMode] = useState(false);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [arranging, setArranging] = useState(false);
  const [inspector, setInspector] = useState(true);
  const [history, setHistory] = useState<Diagram[]>([]);
  const [future, setFuture] = useState<Diagram[]>([]);
  const current = useRef(diagram);
  const lastEmitted = useRef('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const { fitView, screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    setNodes((previous) =>
      previous.map((node) => ({ ...node, data: { ...node.data, editable: !readOnly } })),
    );
  }, [readOnly]);

  useEffect(() => {
    const serialized = JSON.stringify(diagram);
    // A saved echo should update the revision, without throwing away transient selection.
    const content = (d: Diagram) => JSON.stringify({ ...d, revision: 0 });
    const isEcho = content(diagram) === content(current.current);
    current.current = diagram;
    if (!isEcho && serialized !== lastEmitted.current) {
      setNodes(flowNodes(diagram, readOnly));
      setEdges(flowEdges(diagram));
      setHistory([]);
      setFuture([]);
      setSelected(undefined);
    }
  }, [diagram]);

  const commit = useCallback(
    (next: Diagram, record = true) => {
      if (readOnly) return;
      try {
        const validated = validateDiagram(next);
        if (JSON.stringify(validated) === JSON.stringify(current.current)) return;
        if (record) {
          setHistory((previous) => [...previous.slice(-49), clone(current.current)]);
          setFuture([]);
        }
        current.current = validated;
        lastEmitted.current = JSON.stringify(validated);
        setNodes((previous) =>
          flowNodes(validated, readOnly).map((node) => ({
            ...node,
            selected: previous.find((old) => old.id === node.id)?.selected,
          })),
        );
        setEdges((previous) =>
          flowEdges(validated).map((edge) => ({
            ...edge,
            selected: previous.find((old) => old.id === edge.id)?.selected,
          })),
        );
        setError('');
        onChangeRef.current(validated);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [readOnly],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((previous) => applyNodeChanges(changes, previous));
      const removed = new Set(
        changes.filter((change) => change.type === 'remove').map((change) => change.id),
      );
      if (removed.size) {
        // Removing a group removes its descendants as one undoable operation.
        let added = true;
        while (added) {
          added = false;
          for (const node of current.current.nodes)
            if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
              removed.add(node.id);
              added = true;
            }
        }
        commit({
          ...current.current,
          nodes: current.current.nodes.filter((node) => !removed.has(node.id)),
          edges: current.current.edges.filter(
            (edge) => !removed.has(edge.source) && !removed.has(edge.target),
          ),
        });
        setSelected(undefined);
      }
      const resized = changes.filter(
        (change): change is Extract<NodeChange<FlowNode>, { type: 'dimensions' }> =>
          change.type === 'dimensions' && change.resizing === false,
      );
      if (resized.length) {
        commit({
          ...current.current,
          nodes: current.current.nodes.map((node) => {
            const change = resized.find((item) => item.id === node.id);
            return change?.type === 'dimensions' && change.dimensions && node.type === 'group'
              ? { ...node, width: change.dimensions.width, height: change.dimensions.height }
              : node;
          }),
        });
      }
    },
    [commit],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((previous) => applyEdgeChanges(changes, previous));
      const removed = new Set(
        changes.filter((change) => change.type === 'remove').map((change) => change.id),
      );
      if (removed.size)
        commit({ ...current.current, edges: current.current.edges.filter((edge) => !removed.has(edge.id)) });
    },
    [commit],
  );

  const connect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const kind =
        current.current.kind === 'database'
          ? 'relationship'
          : current.current.kind === 'ui'
            ? 'navigation'
            : 'control';
      commit({
        ...current.current,
        edges: [
          ...current.current.edges,
          {
            id: makeId(),
            source: connection.source,
            target: connection.target,
            sourceHandle: connection.sourceHandle ?? undefined,
            targetHandle: connection.targetHandle ?? undefined,
            label: '',
            kind,
          },
        ],
      });
    },
    [commit],
  );

  const selectedNode = current.current.nodes.find(
    (node) => selected?.kind === 'node' && node.id === selected.id,
  );
  const selectedEdge = current.current.edges.find(
    (edge) => selected?.kind === 'edge' && edge.id === selected.id,
  );
  const updateNode = (changes: Partial<Diagram['nodes'][number]>) => {
    if (!selectedNode) return;
    commit({
      ...current.current,
      nodes: current.current.nodes.map((node) =>
        node.id === selectedNode.id ? { ...node, ...changes } : node,
      ),
    });
  };
  const updateNodeData = (changes: Partial<Diagram['nodes'][number]['data']>) =>
    selectedNode && updateNode({ data: { ...selectedNode.data, ...changes } });
  const updateEdge = (changes: Partial<Diagram['edges'][number]>) =>
    selectedEdge &&
    commit({
      ...current.current,
      edges: current.current.edges.map((edge) =>
        edge.id === selectedEdge.id ? { ...edge, ...changes } : edge,
      ),
    });

  const addNode = () => {
    const canvas = document.querySelector('.diagram-canvas')?.getBoundingClientRect();
    const position = canvas
      ? screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 })
      : { x: 80, y: 80 };
    const node: Diagram['nodes'][number] = {
      id: makeId(),
      type: newKind,
      position,
      ...(newKind === 'group' ? { width: 360, height: 240 } : {}),
      data: {
        label: newKind === 'entity' ? 'New table' : `New ${newKind}`,
        description: '',
        fields: newKind === 'entity' ? [{ name: 'id', type: 'uuid', primary: true }] : [],
        requirementIds: [],
      },
    };
    commit({ ...current.current, nodes: [...current.current.nodes, node] });
    setSelected({ kind: 'node', id: node.id });
    onSelection?.({ artifactId: diagram.id, nodeId: node.id });
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((items) => [...items, clone(current.current)]);
    setHistory((items) => items.slice(0, -1));
    commit({ ...previous, revision: current.current.revision }, false);
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setHistory((items) => [...items, clone(current.current)]);
    setFuture((items) => items.slice(0, -1));
    commit({ ...next, revision: current.current.revision }, false);
  };

  const arrange = async () => {
    const original = clone(current.current);
    const originalFingerprint = JSON.stringify(original);
    setArranging(true);
    setError('');
    try {
      const elk = new ELK();
      const toElk = (parentId?: string): ElkNode[] =>
        original.nodes
          .filter((node) => node.parentId === parentId)
          .map((node) => ({
            id: node.id,
            width: node.width ?? (node.type === 'entity' ? 230 : 180),
            height: node.height ?? (node.type === 'entity' ? 80 + node.data.fields.length * 26 : 90),
            ...(node.type === 'group'
              ? {
                  children: toElk(node.id),
                  layoutOptions: { 'elk.padding': '[top=55,left=24,bottom=24,right=24]' },
                }
              : {}),
          }));
      const result = await elk.layout({
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
          'elk.spacing.nodeNode': '40',
          'elk.layered.spacing.nodeNodeBetweenLayers': '70',
        },
        children: toElk(),
        edges: original.edges.map((edge) => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target],
        })),
      });
      if (JSON.stringify(current.current) !== originalFingerprint)
        throw new Error('The diagram changed while arranging. Try Arrange again.');
      const positions = new Map<string, ElkNode>();
      const collect = (children: ElkNode[] = []) =>
        children.forEach((node) => {
          positions.set(node.id, node);
          collect(node.children);
        });
      collect(result.children);
      commit({
        ...original,
        nodes: original.nodes.map((node) => {
          const positioned = positions.get(node.id);
          return positioned
            ? {
                ...node,
                position: { x: positioned.x ?? node.position.x, y: positioned.y ?? node.position.y },
                ...(node.type === 'group' ? { width: positioned.width, height: positioned.height } : {}),
              }
            : node;
        }),
      });
      // React Flow measures newly arranged groups after React commits their styles.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          void fitView({ padding: 0.2, duration: 250 });
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArranging(false);
    }
  };

  const removeSelection = () => {
    if (selectedNode) handleNodesChange([{ type: 'remove', id: selectedNode.id }]);
    else if (selectedEdge) handleEdgesChange([{ type: 'remove', id: selectedEdge.id }]);
    setSelected(undefined);
  };

  return (
    <div className="diagram-editor">
      <div className="editor-toolbar">
        <select
          aria-label="Node type"
          className="editor-select"
          value={newKind}
          onChange={(event) => setNewKind(event.target.value as NodeKind)}
          disabled={readOnly}
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind[0].toUpperCase() + kind.slice(1)}
            </option>
          ))}
        </select>
        <button className="editor-button" onClick={addNode} disabled={readOnly || sourceMode}>
          <Plus size={14} /> Add node
        </button>
        <button
          className="editor-button editor-icon-button"
          title="Undo"
          aria-label="Undo diagram change"
          onClick={undo}
          disabled={readOnly || !history.length}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="editor-button editor-icon-button"
          title="Redo"
          aria-label="Redo diagram change"
          onClick={redo}
          disabled={readOnly || !future.length}
        >
          <Redo2 size={15} />
        </button>
        <button
          className="editor-button"
          onClick={() => void arrange()}
          disabled={readOnly || arranging || !nodes.length || sourceMode}
        >
          <WandSparkles size={14} /> {arranging ? 'Arranging…' : 'Arrange'}
        </button>
        <span className="editor-spacer" />
        <span className="editor-help">
          {nodes.length} nodes · {edges.length} connections
        </span>
        <button
          className={`editor-button ${sourceMode ? 'active' : ''}`}
          onClick={() => {
            setSourceMode((value) => !value);
            setSource(JSON.stringify(current.current, null, 2));
            setError('');
          }}
        >
          <Braces size={14} /> JSON
        </button>
        <button
          className="editor-button editor-icon-button"
          aria-label={inspector ? 'Hide properties' : 'Show properties'}
          onClick={() => setInspector((value) => !value)}
        >
          {inspector ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
      {error && (
        <div role="alert" className="editor-error">
          {error}
        </div>
      )}
      {sourceMode ? (
        <div className="editor-source-panel">
          <p className="editor-help">
            Edit the structured diagram. Existing IDs keep references stable. Invalid source will not replace
            the last valid diagram.
          </p>
          <textarea
            aria-label="Diagram JSON source"
            className="editor-textarea editor-code"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            readOnly={readOnly}
            spellCheck={false}
          />
          <div>
            <button
              className="editor-button primary"
              disabled={readOnly}
              onClick={() => {
                try {
                  const next = validateDiagram(JSON.parse(source));
                  if (next.id !== diagram.id) throw new Error('The artifact ID cannot be changed.');
                  commit({ ...next, revision: current.current.revision });
                  setSourceMode(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Apply valid JSON
            </button>
          </div>
        </div>
      ) : (
        <div className="diagram-surface">
          <div className="diagram-canvas">
            <ReactFlow<FlowNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={connect}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              edgesReconnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
              onReconnect={(old, connection) =>
                commit({
                  ...current.current,
                  edges: current.current.edges.map((edge) =>
                    edge.id === old.id
                      ? {
                          ...edge,
                          source: connection.source,
                          target: connection.target,
                          sourceHandle: connection.sourceHandle ?? undefined,
                          targetHandle: connection.targetHandle ?? undefined,
                        }
                      : edge,
                  ),
                })
              }
              onNodeClick={(_, node) => {
                setSelected({ kind: 'node', id: node.id });
                onSelection?.({ artifactId: diagram.id, nodeId: node.id });
              }}
              onEdgeClick={(_, edge) => {
                setSelected({ kind: 'edge', id: edge.id });
                onSelection?.({ artifactId: diagram.id });
              }}
              onPaneClick={() => {
                setSelected(undefined);
                onSelection?.({ artifactId: diagram.id });
              }}
              onNodeDragStop={(_, node, draggedNodes) => {
                const moved = new Map(
                  (draggedNodes.length ? draggedNodes : [node]).map((item) => [item.id, item.position]),
                );
                commit({
                  ...current.current,
                  nodes: current.current.nodes.map((item) =>
                    moved.has(item.id) ? { ...item, position: moved.get(item.id)! } : item,
                  ),
                });
              }}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              minZoom={0.15}
              maxZoom={2}
              snapToGrid
              snapGrid={[10, 10]}
              selectionOnDrag
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--editor-border)" gap={20} size={1} />
              <Controls showInteractive={false} />
              <MiniMap nodeColor={(node) => colors[(node.data as NodeData).kind]} pannable zoomable />
            </ReactFlow>
          </div>
          {inspector && (
            <aside className="diagram-inspector" aria-label="Diagram properties">
              <h4>
                {selectedNode
                  ? 'Node properties'
                  : selectedEdge
                    ? 'Connection properties'
                    : 'Diagram properties'}
                {selected && (
                  <button
                    className="editor-button ghost editor-icon-button"
                    aria-label="Clear selection"
                    onClick={() => setSelected(undefined)}
                  >
                    <X size={13} />
                  </button>
                )}
              </h4>
              {selectedNode ? (
                <>
                  <label className="editor-field">
                    Label
                    <input
                      className="editor-input"
                      value={selectedNode.data.label}
                      onChange={(event) => updateNodeData({ label: event.target.value })}
                      disabled={readOnly}
                    />
                  </label>
                  <label className="editor-field">
                    Description
                    <textarea
                      className="editor-textarea"
                      value={selectedNode.data.description}
                      onChange={(event) => updateNodeData({ description: event.target.value })}
                      disabled={readOnly}
                    />
                  </label>
                  <label className="editor-field">
                    Type
                    <select
                      className="editor-select"
                      value={selectedNode.type}
                      onChange={(event) => updateNode({ type: event.target.value as NodeKind })}
                      disabled={readOnly}
                    >
                      {kinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="editor-field">
                    Group
                    <select
                      className="editor-select"
                      value={selectedNode.parentId ?? ''}
                      disabled={readOnly}
                      onChange={(event) => {
                        const previousParent = current.current.nodes.find(
                          (node) => node.id === selectedNode.parentId,
                        );
                        const nextParent = current.current.nodes.find(
                          (node) => node.id === event.target.value,
                        );
                        const absolute = (item: Diagram['nodes'][number]): { x: number; y: number } => {
                          const parent = current.current.nodes.find(
                            (candidate) => candidate.id === item.parentId,
                          );
                          const offset = parent ? absolute(parent) : { x: 0, y: 0 };
                          return { x: item.position.x + offset.x, y: item.position.y + offset.y };
                        };
                        const oldOffset = previousParent ? absolute(previousParent) : { x: 0, y: 0 };
                        const newOffset = nextParent ? absolute(nextParent) : { x: 0, y: 0 };
                        updateNode({
                          parentId: event.target.value || undefined,
                          position: {
                            x: nextParent
                              ? Math.max(20, selectedNode.position.x + oldOffset.x - newOffset.x)
                              : selectedNode.position.x + oldOffset.x,
                            y: nextParent
                              ? Math.max(55, selectedNode.position.y + oldOffset.y - newOffset.y)
                              : selectedNode.position.y + oldOffset.y,
                          },
                        });
                      }}
                    >
                      <option value="">No group</option>
                      {current.current.nodes
                        .filter((node) => node.type === 'group' && node.id !== selectedNode.id)
                        .map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.data.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="editor-field">
                    Requirement IDs
                    <input
                      className="editor-input"
                      placeholder="Comma-separated IDs"
                      value={selectedNode.data.requirementIds.join(', ')}
                      onChange={(event) =>
                        updateNodeData({
                          requirementIds: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                      disabled={readOnly}
                    />
                  </label>
                  {selectedNode.type === 'entity' && (
                    <div className="editor-field">
                      <span>Table fields</span>
                      {selectedNode.data.fields.map((field, index) => (
                        <div key={index}>
                          <div className="entity-field-row">
                            <input
                              className="editor-input"
                              aria-label={`Field ${index + 1} name`}
                              value={field.name}
                              disabled={readOnly}
                              onChange={(event) =>
                                updateNodeData({
                                  fields: selectedNode.data.fields.map((value, i) =>
                                    i === index ? { ...value, name: event.target.value } : value,
                                  ),
                                })
                              }
                            />
                            <input
                              className="editor-input"
                              aria-label={`Field ${index + 1} type`}
                              value={field.type}
                              disabled={readOnly}
                              onChange={(event) =>
                                updateNodeData({
                                  fields: selectedNode.data.fields.map((value, i) =>
                                    i === index ? { ...value, type: event.target.value } : value,
                                  ),
                                })
                              }
                            />
                            <button
                              className="editor-button ghost editor-icon-button"
                              aria-label={`Delete field ${index + 1}`}
                              disabled={readOnly}
                              onClick={() =>
                                updateNodeData({
                                  fields: selectedNode.data.fields.filter((_, i) => i !== index),
                                })
                              }
                            >
                              <X size={12} />
                            </button>
                          </div>
                          <div className="entity-field-flags">
                            {(['primary', 'foreign', 'nullable'] as const).map((flag) => (
                              <label key={flag}>
                                <input
                                  type="checkbox"
                                  checked={!!field[flag]}
                                  disabled={readOnly}
                                  onChange={(event) =>
                                    updateNodeData({
                                      fields: selectedNode.data.fields.map((value, i) =>
                                        i === index ? { ...value, [flag]: event.target.checked } : value,
                                      ),
                                    })
                                  }
                                />
                                {flag === 'primary' ? 'PK' : flag === 'foreign' ? 'FK' : 'Null'}
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                      <button
                        className="editor-button"
                        disabled={readOnly}
                        onClick={() =>
                          updateNodeData({
                            fields: [...selectedNode.data.fields, { name: 'field', type: 'text' }],
                          })
                        }
                      >
                        <Plus size={13} /> Add field
                      </button>
                    </div>
                  )}
                  <button className="editor-button danger" onClick={removeSelection} disabled={readOnly}>
                    <Trash2 size={13} /> Delete{' '}
                    {selectedNode.type === 'group' ? 'group and contents' : 'node'}
                  </button>
                </>
              ) : selectedEdge ? (
                <>
                  <label className="editor-field">
                    Label
                    <input
                      className="editor-input"
                      value={selectedEdge.label}
                      onChange={(event) => updateEdge({ label: event.target.value })}
                      disabled={readOnly}
                    />
                  </label>
                  <label className="editor-field">
                    Connection type
                    <select
                      className="editor-select"
                      value={selectedEdge.kind}
                      onChange={(event) =>
                        updateEdge({ kind: event.target.value as Diagram['edges'][number]['kind'] })
                      }
                      disabled={readOnly}
                    >
                      {Object.keys(edgeColors).map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="editor-field">
                    Cardinality
                    <select
                      className="editor-select"
                      value={selectedEdge.cardinality ?? ''}
                      onChange={(event) => updateEdge({ cardinality: event.target.value || undefined })}
                      disabled={readOnly}
                    >
                      <option value="">None</option>
                      {['1:1', '1:N', 'N:1', 'N:N', '0..1', '0..N'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <button className="editor-button danger" onClick={removeSelection} disabled={readOnly}>
                    <Trash2 size={13} /> Delete connection
                  </button>
                </>
              ) : (
                <>
                  <label className="editor-field">
                    Title
                    <input
                      className="editor-input"
                      value={current.current.title}
                      onChange={(event) =>
                        event.target.value && commit({ ...current.current, title: event.target.value })
                      }
                      disabled={readOnly}
                    />
                  </label>
                  <label className="editor-field">
                    Diagram kind
                    <select
                      className="editor-select"
                      value={current.current.kind}
                      onChange={(event) =>
                        commit({ ...current.current, kind: event.target.value as Diagram['kind'] })
                      }
                      disabled={readOnly}
                    >
                      <option value="workflow">User workflow</option>
                      <option value="ui">UI / UX flow</option>
                      <option value="database">Database structure</option>
                      <option value="backend">Backend logic</option>
                    </select>
                  </label>
                  <p className="editor-help">
                    Connect the right handle of a node to the left handle of another. Select a node or
                    connection to edit its properties. Assign nodes to groups in the properties panel.
                  </p>
                </>
              )}
            </aside>
          )}
        </div>
      )}
      <div className="diagram-legend">
        {Object.entries(edgeColors).map(([kind, color]) => (
          <span key={kind}>
            <i style={{ background: color }} />
            {kind}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DiagramEditor(props: Props) {
  return (
    <ReactFlowProvider key={props.diagram.id}>
      <DiagramCanvas {...props} />
    </ReactFlowProvider>
  );
}
