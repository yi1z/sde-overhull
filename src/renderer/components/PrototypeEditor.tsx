import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Puck, Render, type Config, type Data, type Slot } from '@puckeditor/core';
import { Braces, Eye, MousePointer2, Monitor, Tablet, Smartphone, AlertCircle } from 'lucide-react';
import { type Prototype } from '../../shared/types';
import { validatePrototype } from '../../shared/prototypes';
export { validatePrototype } from '../../shared/prototypes';
import '@puckeditor/core/puck.css';

type Palette = {
  Container: { content: Slot; padding: number; background: string; maxWidth: number };
  Grid: { content: Slot; columns: number; gap: number };
  Heading: { text: string; level: 'h1' | 'h2' | 'h3'; align: 'left' | 'center' | 'right' };
  Text: { text: string; muted: boolean };
  Button: { label: string; variant: 'primary' | 'secondary'; targetScreen: string };
  Input: { label: string; placeholder: string; type: 'text' | 'email' | 'password' | 'number' };
  Select: { label: string; options: string };
  Card: { title: string; description: string; content: Slot };
  Table: { columns: string; rows: string };
  Navigation: { brand: string; links: { label: string; targetScreen: string }[] };
  Dialog: { title: string; description: string; content: Slot };
  Tabs: { labels: string; content: Slot };
  Status: { text: string; tone: 'neutral' | 'success' | 'warning' | 'danger' };
};
type RootProps = { title: string; background: string };
type Props = {
  prototype: Prototype;
  onChange: (prototype: Prototype) => void;
  onSelection?: (selection: { artifactId?: string; nodeId?: string }) => void;
  screens?: { id: string; title: string }[];
  onNavigate?: (id: string) => void;
  readOnly?: boolean;
};

const baseInput: CSSProperties = { width: '100%', border: '1px solid #d0d7de', borderRadius: 6, background: '#fff', color: '#172033', padding: '10px 12px', font: 'inherit', boxSizing: 'border-box' };
const splitLines = (value: string | undefined) => (value ?? '').split('\n').filter(Boolean);

