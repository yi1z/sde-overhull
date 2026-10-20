import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Render, type Data } from '@puckeditor/core';
import { validatePrototype, prototypePaletteGuide, prototypeDataExample } from '../src/shared/prototypes';
import { createPrototypeConfig } from '../src/renderer/components/PrototypeEditor';
import { validateDiagram } from '../src/renderer/components/DiagramEditor';
import type { Prototype, Diagram } from '../src/shared/types';

const makePrototype = (data: Prototype['data']): Prototype => ({ id: 'screen-test', title: 'Test screen', revision: 0, requirementIds: [], data });
const node = (id: string, parentId?: string): Diagram['nodes'][number] => ({ id, type: 'group', position: { x: 0, y: 0 }, parentId, data: { label: id, description: '', fields: [], requirementIds: [] } });
const diagram = (nodes: Diagram['nodes'], edges: Diagram['edges'] = []): Diagram => ({ id: 'diagram-test', title: 'Test diagram', kind: 'workflow', revision: 0, nodes, edges });

describe('trusted prototype palette', () => {
  it('renders every shipped component with the documented agent defaults', () => {
    const data = validatePrototype(makePrototype({ root: { props: { title: 'Prototype' } }, content: Object.entries(prototypePaletteGuide).map(([type, guide]) => ({ type, props: { ...guide.defaults, id: `component-${type}` } })) })).data;
    const html = renderToStaticMarkup(<Render config={createPrototypeConfig()} data={data as Data} />);
    expect(html).toContain('A clear, useful heading');
    expect(html).toContain('Your product');
    expect(html).toContain('Project Alpha');
    expect(html).toContain('Confirm your changes');
  });

  it('round-trips a nested prototype without changing stable identifiers', () => {
    const prototype = validatePrototype(makePrototype(prototypeDataExample));
    expect(validatePrototype(JSON.parse(JSON.stringify(prototype)))).toEqual(prototype);
    const html = renderToStaticMarkup(<Render config={createPrototypeConfig()} data={prototype.data as Data} />);
    expect(html).toContain('Welcome');
    expect(html).toContain('Get started');
  });

  it('rejects unregistered code components and malformed nested component IDs', () => {
    expect(() => validatePrototype(makePrototype({ root: {}, content: [{ type: 'JavaScript', props: { id: 'untrusted', code: 'process.exit()' } }] }))).toThrow('Unknown component');
    expect(() => validatePrototype(makePrototype({ root: {}, content: [{ type: 'Container', props: { id: 'duplicate', content: [{ type: 'Text', props: { id: 'duplicate', text: 'Nested' } }] } }] }))).toThrow('Duplicate component ID');
  });

  it('rejects data that would break trusted render functions', () => {
    expect(() => validatePrototype(makePrototype({ root: {}, content: [{ type: 'Navigation', props: { id: 'nav', links: 'invalid' } }] }))).toThrow();
    expect(() => validatePrototype(makePrototype({ root: {}, content: [{ type: 'Table', props: { id: 'table', columns: ['Name'] } }] }))).toThrow();
    expect(() => validatePrototype(makePrototype({ root: {}, content: [{ type: 'Container', props: { id: 'container', content: 'not a slot' } }] }))).toThrow();
  });

  it('discards unsupported props rather than passing them into renderers', () => {
    const prototype = validatePrototype(makePrototype({ root: {}, content: [{ type: 'Heading', props: { id: 'heading', text: '<script>alert(1)</script>', dangerouslySetInnerHTML: { __html: '<script>' } } }] }));
    expect(prototype.data.content[0].props).not.toHaveProperty('dangerouslySetInnerHTML');
    const html = renderToStaticMarkup(<Render config={createPrototypeConfig()} data={prototype.data as Data} />);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('editable diagram integrity', () => {
  it('accepts nested groups and cross-group edges', () => {
    const value = diagram([node('parent'), node('child', 'parent'), node('outside')], [{ id: 'edge', source: 'child', target: 'outside', kind: 'dependency', label: 'calls' }]);
    expect(validateDiagram(value)).toEqual(value);
  });

  it('rejects orphaned edges, duplicate nodes, and cyclic groups', () => {
    expect(() => validateDiagram(diagram([node('a')], [{ id: 'edge', source: 'a', target: 'missing', kind: 'control', label: '' }]))).toThrow('existing source and target');
    expect(() => validateDiagram(diagram([node('a'), node('a')]))).toThrow('unique ID');
    expect(() => validateDiagram(diagram([node('a', 'b'), node('b', 'a')]))).toThrow('cycle');
  });
});
