import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Sparkles, ChevronDown, Check, Terminal, UserRound } from 'lucide-react';
import type { AgentEvent, Message, Phase } from '../../shared/types';
import { buildAgentResponse, type AgentResponseAction } from '../../shared/agent-responses';
type Props = {
  messages: Message[];
  events: AgentEvent[];
  phase: Phase;
  busy: boolean;
  selected?: string;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  onRespond: (id: string | number, response: unknown) => Promise<void>;
};
export function ChatPanel({ messages, events, phase, busy, selected, onSend, onCancel, onRespond }: Props) {
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [form, setForm] = useState('{}');
  const [requestError, setRequestError] = useState('');
  const [responding, setResponding] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, events.length]);
  const lastComplete = events.findLastIndex(
    (e) => e.type === 'message-complete' || e.type === 'turn-complete',
  );
  const streaming = events
    .slice(lastComplete + 1)
    .filter((e) => e.type === 'message-delta')
    .map((e) => e.text ?? '')
    .join('');
  const lastTurn = events.findLastIndex((e) => e.type === 'turn-complete');
  const prompts = events.slice(lastTurn + 1).filter((e) => e.type === 'question' || e.type === 'approval');
  const [resolved, setResolved] = useState<Set<AgentEvent>>(new Set());
  const respond = async (prompt: AgentEvent, action: AgentResponseAction) => {
    setRequestError('');
    setResponding(true);
    try {
      const input =
        prompt.method === 'item/tool/requestUserInput'
          ? answers
          : prompt.method === 'mcpServer/elicitation/request' &&
              action === 'accept' &&
              (prompt.data as any)?.mode !== 'url'
            ? JSON.parse(form)
            : undefined;
      const response = buildAgentResponse(prompt, action, input);
      await onRespond(prompt.id!, response);
      setResolved((previous) => new Set([...previous, prompt]));
      setAnswers({});
      setForm('{}');
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setResponding(false);
    }
  };
  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    try {
      await onSend(value);
    } catch {
      setText(value);
    }
  }
  return (
    <aside className="chat-panel">
      <header className="panel-heading">
        <span>
          <Sparkles size={16} /> Agent
        </span>
        <span className={`connection-dot ${busy ? 'working' : ''}`}>{busy ? 'Working' : 'Ready'}</span>
      </header>
      <div className="chat-context">
        <span className="eyebrow">CURRENT CONTEXT</span>
        <div>
          {phase === 'design'
            ? 'Shape the next iteration'
            : phase === 'implement'
              ? 'Bring the design to life'
              : 'Review what was built'}
        </div>
        {selected && <small>Focused on {selected}</small>}
      </div>
      <div className="chat-messages">
        {!messages.length && !streaming && (
          <div className="chat-empty">
            <div className="agent-orb">
              <Sparkles size={23} />
            </div>
            <h3>
              Every good build starts
              <br />
              with a conversation.
            </h3>
            <p>
              Describe what you want to make. Together we’ll turn it into a design your team can build on.
            </p>
            <button
              className="suggestion"
              onClick={() =>
                setText('Help me design a new web application. Ask me the most important questions first.')
              }
            >
              Explore a new idea <ArrowUp size={13} />
            </button>
            <button
              className="suggestion"
              onClick={() => setText('Inspect this repository and help me plan its next iteration.')}
            >
              Plan the next iteration <ArrowUp size={13} />
            </button>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`chat-message ${message.role}`}>
            <div className="message-author">
              {message.role === 'assistant' ? <Sparkles size={13} /> : <UserRound size={13} />}
              <strong>
                {message.role === 'assistant' ? 'Codex' : message.role === 'user' ? 'Developer' : 'Workspace'}
              </strong>
              <time>
                {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </div>
            <div className="message-body">{message.text}</div>
          </article>
        ))}
        {streaming && (
          <article className="chat-message assistant">
            <div className="message-author">
              <Sparkles size={13} />
              <strong>Codex</strong>
              <span className="pulse-dot" />
            </div>
            <div className="message-body">{streaming}</div>
          </article>
        )}
        {events.filter((e) => e.type === 'activity').length > 0 && (
          <details className="agent-activity">
            <summary>
              <Terminal size={13} /> Agent activity <ChevronDown size={13} />
            </summary>
            {events
              .filter((e) => e.type === 'activity')
              .slice(-30)
              .map((event, index) => (
                <pre key={index}>{event.text || JSON.stringify(event.data, null, 2)}</pre>
              ))}
          </details>
        )}
        {prompts
          .filter((p) => p.id !== undefined && !resolved.has(p))
          .map((prompt) => {
            const data = prompt.data as any;
            const questions = data?.questions ?? [];
            return (
              <div className="agent-request" key={prompt.id}>
                <strong>{prompt.type === 'approval' ? 'Approval needed' : 'Your input'}</strong>
                <p>
                  {data?.reason ||
                    data?.message ||
                    prompt.text ||
                    data?.command ||
                    'The agent needs your input to continue.'}
                </p>
                {prompt.type === 'approval' ? (
                  <>
                    <pre>
                      {data?.command || JSON.stringify(data?.changes ?? data?.permissions ?? {}, null, 2)}
                    </pre>
                    <div className="button-row">
                      <button
                        className="primary small"
                        disabled={responding}
                        onClick={() => void respond(prompt, 'accept')}
                      >
                        <Check size={14} />
                        {prompt.method === 'item/permissions/requestApproval'
                          ? 'Allow for this turn'
                          : 'Allow once'}
                      </button>
                      <button
                        className="small"
                        disabled={responding}
                        onClick={() => void respond(prompt, 'decline')}
                      >
                        Decline
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      {questions.map((q: any) => (
                        <label className="field" key={q.id}>
                          {q.question ?? q.header}
                          <input
                            type={q.isSecret ? 'password' : 'text'}
                            value={answers[q.id] ?? ''}
                            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                            list={`options-${q.id}`}
                          />
                          <datalist id={`options-${q.id}`}>
                            {q.options?.map((o: any) => (
                              <option key={o.label} value={o.label}>
                                {o.description}
                              </option>
                            ))}
                          </datalist>
                        </label>
                      ))}
                    </div>
                    {prompt.method === 'mcpServer/elicitation/request' &&
                      (data?.mode === 'url' ? (
                        <p>
                          Complete the requested action in your browser, then confirm: <code>{data.url}</code>
                        </p>
                      ) : (
                        <label className="field">
                          Form response (JSON)
                          <pre>{JSON.stringify(data?.requestedSchema, null, 2)}</pre>
                          <textarea
                            aria-label="Agent form response"
                            value={form}
                            onChange={(e) => setForm(e.target.value)}
                          />
                          <small>Form contents remain local to this agent session.</small>
                        </label>
                      ))}
                    <div className="button-row">
                      <button
                        className="primary small"
                        disabled={responding}
                        onClick={() => void respond(prompt, 'accept')}
                      >
                        {data?.mode === 'url' ? 'Confirm completed' : 'Send answers'}
                      </button>
                      {prompt.method === 'mcpServer/elicitation/request' && (
                        <button
                          className="small"
                          disabled={responding}
                          onClick={() => void respond(prompt, 'decline')}
                        >
                          Decline
                        </button>
                      )}
                    </div>
                  </>
                )}
                {requestError && (
                  <p role="alert" className="error-inline">
                    {requestError}
                  </p>
                )}
              </div>
            );
          })}
        <div ref={end} />
      </div>
      <div className="chat-composer">
        <textarea
          aria-label="Message the agent"
          value={text}
          placeholder={phase === 'design' ? 'Describe an idea or refine the design…' : 'Ask the agent…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <footer>
          <span>Codex · {phase}</span>
          {busy ? (
            <button aria-label="Stop agent" className="icon-button" onClick={onCancel}>
              <Square size={15} />
            </button>
          ) : (
            <button
              aria-label="Send message"
              className="primary send-button"
              disabled={!text.trim()}
              onClick={() => void submit()}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </footer>
      </div>
      <div className="chat-footnote">Shared with your team when you commit and push.</div>
    </aside>
  );
}
