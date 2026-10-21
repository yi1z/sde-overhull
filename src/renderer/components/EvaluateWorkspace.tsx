import { useRef, useState } from 'react';
import {
  Plus,
  MessageSquare,
  Bug,
  Lightbulb,
  Paperclip,
  ArrowRight,
  LayoutList,
  Columns3,
} from 'lucide-react';
import type { EvaluationItem, ProjectView } from '../../shared/types';
import { Modal } from './Modal';
export function EvaluateWorkspace({
  project,
  onSave,
  onAttach,
  onNewRound,
}: {
  project: ProjectView;
  onSave: (item: EvaluationItem) => Promise<void>;
  onAttach: (id: string) => Promise<EvaluationItem>;
  onNewRound: (ids: string[]) => Promise<void>;
}) {
  const [item, setItem] = useState<EvaluationItem | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [layout, setLayout] = useState<'board' | 'list'>('board');
  const [filter, setFilter] = useState('all');
  const openItem = (value: EvaluationItem) => {
    setItem(structuredClone(value));
    setComment('');
    setError('');
  };
  const close = () => {
    if (pending.current) return;
    setItem(null);
    setComment('');
    setError('');
  };
  const create = () =>
    openItem({
      id: crypto.randomUUID(),
      title: '',
      body: '',
      kind: 'idea',
      priority: 'medium',
      status: 'open',
      roundId: project.design.roundId,
      runId: project.runs.findLast((run) => run.designId === project.design.id)?.id,
      author: 'Developer',
      createdAt: new Date().toISOString(),
      comments: [],
      attachments: [],
    });
  async function save(action: 'save' | 'attach') {
    if (!item?.title.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    let saved = false;
    const next = comment.trim()
      ? {
          ...item,
          comments: [
            ...item.comments,
            {
              id: crypto.randomUUID(),
              author: 'Developer',
              text: comment.trim(),
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : item;
    try {
      await onSave(next);
      saved = true;
      setItem(next);
      setComment('');
      if (action === 'attach') setItem(await onAttach(next.id));
      else setItem(null);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(
        saved
          ? `Could not attach the file: ${detail} Your feedback is saved. Try attaching the file again.`
          : `Could not save feedback: ${detail} Your edits are still here. Try again.`,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const visible = project.feedback.filter((f) => filter === 'all' || f.kind === filter);
  const icon = (kind: string) =>
    kind === 'bug' ? (
      <Bug size={15} />
    ) : kind === 'idea' ? (
      <Lightbulb size={15} />
    ) : (
      <MessageSquare size={15} />
    );
  const card = (feedback: EvaluationItem) => (
    <article className="feedback-card" key={feedback.id}>
      <div className="feedback-card-top">
        <span className={`feedback-kind ${feedback.kind}`}>
          {icon(feedback.kind)}
          {feedback.kind}
        </span>
        <input
          type="checkbox"
          aria-label={`Include ${feedback.title} in next round`}
          checked={selected.includes(feedback.id)}
          onChange={(e) =>
            setSelected(
              e.target.checked ? [...selected, feedback.id] : selected.filter((id) => id !== feedback.id),
            )
          }
        />
      </div>
      <button className="text-button card-title" onClick={() => openItem(feedback)}>
        {feedback.title}
      </button>
      <p>{feedback.body}</p>
      <footer>
        <span className={`priority ${feedback.priority}`}>{feedback.priority}</span>
        <span>
          <MessageSquare size={12} />
          {feedback.comments.length}
        </span>
      </footer>
    </article>
  );
  return (
    <section className="phase-workspace">
      <div className="workspace-title">
        <div>
          <span className="eyebrow">EVALUATE</span>
          <h1>Make the next iteration better.</h1>
          <p>Bring observations, questions, and ideas into one shared space.</p>
        </div>
        <button className="primary" onClick={create}>
          <Plus size={16} />
          Add feedback
        </button>
      </div>
      <div className="workspace-toolbar">
        <div className="segmented">
          {['all', 'bug', 'idea', 'question'].map((kind) => (
            <button className={filter === kind ? 'active' : ''} onClick={() => setFilter(kind)} key={kind}>
              {kind === 'all' ? 'All feedback' : kind + 's'}
            </button>
          ))}
        </div>
        <div className="button-row">
          <button
            className="icon-button"
            aria-label="Toggle board or list"
            onClick={() => setLayout(layout === 'board' ? 'list' : 'board')}
          >
            {layout === 'board' ? <LayoutList size={17} /> : <Columns3 size={17} />}
          </button>
          <button disabled={!selected.length} onClick={() => void onNewRound(selected)}>
            Next design round {selected.length > 0 && `(${selected.length})`}
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
      {layout === 'board' ? (
        <div className="feedback-board">
          {(['open', 'in-progress', 'resolved'] as const).map((status) => (
            <div className="feedback-column" key={status}>
              <h3>
                <span className={`status-dot ${status}`} />
                {status === 'in-progress' ? 'In progress' : status === 'open' ? 'Open' : 'Resolved'}
                <span className="count">{visible.filter((f) => f.status === status).length}</span>
              </h3>
              {visible.filter((f) => f.status === status).map(card)}
              {!visible.some((f) => f.status === status) && (
                <div className="column-empty">No {status === 'in-progress' ? 'active' : status} feedback</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="feedback-list">{visible.map(card)}</div>
      )}
      {!project.feedback.length && (
        <div className="subtle-note">
          Run the implementation, try its main workflows, and capture what should happen next.
        </div>
      )}
      {item && (
        <Modal title={item.title ? 'Feedback details' : 'New feedback'} onClose={close}>
          <div className="modal-body" aria-busy={busy}>
            <label className="field">
              Title
              <input
                autoFocus
                disabled={busy}
                value={item.title}
                onChange={(e) => setItem({ ...item, title: e.target.value })}
              />
            </label>
            <label className="field">
              Observation or suggestion
              <textarea
                rows={5}
                disabled={busy}
                value={item.body}
                onChange={(e) => setItem({ ...item, body: e.target.value })}
              />
            </label>
            <div className="form-grid">
              {(['kind', 'priority', 'status'] as const).map((key) => (
                <label className="field" key={key}>
                  {key}
                  <select
                    value={item[key]}
                    disabled={busy}
                    onChange={(e) => setItem({ ...item, [key]: e.target.value })}
                  >
                    {(key === 'kind'
                      ? ['bug', 'idea', 'question']
                      : key === 'priority'
                        ? ['low', 'medium', 'high']
                        : ['open', 'in-progress', 'resolved']
                    ).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <label className="field">
              Related screen, diagram node, or code location
              <input
                value={item.target ?? ''}
                disabled={busy}
                onChange={(e) => setItem({ ...item, target: e.target.value })}
                placeholder="Optional reference"
              />
            </label>
            {item.comments.map((c) => (
              <div className="feedback-comment" key={c.id}>
                <strong>{c.author}</strong>
                <p>{c.text}</p>
              </div>
            ))}
            <label className="field">
              Add a comment
              <textarea
                rows={2}
                value={comment}
                disabled={busy}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            {item.attachments.map((file) => (
              <small key={file}>{file}</small>
            ))}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="modal-actions">
            <button onClick={() => void save('attach')} disabled={busy || !item.title.trim()}>
              <Paperclip size={15} />
              Attach file
            </button>
            <button
              className="primary"
              disabled={busy || !item.title.trim()}
              onClick={() => void save('save')}
            >
              Save feedback
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
