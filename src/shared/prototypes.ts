import { z } from 'zod';
import { PrototypeSchema, type Prototype } from './types';

/** This registry is shared by the UI, persistence validator and agent schema guide. */
export const prototypePaletteGuide = {
  Container: { description: 'Padded container with nested blocks', defaults: { content: [], padding: 24, background: '#ffffff', maxWidth: 1200 }, slots: ['content'] },
  Grid: { description: 'Grid of nested blocks; columns is 1–6', defaults: { content: [], columns: 2, gap: 16 }, slots: ['content'] },
  Heading: { description: 'Heading; level h1/h2/h3 and align left/center/right', defaults: { text: 'A clear, useful heading', level: 'h1', align: 'left' } },
  Text: { description: 'Paragraph with optional muted color', defaults: { text: 'Explain what matters to your users in a few clear sentences.', muted: false } },
  Button: { description: 'Button; variant primary/secondary, targetScreen is a prototype ID or empty string', defaults: { label: 'Continue', variant: 'primary', targetScreen: '' } },
  Input: { description: 'Input; type text/email/password/number', defaults: { label: 'Your name', placeholder: 'Enter a value', type: 'text' } },
  Select: { description: 'Select with newline-separated options', defaults: { label: 'Choose an option', options: 'Option one\nOption two\nOption three' } },
  Card: { description: 'Card with title, description and nested blocks', defaults: { title: 'A useful feature', description: 'A short description of this item.', content: [] }, slots: ['content'] },
  Table: { description: 'Columns are comma-separated; rows are newline-separated with comma-separated cells', defaults: { columns: 'Name, Status, Updated', rows: 'Project Alpha, Active, Today\nProject Beta, Draft, Yesterday\nProject Gamma, Complete, Last week' } },
  Navigation: { description: 'Navigation bar; links have label and targetScreen strings', defaults: { brand: 'Your product', links: [{ label: 'Overview', targetScreen: '' }, { label: 'Projects', targetScreen: '' }] } },
  Dialog: { description: 'Visible dialog mockup with nested blocks', defaults: { title: 'Confirm your changes', description: 'Review the details before continuing.', content: [] }, slots: ['content'] },
  Tabs: { description: 'Tab section with comma-separated labels and nested blocks', defaults: { labels: 'Overview, Activity, Settings', content: [] }, slots: ['content'] },
  Status: { description: 'Status badge; tone neutral/success/warning/danger', defaults: { text: 'In progress', tone: 'neutral' } },
} as const;

export const prototypeComponentNames = Object.keys(prototypePaletteGuide) as (keyof typeof prototypePaletteGuide)[];
const text = z.string();
const components: Record<keyof typeof prototypePaletteGuide, z.ZodTypeAny> = {
  Container: z.object({ content: z.array(z.unknown()).default([]), padding: z.number().min(0).max(120).default(24), background: text.default('#ffffff'), maxWidth: z.number().min(240).max(1920).default(1200) }),
  Grid: z.object({ content: z.array(z.unknown()).default([]), columns: z.number().int().min(1).max(6).default(2), gap: z.number().min(0).max(80).default(16) }),
  Heading: z.object({ text: text.default('Heading'), level: z.enum(['h1', 'h2', 'h3']).default('h1'), align: z.enum(['left', 'center', 'right']).default('left') }),
  Text: z.object({ text: text.default(''), muted: z.boolean().default(false) }),
  Button: z.object({ label: text.default('Continue'), variant: z.enum(['primary', 'secondary']).default('primary'), targetScreen: text.default('') }),
  Input: z.object({ label: text.default('Input'), placeholder: text.default(''), type: z.enum(['text', 'email', 'password', 'number']).default('text') }),
  Select: z.object({ label: text.default('Choose an option'), options: text.default('') }),
  Card: z.object({ title: text.default('Card'), description: text.default(''), content: z.array(z.unknown()).default([]) }),
  Table: z.object({ columns: text.default('Name, Status'), rows: text.default('') }),
  Navigation: z.object({ brand: text.default('Your product'), links: z.array(z.object({ label: text, targetScreen: text.default('') })).default([]) }),
  Dialog: z.object({ title: text.default('Dialog'), description: text.default(''), content: z.array(z.unknown()).default([]) }),
  Tabs: z.object({ labels: text.default('Overview, Activity'), content: z.array(z.unknown()).default([]) }),
  Status: z.object({ text: text.default('Status'), tone: z.enum(['neutral', 'success', 'warning', 'danger']).default('neutral') }),
};

/** Validate data before Puck sees it. Registered React renderers are the only executable content. */
export function validatePrototype(input: unknown): Prototype {
  const prototype = PrototypeSchema.parse(input);
  const ids = new Set<string>();
  let count = 0;
  const validateBlocks = (blocks: unknown[], depth = 0): Record<string, unknown>[] => {
    if (depth > 30) throw new Error('Prototype nesting exceeds 30 levels.');
    return blocks.map(inputBlock => {
      if (++count > 5000) throw new Error('A prototype can contain at most 5,000 components.');
      const block = z.object({ type: text, props: z.record(z.unknown()) }).parse(inputBlock);
      if (!Object.hasOwn(components, block.type)) throw new Error(`Unknown component “${block.type}”. Use a component from the palette.`);
      const type = block.type as keyof typeof prototypePaletteGuide;
      const id = z.string().min(1).max(200).parse(block.props.id);
      if (ids.has(id)) throw new Error(`Duplicate component ID: ${id}`);
      ids.add(id);
      const props: Record<string, unknown> = { ...components[type].parse(block.props), id };
      const guide = prototypePaletteGuide[type];
      if ('slots' in guide) for (const name of guide.slots) props[name] = validateBlocks(props[name] as unknown[], depth + 1);
      return { type, props };
    });
  };
  prototype.data.content = validateBlocks(prototype.data.content);
  if (prototype.data.zones) prototype.data.zones = Object.fromEntries(Object.entries(prototype.data.zones).map(([key, blocks]) => [key, validateBlocks(blocks)]));
  const root = z.object({ props: z.object({ title: text.optional(), background: text.optional(), id: text.optional() }).optional() }).parse(prototype.data.root);
  prototype.data.root = root;
  return prototype;
}

export const prototypeDataExample = {
  root: { props: { title: 'Home', background: '#ffffff' } },
  content: [
    { type: 'Navigation', props: { id: 'nav-home', brand: 'Product', links: [{ label: 'Home', targetScreen: '' }] } },
    { type: 'Container', props: { id: 'container-home', padding: 24, maxWidth: 1200, background: '#ffffff', content: [
      { type: 'Heading', props: { id: 'heading-home', text: 'Welcome', level: 'h1', align: 'left' } },
      { type: 'Button', props: { id: 'button-home', label: 'Get started', variant: 'primary', targetScreen: '' } },
    ] } },
  ],
};
