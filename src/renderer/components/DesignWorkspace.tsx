import { useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Workflow,
  Monitor,
  Database,
  Server,
  LayoutTemplate,
  ListChecks,
  ShieldCheck,
  Plus,
  Trash2,
  CircleCheck,
  Circle,
  CircleHelp,
  GitCommitHorizontal,
  ChevronLeft,
  ChevronRight,
  History,
  Layers,
  AlertCircle,
} from 'lucide-react';
import {
  type DesignRevision,
  type Diagram,
  type Prototype,
  type VerificationCheck,
} from '../../shared/types';
import { DiagramEditor } from './DiagramEditor';
import { PrototypeEditor } from './PrototypeEditor';
import '../editor.css';

type Props = {
  draft: DesignRevision;
  onChange: (draft: DesignRevision) => void;
  onApprove: () => void;
  busy?: boolean;
  onSelection?: (selection: { artifactId?: string; nodeId?: string }) => void;
  readOnly?: boolean;
  history?: DesignRevision[];
  onHistory?: () => void;
};
const diagramIcons = { workflow: Workflow, ui: Monitor, database: Database, backend: Server };
const diagramTitles = {
  workflow: 'User workflow',
  ui: 'UI / UX flow',
  database: 'Database structure',
  backend: 'Backend logic',
};
const id = () => crypto.randomUUID();
const ids = (text: string) =>
  text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