export function createPrototypeConfig(screens: { id: string; title: string }[] = [], onNavigate?: (id: string) => void): Config<Palette, RootProps> {
  const screenOptions = [{ label: 'No destination', value: '' }, ...screens.map(screen => ({ label: screen.title, value: screen.id }))];
  return {
    categories: {
      layout: { title: 'Layout', components: ['Container', 'Grid', 'Card', 'Dialog', 'Tabs'] },
      content: { title: 'Content', components: ['Heading', 'Text', 'Table', 'Status'] },
      interactive: { title: 'Navigation & forms', components: ['Navigation', 'Button', 'Input', 'Select'] },
    },
    root: {
      fields: { title: { type: 'text', label: 'Page title' }, background: { type: 'text', label: 'Background color' } },
      defaultProps: { title: 'Untitled screen', background: '#ffffff' },
      render: ({ children, background }) => <div style={{ background: background || '#fff', minHeight: 480, color: '#172033', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: 14, lineHeight: 1.5 }}>{children}</div>,
    },
    components: {
      Container: {
        label: 'Container', fields: { content: { type: 'slot' }, padding: { type: 'number', min: 0, max: 120 }, background: { type: 'text', label: 'Background color' }, maxWidth: { type: 'number', label: 'Max width', min: 240, max: 1920 } },
        defaultProps: { content: [], padding: 24, background: '#ffffff', maxWidth: 1200 },
        render: ({ content: Content, padding, background, maxWidth }) => <section style={{ padding, background, maxWidth, margin: '0 auto', boxSizing: 'border-box' }}><Content style={{ minHeight: 70 }} /></section>,
      },
      Grid: {
        label: 'Grid layout', fields: { content: { type: 'slot' }, columns: { type: 'number', min: 1, max: 6 }, gap: { type: 'number', min: 0, max: 80 } },
        defaultProps: { content: [], columns: 2, gap: 16 },
        render: ({ content: Content, columns, gap }) => <Content style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, Math.min(6, columns ?? 2))}, minmax(0, 1fr))`, gap, minHeight: 90 }} />,
      },
      Heading: {
        label: 'Heading', fields: { text: { type: 'text' }, level: { type: 'select', options: [{ label: 'Heading 1', value: 'h1' }, { label: 'Heading 2', value: 'h2' }, { label: 'Heading 3', value: 'h3' }] }, align: { type: 'radio', options: [{ label: 'Left', value: 'left' }, { label: 'Center', value: 'center' }, { label: 'Right', value: 'right' }] } },
        defaultProps: { text: 'A clear, useful heading', level: 'h1', align: 'left' },
        render: ({ text, level, align }) => { const Tag = ['h1', 'h2', 'h3'].includes(level) ? level : 'h1'; return <Tag style={{ margin: '0 0 16px', fontSize: level === 'h1' ? 32 : level === 'h2' ? 24 : 18, lineHeight: 1.2, letterSpacing: '-.02em', textAlign: align }}>{text}</Tag>; },
      },
      Text: {
        label: 'Text', fields: { text: { type: 'textarea' }, muted: { type: 'radio', options: [{ label: 'Default', value: false }, { label: 'Muted', value: true }] } },
        defaultProps: { text: 'Explain what matters to your users in a few clear sentences.', muted: false },
        render: ({ text, muted }) => <p style={{ margin: '0 0 16px', color: muted ? '#637083' : '#172033', whiteSpace: 'pre-wrap' }}>{text}</p>,
      },
      Button: {
        label: 'Button', fields: { label: { type: 'text' }, variant: { type: 'radio', options: [{ label: 'Primary', value: 'primary' }, { label: 'Secondary', value: 'secondary' }] }, targetScreen: { type: 'select', label: 'Destination screen', options: screenOptions } },
        defaultProps: { label: 'Continue', variant: 'primary', targetScreen: '' },
        render: ({ label, variant, targetScreen, puck }) => <button type="button" onClick={() => { if (!puck.isEditing && targetScreen) onNavigate?.(targetScreen); }} style={{ padding: '10px 18px', borderRadius: 6, border: `1px solid ${variant === 'primary' ? '#2563eb' : '#d0d7de'}`, background: variant === 'primary' ? '#2563eb' : '#fff', color: variant === 'primary' ? '#fff' : '#172033', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>{label}</button>,
      },
      Input: {
        label: 'Text input', fields: { label: { type: 'text' }, placeholder: { type: 'text' }, type: { type: 'select', options: ['text', 'email', 'password', 'number'].map(value => ({ label: value, value })) } },
        defaultProps: { label: 'Your name', placeholder: 'Enter a value', type: 'text' },
        render: ({ label, placeholder, type }) => <label style={{ display: 'grid', gap: 7, marginBottom: 16, fontWeight: 500 }}>{label}<input aria-label={label} placeholder={placeholder} type={['text', 'email', 'password', 'number'].includes(type) ? type : 'text'} style={baseInput} /></label>,
      },
      Select: {
        label: 'Select', fields: { label: { type: 'text' }, options: { type: 'textarea', label: 'Options (one per line)' } },
        defaultProps: { label: 'Choose an option', options: 'Option one\nOption two\nOption three' },
        render: ({ label, options }) => <label style={{ display: 'grid', gap: 7, marginBottom: 16, fontWeight: 500 }}>{label}<select aria-label={label} style={baseInput}>{splitLines(options).map((option, index) => <option key={index}>{option}</option>)}</select></label>,
      },
      Card: {
        label: 'Card', fields: { title: { type: 'text' }, description: { type: 'textarea' }, content: { type: 'slot' } },
        defaultProps: { title: 'A useful feature', description: 'A short description of this item.', content: [] },
        render: ({ title, description, content: Content }) => <article style={{ border: '1px solid #d8dee8', borderRadius: 10, padding: 24, background: '#fff', height: '100%', boxSizing: 'border-box' }}><h3 style={{ margin: '0 0 8px', fontSize: 18 }}>{title}</h3>{description && <p style={{ margin: '0 0 16px', color: '#637083' }}>{description}</p>}<Content style={{ minHeight: 30 }} /></article>,
      },
      Table: {
        label: 'Data table', fields: { columns: { type: 'text', label: 'Columns (comma-separated)' }, rows: { type: 'textarea', label: 'Rows (one per line, comma-separated cells)' } },
        defaultProps: { columns: 'Name, Status, Updated', rows: 'Project Alpha, Active, Today\nProject Beta, Draft, Yesterday\nProject Gamma, Complete, Last week' },
        render: ({ columns, rows }) => <div style={{ overflowX: 'auto', border: '1px solid #d8dee8', borderRadius: 8 }}><table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}><thead><tr>{(columns ?? '').split(',').map((column, index) => <th key={index} style={{ padding: '12px 16px', background: '#f6f8fa', borderBottom: '1px solid #d8dee8', fontSize: 12, fontWeight: 600 }}>{column.trim()}</th>)}</tr></thead><tbody>{splitLines(rows).map((row, index) => <tr key={index}>{row.split(',').map((cell, cellIndex) => <td key={cellIndex} style={{ padding: '12px 16px', borderBottom: '1px solid #eaeef2', fontSize: 13 }}>{cell.trim()}</td>)}</tr>)}</tbody></table></div>,
      },
      Navigation: {
        label: 'Navigation bar', fields: { brand: { type: 'text' }, links: { type: 'array', arrayFields: { label: { type: 'text' }, targetScreen: { type: 'select', options: screenOptions } }, defaultItemProps: { label: 'Link', targetScreen: '' }, getItemSummary: item => item.label } },
        defaultProps: { brand: 'Your product', links: [{ label: 'Overview', targetScreen: '' }, { label: 'Projects', targetScreen: '' }] },
        render: ({ brand, links, puck }) => <nav style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap', padding: '16px 24px', borderBottom: '1px solid #d8dee8', background: '#fff' }}><strong style={{ fontSize: 17, marginRight: 'auto' }}>{brand}</strong>{(links ?? []).map((link, index) => <button type="button" key={index} onClick={() => { if (!puck.isEditing && link.targetScreen) onNavigate?.(link.targetScreen); }} style={{ font: 'inherit', fontSize: 13, border: 0, padding: 0, color: '#45546a', background: 'transparent', cursor: 'pointer' }}>{link.label}</button>)}</nav>,
      },
      Dialog: {
        label: 'Dialog', fields: { title: { type: 'text' }, description: { type: 'textarea' }, content: { type: 'slot' } },
        defaultProps: { title: 'Confirm your changes', description: 'Review the details before continuing.', content: [] },
        render: ({ title, description, content: Content }) => <div style={{ padding: 32, background: '#17203322', borderRadius: 8 }}><section role="dialog" aria-label={title} style={{ margin: '0 auto', maxWidth: 440, border: '1px solid #d8dee8', borderRadius: 12, padding: 24, background: '#fff', boxShadow: '0 16px 40px #17203320' }}><h3 style={{ margin: '0 0 10px', fontSize: 20 }}>{title}</h3><p style={{ color: '#637083', margin: '0 0 20px' }}>{description}</p><Content style={{ minHeight: 50 }} /></section></div>,
      },
      Tabs: {
        label: 'Tab section', fields: { labels: { type: 'text', label: 'Tab names (comma-separated)' }, content: { type: 'slot' } },
        defaultProps: { labels: 'Overview, Activity, Settings', content: [] },
        render: ({ labels, content: Content }) => <section><div style={{ display: 'flex', gap: 20, borderBottom: '1px solid #d8dee8', marginBottom: 20 }}>{(labels ?? '').split(',').map((label, index) => <span key={index} style={{ fontSize: 13, padding: '10px 2px', borderBottom: index === 0 ? '2px solid #2563eb' : '2px solid transparent', color: index === 0 ? '#2563eb' : '#637083' }}>{label.trim()}</span>)}</div><Content style={{ minHeight: 80 }} /></section>,
      },
      Status: {
        label: 'Status badge', fields: { text: { type: 'text' }, tone: { type: 'select', options: ['neutral', 'success', 'warning', 'danger'].map(value => ({ label: value, value })) } },
        defaultProps: { text: 'In progress', tone: 'neutral' },
        render: ({ text, tone }) => { const color = ({ neutral: '#45546a', success: '#15803d', warning: '#a16207', danger: '#b91c1c' })[tone] ?? '#45546a'; return <span style={{ display: 'inline-flex', padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: `${color}12`, color, border: `1px solid ${color}30` }}>{text}</span>; },
      },
    },
  };
}

export function PrototypeEditor({ prototype, onChange, onSelection, screens = [], onNavigate, readOnly = false }: Props) {
  const [mode, setMode] = useState<'visual' | 'source' | 'preview'>(readOnly ? 'preview' : 'visual');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [viewport, setViewport] = useState(1100);
  const current = useRef(prototype);
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const screenKey = JSON.stringify(screens);
  const config = useMemo(() => createPrototypeConfig(JSON.parse(screenKey) as Props['screens'], value => navigateRef.current?.(value)), [screenKey]);
  const serializedData = JSON.stringify(prototype.data);
  useEffect(() => {
    if (JSON.stringify(current.current.data) !== serializedData || current.current.id !== prototype.id) setEpoch(value => value + 1);
    current.current = prototype;
  }, [prototype, serializedData]);
  const valid = useMemo(() => { try { validatePrototype(prototype); return ''; } catch (err) { return err instanceof Error ? err.message : String(err); } }, [prototype]);
  const save = (data: Data) => {
    if (readOnly || JSON.stringify(data) === JSON.stringify(current.current.data)) return;
    try {
      const next = validatePrototype({ ...current.current, data });
      current.current = next; setError(''); onChange(next);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const data = prototype.data as unknown as Data<Palette, RootProps>;
  return <div className="prototype-editor" onFocus={() => onSelection?.({ artifactId: prototype.id })}>
    <div className="editor-toolbar">
      <button className={`editor-button ${mode === 'visual' ? 'active' : ''}`} onClick={() => setMode('visual')} disabled={readOnly}><MousePointer2 size={14} /> Visual editor</button>
      <button className={`editor-button ${mode === 'preview' ? 'active' : ''}`} onClick={() => setMode('preview')}><Eye size={14} /> Preview</button>
      <button className={`editor-button ${mode === 'source' ? 'active' : ''}`} onClick={() => { setSource(JSON.stringify(current.current, null, 2)); setMode('source'); setError(''); }}><Braces size={14} /> JSON</button>
      <span className="editor-spacer" />
      {mode === 'preview' && <div className="prototype-screens">{[{ width: 360, label: 'Mobile', Icon: Smartphone }, { width: 768, label: 'Tablet', Icon: Tablet }, { width: 1100, label: 'Desktop', Icon: Monitor }].map(({ width, label, Icon }) => <button key={width} className={`editor-button editor-icon-button ${viewport === width ? 'active' : ''}`} aria-label={`${label} preview`} onClick={() => setViewport(width)}><Icon size={15} /></button>)}</div>}
      <span className="editor-help">{prototype.title}</span>
    </div>
    {(error || valid) && <div className="editor-error" role="alert"><AlertCircle size={13} /> {error || valid}</div>}
    {mode === 'source' ? <div className="editor-source-panel">
      <p className="editor-help">This is the editable source for the visual prototype. Use registered palette components and stable component IDs. Changes are validated before they replace the current screen.</p>
      <textarea aria-label="Prototype JSON source" className="editor-textarea editor-code" value={source} onChange={event => setSource(event.target.value)} readOnly={readOnly} spellCheck={false} />
      <div><button className="editor-button primary" disabled={readOnly} onClick={() => { try { const next = validatePrototype(JSON.parse(source)); if (next.id !== prototype.id) throw new Error('The artifact ID cannot be changed.'); current.current = { ...next, revision: prototype.revision }; onChange(current.current); setEpoch(value => value + 1); setMode('visual'); setError(''); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }}>Apply valid JSON</button></div>
    </div> : valid ? <div className="editor-source-panel"><p className="editor-help">Open JSON to correct this prototype. The saved artifact has been preserved.</p></div> : mode === 'preview' ? <div className="prototype-preview"><div className="prototype-preview-page" style={{ maxWidth: viewport }}><Render config={config} data={data} /></div></div> : <div className="prototype-puck">
      <Puck key={`${prototype.id}-${epoch}`} config={config} data={data} onChange={value => save(value as Data)} onPublish={value => save(value as Data)} headerTitle={prototype.title} headerPath="Prototype" height="100%"
        permissions={readOnly ? { drag: false, edit: false, insert: false, delete: false, duplicate: false } : undefined}
        dictionary={{ 'header-publish': 'Save prototype' }} viewports={[{ width: 360, height: 'auto', label: 'Mobile' }, { width: 768, height: 'auto', label: 'Tablet' }, { width: 1280, height: 'auto', label: 'Desktop' }]} />
    </div>}
  </div>;
}
