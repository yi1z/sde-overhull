import { useEffect, useState } from 'react';
import { GitBranch, ArrowDown, ArrowUp, GitMerge, Check, FileCode2 } from 'lucide-react';
import type { GitConflict, ProjectView } from '../../shared/types';
import { Modal } from './Modal';
export function GitDialog({
  project,
  onClose,
  onRefresh,
  onError,
}: {
  project: ProjectView;
  onClose: () => void;
  onRefresh: (view: ProjectView) => void;
  onError: (error: unknown) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [diff, setDiff] = useState('Select a file to inspect its changes.');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<GitConflict>();
  const [resolved, setResolved] = useState('');
  const [tab, setTab] = useState<'changes' | 'conflicts'>('changes');
  useEffect(() => {
    setSelected(project.git.files.filter((f) => !f.conflicted).map((f) => f.path));
  }, [project.git.head]);
  async function action(fn: () => Promise<ProjectView>): Promise<boolean> {
    setBusy(true);
    try {
      onRefresh(await fn());
      return true;
    } catch (e) {
      onError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Repository changes"
      description="Review and share code, designs, and discussion through Git."
      onClose={onClose}
      wide
    >
      <div className="git-summary">
        <span>
          <GitBranch size={15} />
          {project.git.branch || 'No commits yet'}
        </span>
        <code>{project.git.head.slice(0, 8)}</code>
        <span>
          {project.git.ahead} ahead · {project.git.behind} behind
        </span>
      </div>
      <div className="workspace-toolbar">
        <div className="segmented">
          <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
            Changes ({project.git.files.length})
          </button>
          <button className={tab === 'conflicts' ? 'active' : ''} onClick={() => setTab('conflicts')}>
            Conflicts ({project.git.conflicts.length})
          </button>
        </div>
        <div className="button-row">
          <button disabled={busy} onClick={() => void action(() => window.sde.request('git.fetch'))}>
            Fetch
          </button>
          <button disabled={busy} onClick={() => void action(() => window.sde.request('git.pull'))}>
            <ArrowDown size={14} />
            Pull
          </button>
          <button disabled={busy} onClick={() => void action(() => window.sde.request('git.push'))}>
            <ArrowUp size={14} />
            Push
          </button>
          {project.git.ahead > 0 && project.git.behind > 0 && (
            <button disabled={busy} onClick={() => void action(() => window.sde.request('git.merge'))}>
              <GitMerge size={14} />
              Merge remote
            </button>
          )}
        </div>
      </div>
      {tab === 'changes' ? (
        <>
          <div className="git-body">
            <div className="git-file-list">
              {project.git.files.map((file) => (
                <div className="git-file" key={file.path}>
                  <input
                    type="checkbox"
                    aria-label={`Commit ${file.path}`}
                    disabled={file.conflicted}
                    checked={selected.includes(file.path)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? [...selected, file.path] : selected.filter((p) => p !== file.path),
                      )
                    }
                  />
                  <button
                    onClick={() =>
                      void window.sde.request('git.diff', { path: file.path }).then(setDiff).catch(onError)
                    }
                  >
                    <FileCode2 size={13} />
                    <span>{file.path}</span>
                    <em>{file.conflicted ? '!' : file.index + file.worktree}</em>
                  </button>
                </div>
              ))}
              {!project.git.files.length && (
                <div className="empty-inline">
                  <Check size={16} />
                  Working tree is clean.
                </div>
              )}
            </div>
            <pre className="diff-view">{diff}</pre>
          </div>
          <footer className="git-commit">
            <input
              aria-label="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe these changes…"
            />
            <button
              className="primary"
              disabled={busy || !selected.length || !message.trim() || !!project.git.conflicts.length}
              onClick={() =>
                void action(() => window.sde.request('git.commit', { message, paths: selected })).then(
                  (succeeded) => {
                    if (succeeded) setMessage('');
                  },
                )
              }
            >
              Commit {selected.length} files
            </button>
          </footer>
        </>
      ) : (
        <div className="modal-body">
          {project.git.conflicts.map((file) => (
            <button
              key={file}
              onClick={() =>
                void window.sde
                  .request('git.conflict', { path: file })
                  .then((value) => {
                    setConflict(value);
                    setResolved(value.ours);
                  })
                  .catch(onError)
              }
            >
              {file}
            </button>
          ))}
          {!project.git.conflicts.length && (
            <div>
              <p className="muted">
                No unresolved merge conflicts. Review the result and finish any pending merge.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    window.sde.request('git.finishMerge', { message: 'Merge remote changes' }),
                  )
                }
              >
                Finish merge
              </button>
            </div>
          )}
          {conflict && (
            <>
              <h3>{conflict.path}</h3>
              <div className="conflict-sides">
                <div>
                  <h4>Local version</h4>
                  <pre>{conflict.ours}</pre>
                  <button onClick={() => setResolved(conflict.ours)}>Use local</button>
                </div>
                <div>
                  <h4>Remote version</h4>
                  <pre>{conflict.theirs}</pre>
                  <button onClick={() => setResolved(conflict.theirs)}>Use remote</button>
                </div>
              </div>
              <label className="field">
                Resolved content
                <textarea
                  className="source-editor"
                  rows={12}
                  value={resolved}
                  onChange={(e) => setResolved(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    window.sde.request('git.resolve', { path: conflict.path, content: resolved }),
                  ).then((succeeded) => {
                    if (succeeded) setConflict(undefined);
                  })
                }
              >
                Validate and stage resolution
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