function CheckCommand({
  check,
  onChange,
  disabled,
}: {
  check: VerificationCheck;
  onChange: (check: VerificationCheck) => void;
  disabled: boolean;
}) {
  const [args, setArgs] = useState(JSON.stringify(check.command.args));
  const [error, setError] = useState('');
  useEffect(() => {
    setArgs(JSON.stringify(check.command.args));
  }, [check.command.args]);
  return (
    <>
      <div className="design-card-row">
        <label className="editor-field">
          Executable
          <input
            className="editor-input editor-code"
            value={check.command.executable}
            placeholder="pnpm"
            onChange={(event) =>
              onChange({ ...check, command: { ...check.command, executable: event.target.value } })
            }
            disabled={disabled}
          />
        </label>
        <label className="editor-field">
          Working directory
          <input
            className="editor-input editor-code"
            value={check.command.cwd}
            placeholder="."
            onChange={(event) =>
              onChange({ ...check, command: { ...check.command, cwd: event.target.value } })
            }
            disabled={disabled}
          />
        </label>
      </div>
      <label className="editor-field">
        Arguments (JSON array)
        <input
          className="editor-input editor-code"
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          onBlur={() => {
            try {
              const parsed: unknown = JSON.parse(args);
              if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string'))
                throw new Error('Arguments must be a JSON array of strings.');
              onChange({ ...check, command: { ...check.command, args: parsed } });
              setError('');
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
          disabled={disabled}
          aria-invalid={!!error}
        />
      </label>
      {error && (
        <p className="editor-error" role="alert">
          {error}
        </p>
      )}
      <div className="design-card-row">
        <label className="editor-field">
          Timeout (seconds)
          <input
            className="editor-input"
            type="number"
            min="1"
            value={check.command.timeoutMs / 1000}
            onChange={(event) =>
              onChange({
                ...check,
                command: { ...check.command, timeoutMs: Math.max(1, Number(event.target.value)) * 1000 },
              })
            }
            disabled={disabled}
          />
        </label>
        <label className="editor-field">
          Task IDs
          <input
            className="editor-input"
            placeholder="Comma-separated IDs"
            value={check.taskIds.join(', ')}
            onChange={(event) => onChange({ ...check, taskIds: ids(event.target.value) })}
            disabled={disabled}
          />
        </label>
      </div>
      <label className="editor-field">
        Service IDs required for this check
        <input
          className="editor-input"
          placeholder="Comma-separated service IDs"
          value={check.serviceIds.join(', ')}
          onChange={(event) => onChange({ ...check, serviceIds: ids(event.target.value) })}
          disabled={disabled}
        />
      </label>
    </>
  );
}

export function DesignWorkspace({
  draft,
  onChange,
  onApprove,
  busy = false,
  onSelection,
  readOnly = false,
  history = [],
  onHistory,
}: Props) {
  const [selected, setSelected] = useState('overview');
  const [diagramKind, setDiagramKind] = useState<Diagram['kind']>('workflow');
  const [collapsed, setCollapsed] = useState(false);
  const [historyId, setHistoryId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const disabled = busy || readOnly;
  const diagram = draft.diagrams.find((item) => item.id === selected);
  const prototype = draft.prototypes.find((item) => item.id === selected);
  const screens = useMemo(
    () => draft.prototypes.map((item) => ({ id: item.id, title: item.title })),
    [draft.prototypes],
  );
  const navigate = (value: string) => {
    setSelected(value);
    setConfirmDelete(false);
    onSelection?.({ artifactId: ['overview', 'plan', 'review'].includes(value) ? undefined : value });
  };
  useEffect(() => {
    if (
      !['overview', 'plan', 'review'].includes(selected) &&
      !draft.diagrams.some((item) => item.id === selected) &&
      !draft.prototypes.some((item) => item.id === selected)
    )
      setSelected('overview');
  }, [draft.diagrams, draft.prototypes, selected]);
  const update = (value: DesignRevision) =>
    onChange({ ...value, reviewedDigest: undefined, reviewSummary: undefined });
  const updateDiagram = (value: Diagram) =>
    update({ ...draft, diagrams: draft.diagrams.map((item) => (item.id === value.id ? value : item)) });
  const updatePrototype = (value: Prototype) =>
    update({ ...draft, prototypes: draft.prototypes.map((item) => (item.id === value.id ? value : item)) });

  const addDiagram = () => {
    const value: Diagram = {
      id: id(),
      title: diagramTitles[diagramKind],
      kind: diagramKind,
      revision: 0,
      nodes: [],
      edges: [],
    };
    update({ ...draft, diagrams: [...draft.diagrams, value] });
    navigate(value.id);
  };
  const addPrototype = () => {
    const value: Prototype = {
      id: id(),
      title: `Screen ${draft.prototypes.length + 1}`,
      revision: 0,
      requirementIds: [],
      data: { root: { props: { title: 'New screen', background: '#ffffff' } }, content: [] },
    };
    update({ ...draft, prototypes: [...draft.prototypes, value] });
    navigate(value.id);
  };
  const deleteArtifact = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    update({
      ...draft,
      diagrams: draft.diagrams.filter((item) => item.id !== selected),
      prototypes: draft.prototypes.filter((item) => item.id !== selected),
    });
    navigate('overview');
  };
  const readiness = [
    {
      label: 'Requirements define the intended behavior',
      passed:
        draft.requirements.length > 0 &&
        draft.requirements.every((requirement) => requirement.title.trim() && requirement.acceptance.trim()),
    },
    {
      label: 'Implementation tasks are specified',
      passed: draft.tasks.length > 0 && draft.tasks.every((task) => task.title.trim()),
    },
    {
      label: 'Required automated checks have executable commands',
      passed:
        draft.checks.some((check) => check.required) &&
        draft.checks.filter((check) => check.required).every((check) => check.command.executable.trim()),
    },
    {
      label: 'Blocking questions have answers',
      passed: draft.questions.every((question) => !question.blocking || question.answer?.trim()),
    },
    { label: 'The agent reviewed this revision', passed: !!draft.reviewedDigest },
  ];
  const canApprove = readiness.every((item) => item.passed);
  const historical = history.find((item) => item.id === historyId);

  return (
    <div className="design-workspace">
      <div className="design-topbar">
        <div className="design-heading">
          <Layers size={17} />
          <h2>{draft.title}</h2>
          <span className="design-badge">
            {readOnly ? 'Read-only' : 'Draft'} · r{draft.revision}
          </span>
        </div>
        <div className="design-heading">
          <button
            className="editor-button"
            onClick={() => {
              navigate('review');
              onHistory?.();
            }}
          >
            <ShieldCheck size={14} /> Review design
          </button>
          <button
            className="editor-button primary"
            disabled={disabled || !canApprove}
            title={
              canApprove
                ? 'Freeze and commit the agent-reviewed design'
                : 'Complete the design review checklist first'
            }
            onClick={onApprove}
          >
            <GitCommitHorizontal size={14} /> Confirm & commit
          </button>
        </div>
      </div>
      {readOnly && (
        <div className="editor-notice">
          <AlertCircle size={14} /> This design is read-only. Create a new design round to make changes.
        </div>
      )}
      <div className="design-body">
        {!collapsed && (
          <aside className="artifact-sidebar" aria-label="Design artifacts">
            <div className="artifact-section-label">
              Design round
              <button
                className="editor-button ghost editor-icon-button"
                aria-label="Collapse artifact outline"
                onClick={() => setCollapsed(true)}
              >
                <ChevronLeft size={13} />
              </button>
            </div>
            <button
              className={`artifact-item ${selected === 'overview' ? 'selected' : ''}`}
              onClick={() => navigate('overview')}
            >
              <FileText size={15} />
              <span>Brief & requirements</span>
            </button>
            <button
              className={`artifact-item ${selected === 'plan' ? 'selected' : ''}`}
              onClick={() => navigate('plan')}
            >
              <ListChecks size={15} />
              <span>Tasks & verification</span>
              <small>{draft.tasks.length}</small>
            </button>
            <button
              className={`artifact-item ${selected === 'review' ? 'selected' : ''}`}
              onClick={() => {
                navigate('review');
                onHistory?.();
              }}
            >
              <ShieldCheck size={15} />
              <span>Review & revisions</span>
            </button>
            <div className="artifact-section-label">
              Diagrams<span>{draft.diagrams.length}</span>
            </div>
            {draft.diagrams.map((item) => {
              const Icon = diagramIcons[item.kind];
              return (
                <button
                  className={`artifact-item ${selected === item.id ? 'selected' : ''}`}
                  key={item.id}
                  onClick={() => navigate(item.id)}
                >
                  <Icon size={14} />
                  <span>{item.title}</span>
                </button>
              );
            })}
            {!draft.diagrams.length && (
              <p className="editor-help" style={{ padding: '2px 8px 8px' }}>
                Design with the agent, or add a diagram.
              </p>
            )}
            <div className="artifact-create">
              <select
                className="editor-select"
                aria-label="New diagram kind"
                value={diagramKind}
                onChange={(event) => setDiagramKind(event.target.value as Diagram['kind'])}
                disabled={disabled}
              >
                {Object.entries(diagramTitles).map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
              <button
                className="editor-button editor-icon-button"
                aria-label="Add diagram"
                onClick={addDiagram}
                disabled={disabled}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="artifact-section-label">
              Prototypes
              <button
                className="editor-button ghost editor-icon-button"
                aria-label="Add prototype screen"
                onClick={addPrototype}
                disabled={disabled}
              >
                <Plus size={13} />
              </button>
            </div>
            {draft.prototypes.map((item) => (
              <button
                className={`artifact-item ${selected === item.id ? 'selected' : ''}`}
                key={item.id}
                onClick={() => navigate(item.id)}
              >
                <LayoutTemplate size={14} />
                <span>{item.title}</span>
              </button>
            ))}
            {!draft.prototypes.length && (
              <p className="editor-help" style={{ padding: '2px 8px' }}>
                Editable screens make the idea tangible.
              </p>
            )}
          </aside>
        )}
        <main className="design-main">
          {(collapsed || diagram || prototype) && (
            <div className="editor-toolbar">
              {collapsed && (
                <button
                  className="editor-button editor-icon-button"
                  aria-label="Expand artifact outline"
                  onClick={() => setCollapsed(false)}
                >
                  <ChevronRight size={14} />
                </button>
              )}
              {(diagram || prototype) && (
                <>
                  <input
                    className="editor-input"
                    aria-label="Artifact title"
                    value={(diagram || prototype)!.title}
                    disabled={disabled}
                    onChange={(event) => {
                      if (diagram) updateDiagram({ ...diagram, title: event.target.value });
                      else if (prototype) updatePrototype({ ...prototype, title: event.target.value });
                    }}
                  />
                  <span className="design-badge">
                    {diagram ? diagramTitles[diagram.kind] : 'Visual prototype'}
                  </span>
                  <span className="editor-spacer" />
                  <button className="editor-button ghost danger" onClick={deleteArtifact} disabled={disabled}>
                    <Trash2 size={13} />
                    {confirmDelete ? 'Confirm delete' : 'Delete'}
                  </button>
                  {confirmDelete && (
                    <button className="editor-button ghost" onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {diagram ? (
            <DiagramEditor
              diagram={diagram}
              onChange={updateDiagram}
              onSelection={onSelection}
              readOnly={disabled}
            />
          ) : prototype ? (
            <PrototypeEditor
              prototype={prototype}
              onChange={updatePrototype}
              onSelection={onSelection}
              screens={screens}
              onNavigate={navigate}
              readOnly={disabled}
            />
          ) : selected === 'plan' ? (
            <div className="design-document">
              <h3>Make the design executable</h3>
              <p>
                Connect implementation tasks to requirements and define the checks that must pass before this
                round is considered complete.
              </p>
              <section className="design-section">
                <div className="design-section-header">
                  <h4>
                    <ListChecks size={16} /> Implementation tasks
                  </h4>
                  <button
                    className="editor-button"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        ...draft,
                        tasks: [
                          ...draft.tasks,
                          { id: id(), title: 'New task', description: '', requirementIds: [] },
                        ],
                      })
                    }
                  >
                    <Plus size={13} /> Add task
                  </button>
                </div>
                {!draft.tasks.length && (
                  <div className="design-empty">
                    Ask the agent to break the design into implementable tasks, or add one here.
                  </div>
                )}
                {draft.tasks.map((task, index) => (
                  <article className="design-card" key={task.id}>
                    <div className="design-card-row">
                      <span className="design-badge">{index + 1}</span>
                      <input
                        className="editor-input"
                        aria-label={`Task ${index + 1} title`}
                        value={task.title}
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            tasks: draft.tasks.map((item) =>
                              item.id === task.id ? { ...item, title: event.target.value } : item,
                            ),
                          })
                        }
                      />
                      <button
                        className="editor-button ghost editor-icon-button"
                        aria-label={`Delete task ${index + 1}`}
                        disabled={disabled}
                        onClick={() =>
                          update({
                            ...draft,
                            tasks: draft.tasks.filter((item) => item.id !== task.id),
                            checks: draft.checks.map((check) => ({
                              ...check,
                              taskIds: check.taskIds.filter((value) => value !== task.id),
                            })),
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <label className="editor-field">
                      Implementation notes
                      <textarea
                        className="editor-textarea"
                        value={task.description}
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            tasks: draft.tasks.map((item) =>
                              item.id === task.id ? { ...item, description: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="editor-field">
                      Requirement IDs
                      <input
                        className="editor-input"
                        value={task.requirementIds.join(', ')}
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            tasks: draft.tasks.map((item) =>
                              item.id === task.id
                                ? { ...item, requirementIds: ids(event.target.value) }
                                : item,
                            ),
                          })
                        }
                        placeholder="Comma-separated requirement IDs"
                      />
                    </label>
                    <div className="design-card-id">{task.id}</div>
                  </article>
                ))}
              </section>
              <section className="design-section">
                <div className="design-section-header">
                  <h4>
                    <CircleCheck size={16} /> Automated verification
                  </h4>
                  <button
                    className="editor-button"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        ...draft,
                        checks: [
                          ...draft.checks,
                          {
                            id: id(),
                            title: 'Automated tests',
                            kind: 'test',
                            required: true,
                            command: { executable: 'pnpm', args: ['test'], cwd: '.', timeoutMs: 120000 },
                            taskIds: [],
                            serviceIds: [],
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={13} /> Add check
                  </button>
                </div>
                {!draft.checks.length && (
                  <div className="design-empty">
                    Required tests and smoke checks are executed by the app before completion. Add commands
                    that return a nonzero exit code when they fail.
                  </div>
                )}
                {draft.checks.map((check, index) => {
                  const save = (next: VerificationCheck) =>
                    update({
                      ...draft,
                      checks: draft.checks.map((item) => (item.id === check.id ? next : item)),
                    });
                  return (
                    <article className="design-card" key={check.id}>
                      <div className="design-card-row">
                        <input
                          className="editor-input"
                          aria-label={`Check ${index + 1} title`}
                          value={check.title}
                          disabled={disabled}
                          onChange={(event) => save({ ...check, title: event.target.value })}
                        />
                        <select
                          className="editor-select"
                          aria-label={`Check ${index + 1} kind`}
                          value={check.kind}
                          disabled={disabled}
                          onChange={(event) =>
                            save({ ...check, kind: event.target.value as 'test' | 'smoke' })
                          }
                        >
                          <option value="test">Test</option>
                          <option value="smoke">Smoke</option>
                        </select>
                        <button
                          className="editor-button ghost editor-icon-button"
                          aria-label={`Delete check ${index + 1}`}
                          disabled={disabled}
                          onClick={() =>
                            update({ ...draft, checks: draft.checks.filter((item) => item.id !== check.id) })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <label className="editor-field-inline" style={{ marginBottom: 14 }}>
                        <input
                          type="checkbox"
                          checked={check.required}
                          disabled={disabled}
                          onChange={(event) => save({ ...check, required: event.target.checked })}
                        />
                        Required for completion
                      </label>
                      <CheckCommand check={check} onChange={save} disabled={disabled} />
                      <div className="design-card-id">{check.id}</div>
                    </article>
                  );
                })}
              </section>
            </div>
          ) : selected === 'review' ? (
            <div className="design-document">
              <h3>Review this design round</h3>
              <p>
                Confirm a shared, executable design before the agent begins implementation. Approval freezes
                this revision and creates a Git commit.
              </p>
              <div className="design-section">
                <div className="design-card">
                  <div className="design-section-header">
                    <h4>
                      <ShieldCheck size={16} /> Ready for implementation
                    </h4>
                    <span className={`design-badge ${canApprove ? 'success' : 'warning'}`}>
                      {readiness.filter((item) => item.passed).length} of {readiness.length} ready
                    </span>
                  </div>
                  <div className="approval-checklist">
                    {readiness.map((item) => (
                      <div key={item.label} className={item.passed ? 'passed' : 'pending'}>
                        {item.passed ? <CircleCheck size={15} /> : <Circle size={15} />}
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                  {!draft.reviewedDigest && (
                    <p className="editor-help">
                      Ask the agent to review the latest design and record its feasibility assessment. Manual
                      changes require a fresh review.
                    </p>
                  )}
                  {draft.reviewSummary && (
                    <div className="design-empty" style={{ margin: '15px 0', whiteSpace: 'pre-wrap' }}>
                      {draft.reviewSummary}
                    </div>
                  )}
                  <button
                    className="editor-button primary"
                    style={{ marginTop: 15 }}
                    disabled={disabled || !canApprove}
                    onClick={onApprove}
                  >
                    <GitCommitHorizontal size={14} /> Confirm & commit design
                  </button>
                </div>
              </div>
              <section className="design-section">
                <div className="design-section-header">
                  <h4>
                    <History size={16} /> Revision comparison
                  </h4>
                  <button className="editor-button" onClick={onHistory} disabled={!onHistory}>
                    Refresh history
                  </button>
                </div>
                {history.length ? (
                  <>
                    <label className="editor-field">
                      Compare with an approved revision
                      <select
                        className="editor-select"
                        value={historyId}
                        onChange={(event) => setHistoryId(event.target.value)}
                      >
                        <option value="">Choose a revision</option>
                        {history.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title} · r{item.revision} · {item.id.slice(0, 8)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {historical && (
                      <>
                        <p className="editor-help" style={{ marginBottom: 12 }}>
                          Requirements {historical.requirements.length} → {draft.requirements.length} · Tasks{' '}
                          {historical.tasks.length} → {draft.tasks.length} · Diagrams{' '}
                          {historical.diagrams.length} → {draft.diagrams.length} · Prototypes{' '}
                          {historical.prototypes.length} → {draft.prototypes.length}
                        </p>
                        <div className="revision-compare">
                          <div>
                            <h4>Approved revision</h4>
                            <pre>{JSON.stringify(historical, null, 2)}</pre>
                          </div>
                          <div>
                            <h4>Current draft</h4>
                            <pre>{JSON.stringify(draft, null, 2)}</pre>
                          </div>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div className="design-empty">
                    Approved design revisions will appear here after your first confirmation.
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="design-document">
              <h3>Shape the idea together</h3>
              <p>
                Describe the outcome in chat. The agent will develop the requirements, map the flows, and
                build editable screens alongside you.
              </p>
              <section className="design-section">
                <label className="editor-field">
                  Design title
                  <input
                    className="editor-input"
                    value={draft.title}
                    onChange={(event) => update({ ...draft, title: event.target.value })}
                    disabled={disabled}
                  />
                </label>
                <label className="editor-field">
                  Summary
                  <textarea
                    className="editor-textarea"
                    value={draft.summary}
                    placeholder="What are we building, who is it for, and what should it make possible?"
                    onChange={(event) => update({ ...draft, summary: event.target.value })}
                    disabled={disabled}
                    style={{ minHeight: 110 }}
                  />
                </label>
              </section>
              <section className="design-section">
                <div className="design-section-header">
                  <h4>
                    <FileText size={16} /> Requirements{' '}
                    <span className="design-badge">{draft.requirements.length}</span>
                  </h4>
                  <button
                    className="editor-button"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        ...draft,
                        requirements: [
                          ...draft.requirements,
                          { id: id(), title: 'New requirement', description: '', acceptance: '' },
                        ],
                      })
                    }
                  >
                    <Plus size={13} /> Add requirement
                  </button>
                </div>
                {!draft.requirements.length && (
                  <div className="design-empty">
                    Start a conversation with the agent to turn your idea into concrete requirements.
                  </div>
                )}
                {draft.requirements.map((requirement, index) => (
                  <article className="design-card" key={requirement.id}>
                    <div className="design-card-row">
                      <span className="design-badge">R{index + 1}</span>
                      <input
                        className="editor-input"
                        aria-label={`Requirement ${index + 1} title`}
                        value={requirement.title}
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            requirements: draft.requirements.map((item) =>
                              item.id === requirement.id ? { ...item, title: event.target.value } : item,
                            ),
                          })
                        }
                      />
                      <button
                        className="editor-button ghost editor-icon-button"
                        aria-label={`Delete requirement ${index + 1}`}
                        disabled={disabled}
                        onClick={() =>
                          update({
                            ...draft,
                            requirements: draft.requirements.filter((item) => item.id !== requirement.id),
                            tasks: draft.tasks.map((task) => ({
                              ...task,
                              requirementIds: task.requirementIds.filter((value) => value !== requirement.id),
                            })),
                            diagrams: draft.diagrams.map((item) => ({
                              ...item,
                              nodes: item.nodes.map((node) => ({
                                ...node,
                                data: {
                                  ...node.data,
                                  requirementIds: node.data.requirementIds.filter(
                                    (value) => value !== requirement.id,
                                  ),
                                },
                              })),
                            })),
                            prototypes: draft.prototypes.map((item) => ({
                              ...item,
                              requirementIds: item.requirementIds.filter((value) => value !== requirement.id),
                            })),
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <label className="editor-field">
                      Behavior
                      <textarea
                        className="editor-textarea"
                        value={requirement.description}
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            requirements: draft.requirements.map((item) =>
                              item.id === requirement.id
                                ? { ...item, description: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="editor-field">
                      Acceptance criteria
                      <textarea
                        className="editor-textarea"
                        value={requirement.acceptance}
                        placeholder="What must be true for this requirement to be satisfied?"
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            requirements: draft.requirements.map((item) =>
                              item.id === requirement.id ? { ...item, acceptance: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <div className="design-card-id">{requirement.id}</div>
                  </article>
                ))}
              </section>
              <section className="design-section">
                <div className="design-section-header">
                  <h4>
                    <CircleHelp size={16} /> Open questions
                  </h4>
                  <button
                    className="editor-button"
                    disabled={disabled}
                    onClick={() =>
                      update({
                        ...draft,
                        questions: [
                          ...draft.questions,
                          { id: id(), text: 'What should we clarify?', blocking: true },
                        ],
                      })
                    }
                  >
                    <Plus size={13} /> Add question
                  </button>
                </div>
                {!draft.questions.length && (
                  <p className="editor-help">
                    No open questions. The agent will raise decisions that affect the design here.
                  </p>
                )}
                {draft.questions.map((question, index) => (
                  <article className="design-card" key={question.id}>
                    <div className="design-card-row">
                      <input
                        className="editor-input"
                        aria-label={`Question ${index + 1}`}
                        value={question.text}
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            questions: draft.questions.map((item) =>
                              item.id === question.id ? { ...item, text: event.target.value } : item,
                            ),
                          })
                        }
                      />
                      <button
                        className="editor-button ghost editor-icon-button"
                        aria-label={`Delete question ${index + 1}`}
                        disabled={disabled}
                        onClick={() =>
                          update({
                            ...draft,
                            questions: draft.questions.filter((item) => item.id !== question.id),
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <label className="editor-field">
                      Answer
                      <textarea
                        className="editor-textarea"
                        value={question.answer ?? ''}
                        placeholder="Record your decision…"
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            questions: draft.questions.map((item) =>
                              item.id === question.id ? { ...item, answer: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="editor-field-inline">
                      <input
                        type="checkbox"
                        checked={question.blocking}
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            ...draft,
                            questions: draft.questions.map((item) =>
                              item.id === question.id ? { ...item, blocking: event.target.checked } : item,
                            ),
                          })
                        }
                      />
                      Must be answered before approval
                    </label>
                  </article>
                ))}
              </section>
              <section className="design-section">
                <div className="design-section-header">
                  <h4>
                    <GitCommitHorizontal size={16} /> Decisions
                  </h4>
                  <button
                    className="editor-button"
                    disabled={disabled}
                    onClick={() => update({ ...draft, decisions: [...draft.decisions, 'New decision'] })}
                  >
                    <Plus size={13} /> Add decision
                  </button>
                </div>
                {draft.decisions.map((decision, index) => (
                  <div className="design-card-row" key={index}>
                    <textarea
                      aria-label={`Decision ${index + 1}`}
                      className="editor-textarea"
                      value={decision}
                      disabled={disabled}
                      onChange={(event) =>
                        update({
                          ...draft,
                          decisions: draft.decisions.map((item, i) =>
                            i === index ? event.target.value : item,
                          ),
                        })
                      }
                      style={{ minHeight: 55 }}
                    />
                    <button
                      className="editor-button ghost editor-icon-button"
                      aria-label={`Delete decision ${index + 1}`}
                      disabled={disabled}
                      onClick={() =>
                        update({ ...draft, decisions: draft.decisions.filter((_, i) => i !== index) })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
