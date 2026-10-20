import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Boxes,
  GitBranch,
  FolderOpen,
  Plus,
  Settings2,
  GitPullRequest,
  PanelRightClose,
  PanelRightOpen,
  PenTool,
  Code2,
  MessageSquare,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  ShieldCheck,
  AlertTriangle,
  X,
  LoaderCircle,
  Check,
  GitCommitHorizontal,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import type { AgentEvent, AppEvent, DesignRevision, Phase, ProjectView, Settings } from '../shared/types';
import { SettingsSchema } from '../shared/types';
import { DesignWorkspace } from './components/DesignWorkspace';
import { ChatPanel } from './components/ChatPanel';
import { EvaluateWorkspace } from './components/EvaluateWorkspace';
import { ImplementWorkspace } from './components/ImplementWorkspace';
import { SettingsDialog } from './components/SettingsDialog';
import { GitDialog } from './components/GitDialog';
import { Modal } from './components/Modal';

export function App() {
  const [settings, setSettings] = useState<Settings>(SettingsSchema.parse({}));
  const [project, setProject] = useState<ProjectView>();
  const [phase, setPhase] = useState<Phase>('design');
  const [draft, setDraft] = useState<DesignRevision>();
  const [history, setHistory] = useState<DesignRevision[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'settings' | 'git' | 'new' | 'clone' | null>(null);
  const [newName, setNewName] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [chatVisible, setChatVisible] = useState(true);
  const [selection, setSelection] = useState<string>();
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'conflict'>('saved');
  const projectRef = useRef(project);
  const draftRef = useRef(draft);
  const dirty = useRef(false);
  const baseRevision = useRef(0);
  const sequence = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);
  const refreshRequest = useRef(0);
  const switching = useRef(false);
  const closing = useRef(false);
  const report = useCallback((e: unknown) => {
    setError(String(e).replace(/^Error: (Error invoking remote method '[^']+': Error: )?/, ''));
  }, []);
  const accept = useCallback((view: ProjectView) => {
    projectRef.current = view;
    setProject(view);
    if (!dirty.current) {
      draftRef.current = view.design;
      setDraft(view.design);
      baseRevision.current = view.design.revision;
    }
  }, []);
  const refresh = useCallback(async () => {
    if (!projectRef.current || switching.current) return;
    const currentGeneration = generation.current;
    const root = projectRef.current.root;
    const request = ++refreshRequest.current;
    const startingDraft = draftRef.current;
    const startingSequence = sequence.current;
    const startedDirty = dirty.current;
    try {
      const view = await window.sde.request('project.refresh');
      // A read begun before a manual edit/save can finish afterwards. It must
      // never replace that newer draft or reset the editor's current selection.
      if (
        !switching.current &&
        generation.current === currentGeneration &&
        projectRef.current?.root === root &&
        request === refreshRequest.current &&
        !startedDirty &&
        !dirty.current &&
        sequence.current === startingSequence &&
        draftRef.current === startingDraft
      )
        accept(view);
    } catch (e) {
      report(e);
    }
  }, [accept, report]);
  useEffect(() => {
    void window.sde.request('settings.get').then(setSettings).catch(report);
    return window.sde.onEvent((event: AppEvent) => {
      if (event.type === 'close-request') {
        if (closing.current) return;
        closing.current = true;
        void save()
          .then(() => window.sde.request('window.close'))
          .catch((error) => {
            closing.current = false;
            report(error);
          });
      } else if (event.type === 'project-changed') {
        void refresh();
      } else if (event.type === 'agent') {
        const item = event.data as AgentEvent;
        setEvents((old) => [...old.slice(-600), item]);
        if (item.type === 'turn-complete' || item.type === 'error') setAgentBusy(false);
        if (item.type === 'error') report(item.text);
        if (item.type === 'status' && (item.data as any)?.turn?.id) setAgentBusy(true);
      } else if (event.type === 'service-log' || event.type === 'verification-log') {
        const data = event.data as { id: string; line: string };
        setLogs((old) => [...old.slice(-500), `[${data.id}] ${data.line}`]);
      } else if (event.type === 'services') {
        setProject((old) =>
          old ? { ...old, serviceStatus: event.data as ProjectView['serviceStatus'] } : old,
        );
      }
    });
  }, [refresh, report]);
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        settings.theme === 'system' ? (query.matches ? 'dark' : 'light') : settings.theme;
      document.documentElement.dataset.density = settings.density;
      document.documentElement.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`);
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [settings]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  async function action<T>(fn: () => Promise<T>): Promise<T> {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      report(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function open(kind: 'open' | 'create' | 'clone', path?: string) {
    if (switching.current) return;
    switching.current = true;
    await action(async () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await save();
      generation.current++;
      const view =
        kind === 'open'
          ? await window.sde.request('project.open', { path })
          : kind === 'create'
            ? await window.sde.request('project.create', { name: newName || 'New project' })
            : await window.sde.request('project.clone', { url: cloneUrl });
      if (view) {
        dirty.current = false;
        accept(view);
        setPhase('design');
        setEvents([]);
        setLogs([]);
        setHistory([]);
        setSelection(undefined);
        setAgentBusy(false);
        setModal(null);
        setSaveState('saved');
        setSettings(await window.sde.request('settings.get'));
      }
    })
      .catch(() => {})
      .finally(() => {
        switching.current = false;
      });
  }
  async function save() {
    const work = async () => {
      if (!draftRef.current || !dirty.current) return;
      const value = draftRef.current;
      const currentSequence = sequence.current;
      setSaveState('saving');
      try {
        const view = await window.sde.request('design.save', {
          design: value,
          expectedRevision: baseRevision.current,
        });
        baseRevision.current = view.design.revision;
        if (currentSequence === sequence.current) {
          dirty.current = false;
          draftRef.current = view.design;
          setDraft(view.design);
          setSaveState('saved');
        } else {
          const current = draftRef.current!;
          draftRef.current = {
            ...current,
            revision: view.design.revision,
            diagrams: current.diagrams.map((d) => ({
              ...d,
              revision: view.design.diagrams.find((a) => a.id === d.id)?.revision ?? d.revision,
            })),
            prototypes: current.prototypes.map((p) => ({
              ...p,
              revision: view.design.prototypes.find((a) => a.id === p.id)?.revision ?? p.revision,
            })),
          };
          setDraft(draftRef.current);
          setSaveState('pending');
        }
        accept(view);
      } catch (e) {
        setSaveState('conflict');
        report(e);
        throw e;
      }
    };
    saveQueue.current = saveQueue.current.catch(() => {}).then(work);
    return saveQueue.current;
  }
  function changeDesign(next: DesignRevision) {
    if (switching.current) return;
    sequence.current++;
    dirty.current = true;
    draftRef.current = next;
    setDraft(next);
    setSaveState('pending');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void save().catch(() => {});
    }, 700);
  }
  async function send(text: string) {
    await save();
    setAgentBusy(true);
    try {
      await window.sde.request('agent.send', { text, phase, artifactId: selection });
    } catch (e) {
      setAgentBusy(false);
      report(e);
      throw e;
    }
  }
  async function saveSettings(value: Partial<Settings>) {
    setSettings(await window.sde.request('settings.save', value));
  }
  function resize(event: React.PointerEvent<HTMLDivElement>) {
    const start = event.clientX;
    const width = settings.chatWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) =>
      setSettings((old) => ({
        ...old,
        chatWidth: Math.max(280, Math.min(800, width + (start - e.clientX) / settings.scale)),
      }));
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      void saveSettings({
        chatWidth: Math.max(280, Math.min(800, width + (start - e.clientX) / settings.scale)),
      }).catch(report);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  const approved = project?.approvals.some((a) => a.designId === project.design.id);
  const trusted = project && settings.trustedProjects.includes(project.root);
  const style = {
    '--ui-scale': settings.scale,
    '--chat-width': `${settings.chatWidth}px`,
    '--outline-width': `${settings.outlineWidth}px`,
    zoom: settings.scale,
  } as CSSProperties;
  return (
    <div className="app" style={style}>
      <header className="app-header">
        <button
          className="brand"
          onClick={() => {
            if (project && !dirty.current && !agentBusy) {
              projectRef.current = undefined;
              setProject(undefined);
            }
          }}
        >
          <div className="brand-symbol">
            <Boxes size={21} />
          </div>
          <span>overhull</span>
          <small>0.1</small>
        </button>
        <div className="header-divider" />
        {project ? (
          <>
            <button className="project-selector" onClick={() => void open('open')}>
              <span>{project.manifest.name}</span>
              <ChevronDown size={13} />
            </button>
            <button className="branch-button" onClick={() => setModal('git')}>
              <GitBranch size={14} />
              {project.git.branch || 'New repository'}
            </button>
            <div className="header-spacer" />
            <button className="changes-button" onClick={() => setModal('git')}>
              <GitPullRequest size={15} />
              {project.git.files.length ? `${project.git.files.length} changes` : 'Up to date'}
              {(project.git.ahead > 0 || project.git.behind > 0) && (
                <span>
                  <ArrowUp size={12} />
                  {project.git.ahead}
                  <ArrowDown size={12} />
                  {project.git.behind}
                </span>
              )}
            </button>
          </>
        ) : (
          <div className="header-spacer" />
        )}
        <button className="icon-button" aria-label="Settings" onClick={() => setModal('settings')}>
          <Settings2 size={18} />
        </button>
        {project && (
          <button
            className="icon-button"
            aria-label="Toggle agent panel"
            onClick={() => setChatVisible(!chatVisible)}
          >
            {chatVisible ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        )}
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {!project ? (
        <main className="welcome">
          <div className="welcome-graphic">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="welcome-mark">
              <Boxes size={43} />
            </div>
            <span className="orbit-label label-design">
              <PenTool size={12} />
              Design
            </span>
            <span className="orbit-label label-build">
              <Code2 size={12} />
              Implement
            </span>
            <span className="orbit-label label-evaluate">
              <MessageSquare size={12} />
              Evaluate
            </span>
          </div>
          <span className="eyebrow">A SHARED SPACE FOR SOFTWARE DEVELOPMENT</span>
          <h1>
            Build a common understanding.
            <br />
            <span>Then build the software.</span>
          </h1>
          <p>
            Bring your team and an AI agent together around
            <br />
            the design, the implementation, and what comes next.
          </p>
          <div className="welcome-actions">
            <button className="primary" onClick={() => void open('open')} disabled={busy}>
              <FolderOpen size={17} />
              Open repository
            </button>
            <button onClick={() => setModal('new')}>
              <Plus size={17} />
              New project
            </button>
            <button onClick={() => setModal('clone')}>
              <GitPullRequest size={17} />
              Clone repository
            </button>
          </div>
          {settings.recentProjects.length > 0 && (
            <div className="recent-projects">
              <h3>Recent projects</h3>
              {settings.recentProjects.map((root) => (
                <button key={root} onClick={() => void open('open', root)}>
                  <FolderOpen size={16} />
                  <div>
                    <strong>{root.split(/[\/]/).pop()}</strong>
                    <small>{root}</small>
                  </div>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          )}
          <footer className="welcome-footer">
            <span>
              <GitBranch size={13} />
              Your repository is the source of truth.
            </span>
            <span>
              <Sparkles size={13} />
              Powered by your local Codex.
            </span>
          </footer>
        </main>
      ) : (
        <>
          <nav className="phase-nav">
            {(
              [
                { id: 'design', label: 'Design', Icon: PenTool },
                { id: 'implement', label: 'Implement', Icon: Code2 },
                { id: 'evaluate', label: 'Evaluate', Icon: MessageSquare },
              ] as const
            ).map(({ id, label, Icon }, i) => (
              <button key={id} className={phase === id ? 'active' : ''} onClick={() => setPhase(id)}>
                <Icon size={16} />
                {label}
                <span className="phase-number">0{i + 1}</span>
              </button>
            ))}
            <div className="header-spacer" />
            <span className="save-status">
              {saveState === 'saving' ? (
                <LoaderCircle size={12} className="spin" />
              ) : saveState === 'saved' ? (
                <Check size={12} />
              ) : (
                <span className="pulse-dot" />
              )}
              {saveState === 'saved'
                ? 'Saved locally'
                : saveState === 'pending'
                  ? 'Unsaved changes'
                  : saveState === 'saving'
                    ? 'Saving…'
                    : 'Resolve save conflict'}
            </span>
          </nav>
          {!trusted && (
            <div className="trust-banner">
              <ShieldCheck size={17} />
              <span>Allow the agent and development commands to run in this repository.</span>
              <button
                className="small"
                onClick={() => void window.sde.request('project.trust').then(setSettings).catch(report)}
              >
                Trust project
              </button>
            </div>
          )}
          {project.warnings.map((warning) => (
            <div className="warning-banner" key={warning}>
              <AlertTriangle size={15} />
              {warning}
            </div>
          ))}
          {saveState === 'conflict' && (
            <div className="warning-banner">
              Your local edit is preserved. Review it before reloading the latest saved revision.
              <button
                className="small"
                onClick={() => {
                  dirty.current = false;
                  setSaveState('saved');
                  void refresh();
                }}
              >
                Discard local edit and reload
              </button>
            </div>
          )}
          <div className="workbench">
            <main className="workspace-main">
              {phase === 'design' && draft && (
                <>
                  <div className="design-context-bar">
                    <span>
                      <GitCommitHorizontal size={15} />
                      {approved ? 'Confirmed design' : 'Draft design'}
                      <span className="muted">· revision {draft.revision}</span>
                    </span>
                    {approved && (
                      <button
                        className="small"
                        onClick={() =>
                          void action(async () => {
                            dirty.current = false;
                            accept(await window.sde.request('design.new', { feedbackIds: [] }));
                          }).catch(() => {})
                        }
                      >
                        Create next design round
                        <Plus size={13} />
                      </button>
                    )}
                  </div>
                  <DesignWorkspace
                    draft={draft}
                    onChange={changeDesign}
                    onApprove={() => {
                      void action(async () => {
                        await save();
                        accept(await window.sde.request('design.approve'));
                      }).catch(() => {});
                    }}
                    busy={busy || agentBusy}
                    readOnly={project.readOnly || approved}
                    onSelection={(selected) =>
                      setSelection(
                        selected.nodeId ? `${selected.artifactId}/${selected.nodeId}` : selected.artifactId,
                      )
                    }
                    history={history}
                    onHistory={() => void window.sde.request('design.history').then(setHistory).catch(report)}
                  />
                </>
              )}
              {phase === 'implement' && (
                <ImplementWorkspace
                  project={project}
                  logs={logs}
                  onStart={() =>
                    action(async () => {
                      await save();
                      setAgentBusy(true);
                      accept(await window.sde.request('run.start'));
                    }).catch(() => {
                      setAgentBusy(false);
                    })
                  }
                  onCancel={() =>
                    action(async () => {
                      accept(await window.sde.request('run.cancel'));
                      setAgentBusy(false);
                    }).catch(() => {})
                  }
                  onVerify={() =>
                    action(async () => {
                      accept(await window.sde.request('run.verify'));
                    }).catch(() => {})
                  }
                  onServices={async (operation) => {
                    await action(async () => {
                      const states = await window.sde.request(`services.${operation}`);
                      setProject({ ...project, serviceStatus: states });
                    }).catch(() => {});
                  }}
                  onOpen={(url) => void window.sde.request('services.open', { url }).catch(report)}
                  onSaveServices={async (services) => {
                    accept(await window.sde.request('services.save', services));
                  }}
                  onEnv={async (values) => {
                    await window.sde.request('services.env', values);
                  }}
                />
              )}
              {phase === 'evaluate' && (
                <EvaluateWorkspace
                  project={project}
                  onSave={async (item) => {
                    try {
                      accept(await window.sde.request('evaluation.save', item));
                    } catch (e) {
                      report(e);
                      throw e;
                    }
                  }}
                  onAttach={async (id) => {
                    accept(await window.sde.request('evaluation.attach', { id }));
                  }}
                  onNewRound={async (ids) => {
                    await action(async () => {
                      dirty.current = false;
                      accept(await window.sde.request('design.new', { feedbackIds: ids }));
                      setPhase('design');
                    }).catch(() => {});
                  }}
                />
              )}
            </main>
            {chatVisible && (
              <>
                <div
                  className="panel-resizer"
                  onPointerDown={resize}
                  role="separator"
                  aria-label="Resize agent panel"
                  aria-orientation="vertical"
                />
                <ChatPanel
                  messages={project.messages}
                  events={events}
                  phase={phase}
                  busy={agentBusy}
                  selected={selection}
                  onSend={send}
                  onCancel={() =>
                    void window.sde
                      .request('agent.cancel')
                      .then(() => setAgentBusy(false))
                      .catch(report)
                  }
                  onRespond={(id, response) => window.sde.request('agent.respond', { id, response })}
                />
              </>
            )}
          </div>
          <footer className="statusbar">
            <span className="status-dot ready" />
            Local workspace<span className="statusbar-path">{project.root}</span>
            <span>Git-backed workspace · {project.git.head.slice(0, 7) || 'no commits'}</span>
          </footer>
        </>
      )}
      {modal === 'settings' && (
        <SettingsDialog
          settings={settings}
          onSave={saveSettings}
          onClose={() => setModal(null)}
          onDiagnose={() => window.sde.request('agent.diagnostics')}
        />
      )}{' '}
      {modal === 'git' && project && (
        <GitDialog project={project} onClose={() => setModal(null)} onRefresh={accept} onError={report} />
      )}{' '}
      {(modal === 'new' || modal === 'clone') && (
        <Modal
          title={modal === 'new' ? 'Create a project' : 'Clone a repository'}
          description="Choose a local folder. All implementation work runs on this machine."
          onClose={() => setModal(null)}
        >
          <div className="modal-body">
            <label className="field">
              {modal === 'new' ? 'Project name' : 'Git repository URL'}
              <input
                autoFocus
                value={modal === 'new' ? newName : cloneUrl}
                placeholder={modal === 'new' ? 'My next project' : 'https://github.com/team/project.git'}
                onChange={(e) => (modal === 'new' ? setNewName(e.target.value) : setCloneUrl(e.target.value))}
              />
            </label>
          </div>
          <footer className="modal-actions">
            <button
              className="primary"
              disabled={busy || (modal === 'new' ? !newName.trim() : !cloneUrl.trim())}
              onClick={() => void open(modal === 'new' ? 'create' : 'clone')}
            >
              {busy ? 'Working…' : 'Choose folder and continue'}
              <ArrowRight size={15} />
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
