import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectStore } from '../src/main/project';
import { DesignRevisionSchema, type DesignRevision, type Diagram } from '../src/shared/types';
import { prototypeDataExample } from '../src/shared/prototypes';

let application: ElectronApplication;
let page: Page;
let directory: string;
let repository: string;
let store: ProjectStore;
const errors: string[] = [];

async function focusApplication() {
  await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMinimized()) window.restore();
    window.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
  });
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
}

async function waitForCanvasLayout() {
  let previous = '';
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const layout = await page.evaluate(() => {
          const canvas = document.querySelector('.diagram-canvas');
          const viewport = document.querySelector('.react-flow__viewport');
          const actor = document.querySelector('.react-flow__node[data-id="user"] .sde-flow-node-header');
          if (!canvas || !viewport || !actor) return null;
          const bounds = canvas.getBoundingClientRect();
          const node = actor.getBoundingClientRect();
          const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
          return {
            transform: getComputedStyle(viewport).transform,
            canvas: [bounds.x, bounds.y, bounds.width, bounds.height],
            actor: [node.x, node.y, node.width, node.height],
            ready:
              node.width > 0 &&
              node.height > 0 &&
              center.x > bounds.left &&
              center.x < bounds.right &&
              center.y > bounds.top &&
              center.y < bounds.bottom,
          };
        });
        const current = JSON.stringify(layout);
        stableSamples = layout?.ready && current === previous ? stableSamples + 1 : 0;
        previous = current;
        return stableSamples;
      },
      {
        message: 'React Flow node measurements and fitView must settle before pointer input',
        intervals: [100],
        timeout: 10000,
      },
    )
    .toBeGreaterThanOrEqual(3);
}

const animationFrame = () =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

function flow(kind: Diagram['kind'], title: string): Diagram {
  return {
    id: `diagram-${kind}`,
    title,
    kind,
    revision: 0,
    nodes: [
      {
        id: 'user',
        type: 'actor',
        position: { x: 0, y: 150 },
        data: {
          label: 'Team member',
          description: 'Organize and deliver team work',
          fields: [],
          requirementIds: ['requirement-projects'],
        },
      },
      {
        id: 'workspace',
        type: 'screen',
        position: { x: 260, y: 150 },
        data: {
          label: 'Project workspace',
          description: 'See priorities and active projects',
          fields: [],
          requirementIds: ['requirement-projects'],
        },
      },
      {
        id: 'backend',
        type: 'group',
        position: { x: 530, y: 50 },
        width: 320,
        height: 340,
        data: { label: 'Application services', description: '', fields: [], requirementIds: [] },
      },
      {
        id: 'api',
        type: 'api',
        parentId: 'backend',
        position: { x: 45, y: 75 },
        data: {
          label: 'Project API',
          description: 'Validate and save changes',
          fields: [],
          requirementIds: ['requirement-projects'],
        },
      },
      {
        id: 'projects',
        type: 'entity',
        parentId: 'backend',
        position: { x: 45, y: 200 },
        data: {
          label: 'projects',
          description: '',
          fields: [
            { name: 'id', type: 'uuid', primary: true },
            { name: 'name', type: 'text' },
            { name: 'status', type: 'text' },
          ],
          requirementIds: ['requirement-projects'],
        },
      },
    ],
    edges: [
      { id: 'open', source: 'user', target: 'workspace', label: 'opens', kind: 'navigation' },
      { id: 'request', source: 'workspace', target: 'api', label: 'GET /projects', kind: 'control' },
      {
        id: 'persist',
        source: 'api',
        target: 'projects',
        label: 'reads / writes',
        kind: 'data',
        cardinality: '1:N',
      },
    ],
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-ui-'));
  repository = path.join(directory, 'team-project');
  await fs.mkdir(repository);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'UI Test']);
  git(['config', 'user.email', 'ui@example.test']);
  await fs.writeFile(path.join(repository, 'README.md'), '# Team project\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'Initialize UI fixture']);
  store = new ProjectStore(repository);
  const view = await store.initialize('Team project');
  const design: DesignRevision = DesignRevisionSchema.parse({
    ...view.design,
    title: 'A shared home for team projects',
    summary:
      'Help a small software team organize projects, track progress, and decide what to work on next. Keep the daily workflow focused and clear.',
    requirements: [
      {
        id: 'requirement-projects',
        title: 'Create and organize projects',
        description:
          'Team members can create a project, set its owner, and see its current status in a shared workspace.',
        acceptance:
          'A created project appears in the list with its name, owner, and status. Changes persist after reload.',
      },
    ],
    tasks: [
      {
        id: 'task-api',
        title: 'Build the project API and persistence',
        description: 'Implement create, read and update operations with input validation.',
        requirementIds: ['requirement-projects'],
      },
      {
        id: 'task-ui',
        title: 'Build the project workspace',
        description: 'Implement the project list and creation form from the approved prototype.',
        requirementIds: ['requirement-projects'],
      },
    ],
    checks: [
      {
        id: 'check-projects',
        title: 'Project lifecycle tests',
        kind: 'test',
        required: true,
        command: { executable: 'node', args: ['--test'], cwd: '.', timeoutMs: 120000 },
        taskIds: ['task-api', 'task-ui'],
        serviceIds: [],
      },
    ],
    decisions: [
      'Use a compact list with explicit project status.',
      'Keep project creation inside the workspace so users retain context.',
    ],
    questions: [
      {
        id: 'question-owner',
        text: 'Can a project have multiple owners?',
        blocking: true,
        answer: 'One owner initially; any team member can update the project.',
      },
    ],
    diagrams: [
      flow('workflow', 'How the team works'),
      flow('ui', 'Workspace navigation'),
      flow('database', 'Project data model'),
      flow('backend', 'Request lifecycle'),
    ],
    prototypes: [
      {
        id: 'screen-home',
        title: 'Project workspace',
        revision: 0,
        data: prototypeDataExample,
        requirementIds: ['requirement-projects'],
      },
    ],
  });
  await store.saveDraft(design, view.design.revision);
  application = await electron.launch({
    args: [path.resolve('out/main/index.js'), `--user-data-dir=${path.join(directory, 'app-data')}`],
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await application?.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus || !page || page.isClosed()) return;
  const renderer = await page
    .evaluate(() => {
      const node = document.querySelector('.react-flow__node[data-id="user"]');
      const header = node?.querySelector('.sde-flow-node-header');
      const box = header?.getBoundingClientRect();
      return {
        focused: document.hasFocus(),
        visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        canvas: document.querySelector('.diagram-canvas')?.getBoundingClientRect().toJSON(),
        transform: document.querySelector('.react-flow__viewport')?.getAttribute('style'),
        actor: { bounds: box?.toJSON(), style: node?.getAttribute('style'), class: node?.className },
        hit: box
          ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.outerHTML.slice(0, 500)
          : null,
        alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent),
        save: document.querySelector('.save-status')?.textContent,
        inputEvents: (window as any).__overhullDragTrace,
      };
    })
    .catch((error) => ({ error: String(error) }));
  const native = await application
    .evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        bounds: window?.getBounds(),
        content: window?.getContentBounds(),
        focused: window?.isFocused(),
        display: screen.getPrimaryDisplay().workArea,
        scale: screen.getPrimaryDisplay().scaleFactor,
      };
    })
    .catch((error) => ({ error: String(error) }));
  console.log(
    'ELECTRON_UI_DIAGNOSTICS',
    JSON.stringify({ platform: process.platform, native, renderer, errors }),
  );
});

test('opens a real repository and shows the design workflow', async () => {
  await expect(page.getByRole('heading', { name: /Build a common understanding/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/overhull-welcome.png', fullPage: true });
  // The same typed IPC used by the Open Repository dialog opens our disposable fixture.
  await page.evaluate(async (root) => {
    await window.sde.request('project.open', { path: root });
  }, repository);
  // Reopen through the now-populated recent-project entry so App receives the view.
  await page.reload();
  await page.getByRole('button', { name: /team-project/ }).click();
  await expect(page.getByRole('heading', { name: 'Shape the idea together' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Requirement 1 title' })).toHaveValue(
    'Create and organize projects',
  );
  await page.screenshot({ path: 'test-results/overhull-design.png', fullPage: true });
});

test('edits a diagram with actual dragging, connections, grouping and persisted JSON', async () => {
  await focusApplication();
  await page.getByRole('button', { name: 'How the team works', exact: true }).click();
  const actor = page.locator('.react-flow__node[data-id="user"] .sde-flow-node-header');
  await expect(actor).toBeVisible();
  await waitForCanvasLayout();
  await actor.click({ trial: true });
  await page.evaluate(() => {
    const trace: unknown[] = [];
    (window as any).__overhullDragTrace = trace;
    for (const type of ['mousedown', 'mousemove', 'mouseup'])
      document.addEventListener(
        type,
        (event) => {
          const mouse = event as MouseEvent;
          trace.push({
            type,
            x: mouse.clientX,
            y: mouse.clientY,
            button: mouse.button,
            buttons: mouse.buttons,
            node: (mouse.target as Element)?.closest?.('.react-flow__node')?.getAttribute('data-id'),
          });
          if (trace.length > 40) trace.shift();
        },
        { capture: true },
      );
  });
  const before = (await store.load()).design.diagrams[0].nodes.find((node) => node.id === 'user')!.position;
  const box = await actor.boundingBox();
  if (!box) throw new Error('Actor has no layout box.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Give the native mouse-down and each drag segment a frame to reach React Flow.
  // Sending all moves in one frame can race its initial fitView on a fast macOS runner.
  await animationFrame();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(box.x + box.width / 2 + step * 5, box.y + box.height / 2 + step * 4);
    await animationFrame();
  }
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await store.load()).design.diagrams[0].nodes.find((node) => node.id === 'user')!.position.x,
    )
    .not.toBe(before.x);
  await actor.click();
  await page.getByLabel('Label', { exact: true }).fill('Project contributor');
  await expect
    .poll(
      async () =>
        (await store.load()).design.diagrams[0].nodes.find((node) => node.id === 'user')!.data.label,
    )
    .toBe('Project contributor');
  await page.getByRole('button', { name: 'Undo diagram change' }).click();
  await page.getByRole('button', { name: 'Redo diagram change' }).click();
  await page.getByRole('combobox', { name: 'Node type' }).selectOption('decision');
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await expect.poll(async () => (await store.load()).design.diagrams[0].nodes.length).toBe(6);
  await page.getByLabel('Label', { exact: true }).fill('Is the project valid?');
  await page.getByRole('combobox', { name: 'Group', exact: true }).selectOption('backend');
  await expect
    .poll(
      async () =>
        (await store.load()).design.diagrams[0].nodes.find((node) => node.type === 'decision')?.parentId,
    )
    .toBe('backend');
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Arrange', exact: true })).toBeEnabled();
  await waitForCanvasLayout();
  const sourceHandle = page.locator('.react-flow__node[data-id="user"] .react-flow__handle.source');
  const targetHandle = page.locator('.react-flow__node[data-id="projects"] .react-flow__handle.target');
  await sourceHandle.dragTo(targetHandle);
  await expect.poll(async () => (await store.load()).design.diagrams[0].edges.length).toBe(4);
  await page.screenshot({ path: 'test-results/overhull-diagram.png', fullPage: true });
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Diagram JSON source' });
  const original = await source.inputValue();
  const invalid = JSON.parse(original) as Diagram;
  invalid.edges.push({
    id: 'broken-edge',
    source: 'user',
    target: 'absent',
    label: 'invalid',
    kind: 'control',
  });
  await source.fill(JSON.stringify(invalid));
  await page.getByRole('button', { name: 'Apply valid JSON' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'existing source and target' })).toBeVisible();
  await expect
    .poll(async () => (await store.load()).design.diagrams[0].edges.some((edge) => edge.id === 'broken-edge'))
    .toBe(false);
  await source.fill(original);
  await page.getByRole('button', { name: 'Apply valid JSON' }).click();
});

test('edits and previews a real Puck prototype without losing its source', async () => {
  await page.getByRole('button', { name: 'Project workspace', exact: true }).click();
  await expect(page.locator('.prototype-puck')).toBeVisible();
  const frame = page.frameLocator('.prototype-puck iframe');
  await expect(frame.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible();
  await frame.getByRole('heading', { name: 'Welcome', exact: true }).click();
  await page.screenshot({ path: 'test-results/overhull-prototype-editor.png', fullPage: true });
  // Editing through the real Puck field panel must update the same persisted source.
  const textField = page.locator('.prototype-puck').getByRole('textbox', { name: 'text', exact: true });
  await expect(textField).toBeVisible();
  await textField.fill('Your team, moving forward');
  await expect
    .poll(async () => JSON.stringify((await store.load()).design.prototypes[0].data))
    .toContain('Your team, moving forward');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your team, moving forward', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mobile preview' }).click();
  await expect
    .poll(async () => Math.round((await page.locator('.prototype-preview-page').boundingBox())!.width))
    .toBe(360);
  await page.screenshot({ path: 'test-results/overhull-prototype-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Prototype JSON source' });
  const prototype = JSON.parse(await source.inputValue());
  prototype.data.content.push({
    type: 'Status',
    props: { id: 'status-test', text: 'Ready to build', tone: 'success' },
  });
  await source.fill(JSON.stringify(prototype));
  await page.getByRole('button', { name: 'Apply valid JSON' }).click();
  await expect
    .poll(async () => JSON.stringify((await store.load()).design.prototypes[0].data))
    .toContain('Ready to build');
  await page.reload();
  await page.getByRole('button', { name: /team-project/ }).click();
  await page.getByRole('button', { name: 'Project workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Ready to build', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('supports keyboard settings, dark theme, scaling and recovery after restart', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('button', { name: 'dark', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Density', exact: true }).selectOption('compact');
  const scale = settings.getByRole('slider', { name: /Interface scale/ });
  await scale.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
  await expect(scale).toHaveValue('125');
  const outlineWidth = settings.getByRole('slider', { name: /Artifact outline width/ });
  await outlineWidth.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  await expect(outlineWidth).toHaveValue('280');
  await settings.getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('14');
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect
    .poll(() => page.locator('.app').evaluate((element) => getComputedStyle(element).zoom))
    .toBe('1.25');
  await expect
    .poll(() => page.locator('.artifact-sidebar').evaluate((element) => getComputedStyle(element).width))
    .toBe('280px');
  await page.screenshot({ path: 'test-results/overhull-dark-scaled.png', fullPage: true });
  await application.close();
  application = await electron.launch({
    args: [path.resolve('out/main/index.js'), `--user-data-dir=${path.join(directory, 'app-data')}`],
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: /team-project/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() => page.locator('.app').evaluate((element) => getComputedStyle(element).zoom))
    .toBe('1.25');
  await expect
    .poll(() => page.locator('.artifact-sidebar').evaluate((element) => getComputedStyle(element).width))
    .toBe('280px');
  await page.getByRole('button', { name: 'Project workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Ready to build', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('flushes a debounced manual edit when the native window closes immediately', async () => {
  await page.getByRole('button', { name: 'Brief & requirements', exact: true }).click();
  const title = 'The final edit before closing the window';
  await page.getByRole('textbox', { name: 'Design title', exact: true }).fill(title);
  // Do not wait for the autosave debounce: close the actual BrowserWindow now.
  const closed = application.waitForEvent('close', { timeout: 15000 });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  expect((await store.load()).design.title).toBe(title);
  application = await electron.launch({
    args: [path.resolve('out/main/index.js'), `--user-data-dir=${path.join(directory, 'app-data')}`],
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: /team-project/ }).click();
  await expect(page.getByRole('textbox', { name: 'Design title', exact: true })).toHaveValue(title);
  expect(errors).toEqual([]);
});

test('flushes pending edits before switching repositories and keeps project responses separate', async () => {
  const otherRepository = path.join(directory, 'other-project');
  await fs.mkdir(otherRepository);
  const git = (args: string[]) => execFileSync('git', args, { cwd: otherRepository, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'UI Test']);
  git(['config', 'user.email', 'ui@example.test']);
  await fs.writeFile(path.join(otherRepository, 'README.md'), '# Another project\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'Initialize second UI fixture']);
  const otherStore = new ProjectStore(otherRepository);
  const otherInitial = await otherStore.initialize('Other project');
  // Replace only the OS picker; the renderer action, IPC, Git, and persistence stay real.
  await application.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, otherRepository);
  const title = 'Saved while switching to another repository';
  await page.getByRole('textbox', { name: 'Design title', exact: true }).fill(title);
  await page.getByRole('button', { name: 'Team project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Other project', exact: true })).toBeVisible();
  expect((await store.load()).design.title).toBe(title);
  await expect(page.getByRole('textbox', { name: 'Design title', exact: true })).toHaveValue(
    otherInitial.design.title,
  );
  expect((await otherStore.load()).design.title).toBe(otherInitial.design.title);
  await application.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, repository);
  await page.getByRole('button', { name: 'Other project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Team project', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Design title', exact: true })).toHaveValue(title);
  expect(errors).toEqual([]);
});
