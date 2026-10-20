import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ApprovalSchema, ArtifactPatchSchema, DesignRevisionSchema, DiagramSchema, EvaluationSchema,
  IdSchema, MessageSchema, PrototypeSchema, RunSchema, ServiceSchema,
  type Approval, type ArtifactPatch, type DesignRevision, type EvaluationItem,
  type ImplementationRun, type Message, type ProjectManifest, type ProjectView, type ServiceDefinition,
} from '../shared/types';
import { canonicalJson, contentDigest, exists, jsonFiles, projectPath, readJson, writeJson } from './files';
import { GitService } from './git';
import { validatePrototype } from '../shared/prototypes';

const ManifestSchema = z.object({ schemaVersion: z.literal(1), id: IdSchema, name: z.string().min(1), createdAt: z.string(), activeDesignId: IdSchema });
const StoredDesignSchema = DesignRevisionSchema.omit({ diagrams: true, prototypes: true }).extend({ diagramIds: z.array(IdSchema), prototypeIds: z.array(IdSchema) });
const activeRunStates = new Set(['running', 'waiting', 'verifying']);
const queues = new Map<string, Promise<unknown>>();

export function designDigest(design: DesignRevision): string {
  const { reviewedDigest: _reviewed, reviewSummary: _summary, ...content } = DesignRevisionSchema.parse(design);
  return contentDigest(content);
}

function freshDesign(title = 'Untitled design'): DesignRevision {
  return DesignRevisionSchema.parse({ id: randomUUID(), roundId: randomUUID(), title });
}

function assertUnique(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} IDs must be unique.`);
}

export function validateDesign(value: unknown): DesignRevision {
  const design = DesignRevisionSchema.parse(value);
  design.prototypes = design.prototypes.map(validatePrototype);
  assertUnique(design.requirements.map((item) => item.id), 'Requirement');
  assertUnique(design.tasks.map((item) => item.id), 'Task');
  assertUnique(design.checks.map((item) => item.id), 'Check');
  assertUnique([...design.diagrams, ...design.prototypes].map((item) => item.id), 'Artifact');
  const requirements = new Set(design.requirements.map((item) => item.id));
  const tasks = new Set(design.tasks.map((item) => item.id));
  for (const task of design.tasks) for (const id of task.requirementIds) {
    if (!requirements.has(id)) throw new Error(`Task ${task.title} references an unknown requirement: ${id}.`);
  }
  for (const check of design.checks) for (const id of check.taskIds) {
    if (!tasks.has(id)) throw new Error(`Check ${check.title} references an unknown task: ${id}.`);
  }
  for (const diagram of design.diagrams) {
    assertUnique(diagram.nodes.map((item) => item.id), 'Node'); assertUnique(diagram.edges.map((item) => item.id), 'Edge');
    const nodes = new Map(diagram.nodes.map((item) => [item.id, item]));
    for (const node of diagram.nodes) {
      const seen = new Set([node.id]); let parent = node.parentId;
      while (parent) {
        if (seen.has(parent)) throw new Error('Diagram groups cannot contain a cycle.');
        seen.add(parent); const ancestor = nodes.get(parent);
        if (!ancestor || ancestor.type !== 'group') throw new Error(`Node ${node.id} has an invalid parent group.`);
        parent = ancestor.parentId;
      }
      for (const id of node.data.requirementIds) if (!requirements.has(id)) throw new Error(`Node ${node.id} references an unknown requirement.`);
    }
    for (const edge of diagram.edges) if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error(`Edge ${edge.id} has a missing endpoint.`);
  }
  for (const prototype of design.prototypes) {
    for (const id of prototype.requirementIds) if (!requirements.has(id)) throw new Error(`Prototype ${prototype.id} references an unknown requirement.`);
    const screenIds = new Set(design.prototypes.map((screen) => screen.id));
    const visit = (blocks: Record<string, unknown>[]) => {
      for (const block of blocks) {
        const props = block.props as Record<string, unknown>;
        const targets = [props.targetScreen, ...((props.links as { targetScreen?: string }[] | undefined) ?? []).map((link) => link.targetScreen)];
        for (const target of targets) if (typeof target === 'string' && target && !screenIds.has(target)) throw new Error(`Prototype link targets an unknown screen: ${target}.`);
        if (Array.isArray(props.content)) visit(props.content as Record<string, unknown>[]);
      }
    };
    visit(prototype.data.content); for (const blocks of Object.values(prototype.data.zones ?? {})) visit(blocks);
  }
  return design;
}

export class ProjectStore {
  readonly git: GitService;
  private liveRuns = new Set<string>();
  constructor(public readonly root: string) { this.git = new GitService(root); }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const prior = queues.get(this.root) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation); queues.set(this.root, current);
    try { return await current; } finally { if (queues.get(this.root) === current) queues.delete(this.root); }
  }
  private async location(relative: string): Promise<string> { return projectPath(this.root, `.sde/${relative}`); }
  private designPath(id: string): string { return `designs/${IdSchema.parse(id)}`; }

  async initialize(name = path.basename(this.root)): Promise<ProjectView> {
    const gitRoot = await fs.realpath((await this.git.run(['rev-parse', '--show-toplevel'])).trim());
    const actualRoot = await fs.realpath(this.root);
    if ((process.platform === 'win32' ? gitRoot.toLowerCase() !== actualRoot.toLowerCase() : gitRoot !== actualRoot)) throw new Error(`Open the Git repository root: ${gitRoot}`);
    const manifestFile = await this.location('project.json');
    if (!(await exists(manifestFile))) {
      const design = freshDesign(`${name} design`);
      const manifest: ProjectManifest = { schemaVersion: 1, id: randomUUID(), name, createdAt: new Date().toISOString(), activeDesignId: design.id };
      await this.persistDesign(design);
      await writeJson(manifestFile, manifest);
      await writeJson(await this.location('services.json'), []);
    }
    return this.load();
  }

  private async manifest(): Promise<ProjectManifest> { return readJson(await this.location('project.json'), ManifestSchema); }
  private async assertWritable(): Promise<void> {
    const file = await this.location('project.json');
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as { schemaVersion?: number };
    if (value.schemaVersion !== 1) throw new Error('This project uses a newer metadata format and is read-only. Update Overhull first.');
    await this.git.assertNoConflicts();
  }

  private async persistDesign(design: DesignRevision): Promise<void> {
    const parsed = validateDesign(design); const directory = this.designPath(parsed.id);
    const { diagrams, prototypes, ...fields } = parsed;
    for (const diagram of diagrams) await writeJson(await this.location(`${directory}/diagrams/${diagram.id}.json`), diagram);
    for (const prototype of prototypes) await writeJson(await this.location(`${directory}/prototypes/${prototype.id}.json`), prototype);
    await writeJson(await this.location(`${directory}/design.json`), { ...fields, diagramIds: diagrams.map((item) => item.id), prototypeIds: prototypes.map((item) => item.id) });
    // A complete revision snapshot provides recovery and comparison if a crash interrupts a multi-file save.
    await writeJson(await this.location(`revisions/${parsed.id}/${parsed.revision}.json`), parsed);
    for (const [kind, keep] of [['diagrams', new Set(diagrams.map((item) => `${item.id}.json`))], ['prototypes', new Set(prototypes.map((item) => `${item.id}.json`))]] as const) {
      for (const file of await jsonFiles(await this.location(`${directory}/${kind}`))) {
        if (!keep.has(path.basename(file))) await fs.unlink(file);
      }
    }
  }

  private async readDesign(id: string, commit?: string): Promise<DesignRevision> {
    const directory = this.designPath(id);
    const read = async <T extends z.ZodTypeAny>(relative: string, schema: T): Promise<z.output<T>> => commit
      ? schema.parse(JSON.parse(await this.git.show(commit, `.sde/${relative}`)))
      : readJson(await this.location(relative), schema);
    const stored = await read(`${directory}/design.json`, StoredDesignSchema);
    const diagrams = await Promise.all(stored.diagramIds.map((artifactId) => read(`${directory}/diagrams/${artifactId}.json`, DiagramSchema)));
    const prototypes = await Promise.all(stored.prototypeIds.map((artifactId) => read(`${directory}/prototypes/${artifactId}.json`, PrototypeSchema)));
    return validateDesign({ ...stored, diagrams, prototypes });
  }

  private async readCollection<T extends z.ZodTypeAny>(directory: string, schema: T, warnings?: string[]): Promise<z.output<T>[]> {
    const result: z.output<T>[] = [];
    for (const file of await jsonFiles(await this.location(directory))) {
      try { result.push(await readJson(file, schema)); } catch (error) {
        if (!warnings) throw error;
        warnings.push((error as Error).message);
      }
    }
    return result;
  }

  private async approvals(): Promise<Approval[]> {
    if (!(await this.git.head())) return [];
    const paths = (await this.git.run(['ls-tree', '-r', '--name-only', 'HEAD', '--', '.sde/approvals'])).trim().split('\n').filter(Boolean);
    const approvals: Approval[] = [];
    for (const file of paths) {
      if (!/^\.sde\/approvals\/[a-zA-Z0-9_-]+\.json$/.test(file)) continue;
      const commits = (await this.git.run(['log', '--diff-filter=A', '--format=%H', '--', file])).trim().split('\n').filter(Boolean);
      const commit = commits.at(-1);
      if (!commit) continue;
      const approval = ApprovalSchema.parse(JSON.parse(await this.git.show(commit, file)));
      approvals.push({ ...approval, commit });
    }
    return approvals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getApproved(approval?: Approval): Promise<{ design: DesignRevision; approval: Approval }> {
    const all = await this.approvals();
    const activeId = (await this.manifest()).activeDesignId;
    const selected = approval ? all.find((item) => item.id === approval.id) : all.filter((item) => item.designId === activeId).at(-1);
    if (!selected?.commit || !(await this.git.isAncestor(selected.commit))) throw new Error('No reachable, committed design approval is available.');
    const design = await this.readDesign(selected.designId, selected.commit);
    if (designDigest(design) !== selected.designDigest) throw new Error('The approved design does not match its recorded digest.');
    return { design, approval: selected };
  }

  async load(): Promise<ProjectView> {
    const warnings: string[] = []; let readOnly = false;
    const rawManifest = JSON.parse(await fs.readFile(await this.location('project.json'), 'utf8')) as Record<string, unknown>;
    if (rawManifest.schemaVersion !== 1) { readOnly = true; warnings.push('Newer metadata format: this project is read-only until Overhull is updated.'); }
    const manifest = ManifestSchema.parse({ ...rawManifest, schemaVersion: 1 });
    let design: DesignRevision;
    try { design = await this.readDesign(manifest.activeDesignId); } catch (error) {
      readOnly = true; warnings.push((error as Error).message);
      const revisions = await jsonFiles(await this.location(`revisions/${manifest.activeDesignId}`));
      design = freshDesign('Design could not be loaded'); design.id = manifest.activeDesignId;
      for (const file of revisions.sort((a, b) => Number(path.basename(b, '.json')) - Number(path.basename(a, '.json')))) {
        try { design = validateDesign(await readJson(file, DesignRevisionSchema)); warnings.push(`Showing recoverable revision ${design.revision}; repair the invalid file before editing.`); break; } catch { /* Try an earlier valid snapshot. */ }
      }
    }
    let approvals: Approval[] = [];
    try { approvals = await this.approvals(); } catch (error) { readOnly = true; warnings.push((error as Error).message); }
    const [rawRuns, messages, feedback, git] = await Promise.all([
      this.readCollection('runs', RunSchema, warnings), this.readCollection('messages', MessageSchema, warnings),
      this.readCollection('feedback', EvaluationSchema, warnings), this.git.status(),
    ]);
    let services: ServiceDefinition[] = [];
    try { services = await readJson(await this.location('services.json'), z.array(ServiceSchema)); } catch (error) { warnings.push((error as Error).message); }
    const runs = rawRuns.map((run) => activeRunStates.has(run.status) && !this.liveRuns.has(run.id)
      ? { ...run, status: 'interrupted' as const } : run).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (git.conflicts.length) { readOnly = true; warnings.push('Resolve Git conflicts before editing or running this project.'); }
    const approved = approvals.filter((item) => item.designId === design.id).at(-1);
    if (approved && designDigest(design) !== approved.designDigest) { readOnly = true; warnings.push('Approved design files were modified. Restore their committed contents or create a new draft.'); }
    let verifiedRunId: string | undefined;
    const completed = runs.filter((run) => run.status === 'complete' && run.designId === design.id && run.designDigest === approved?.designDigest);
    if (completed.length) {
      const digest = await this.codeDigest();
      verifiedRunId = completed.filter((run) => run.outputCodeDigest === digest).at(-1)?.id;
    }
    return { root: this.root, manifest, design, approvals, runs, messages: messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      feedback: feedback.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), services, git, readOnly, warnings, verifiedRunId };
  }

  async saveDraft(value: DesignRevision, expectedRevision: number): Promise<ProjectView> {
    return this.serial(async () => {
      await this.assertWritable(); const manifest = await this.manifest(); const current = await this.readDesign(manifest.activeDesignId);
      if (current.revision !== expectedRevision) throw new Error('This design changed while you were editing. Refresh and apply your changes to the latest revision.');
      if ((await this.approvals()).some((approval) => approval.designId === current.id)) throw new Error('This design is approved. Create a new draft before changing it.');
      if (value.id !== current.id || value.roundId !== current.roundId) throw new Error('The design identity cannot be changed by a patch.');
      const next = validateDesign({ ...value, revision: current.revision + 1, reviewedDigest: undefined, reviewSummary: undefined });
      for (const kind of ['diagrams', 'prototypes'] as const) for (const artifact of next[kind]) {
        const previous = current[kind].find((item) => item.id === artifact.id);
        if (previous) {
          const strip = (item: typeof artifact) => ({ ...item, revision: 0 });
          artifact.revision = previous.revision + (contentDigest(strip(previous as typeof artifact)) === contentDigest(strip(artifact)) ? 0 : 1);
        } else artifact.revision = 0;
      }
      await this.persistDesign(next); return this.load();
    });
  }

  async patchArtifact(input: ArtifactPatch): Promise<ProjectView> {
    const patch = ArtifactPatchSchema.parse(input);
    const manifest = await this.manifest(); const current = await this.readDesign(manifest.activeDesignId);
    if (patch.kind === 'design') {
      if (patch.id !== current.id) throw new Error('The design patch targets a different draft.');
      return this.saveDraft(validateDesign(patch.value), patch.expectedRevision);
    }
    const key = patch.kind === 'diagram' ? 'diagrams' : 'prototypes';
    const existing = current[key].find((artifact) => artifact.id === patch.id);
    if (existing ? existing.revision !== patch.expectedRevision : patch.expectedRevision !== 0) throw new Error('This artifact changed. Read the latest revision before retrying.');
    const value = patch.kind === 'diagram' ? DiagramSchema.parse(patch.value) : PrototypeSchema.parse(patch.value);
    if (value.id !== patch.id) throw new Error('Artifact identity does not match its patch.');
    const next = { ...current, [key]: [...current[key].filter((artifact) => artifact.id !== patch.id), value] } as DesignRevision;
    return this.saveDraft(next, current.revision);
  }

  async review(summary: string, expectedDigest?: string): Promise<ProjectView> {
    return this.serial(async () => {
      await this.assertWritable(); const manifest = await this.manifest(); const design = await this.readDesign(manifest.activeDesignId);
      const digest = designDigest(design);
      if (expectedDigest && expectedDigest !== digest) throw new Error('Design changed during review. Review the latest revision.');
      if (!summary.trim()) throw new Error('A design review summary is required.');
      design.reviewedDigest = digest; design.reviewSummary = summary;
      await this.persistDesign(design); return this.load();
    });
  }

  async approve(): Promise<ProjectView> {
    return this.serial(async () => {
      await this.assertWritable();
      const sourceChanges = (await this.git.status()).files.filter((file) => this.isCodePath(file.path) && file.path !== '.sde/services.json');
      if (sourceChanges.length) throw new Error(`Commit source changes before approving a design: ${sourceChanges.map((file) => file.path).join(', ')}`);
      const manifest = await this.manifest(); const design = await this.readDesign(manifest.activeDesignId); const digest = designDigest(design);
      if ((await this.approvals()).some((item) => item.designId === design.id)) throw new Error('This revision is already approved.');
      if (design.reviewedDigest !== digest) throw new Error('Ask the agent to review the latest design before approving it.');
      if (!design.requirements.length || !design.tasks.length) throw new Error('Add requirements and implementation tasks before approval.');
      if (!design.checks.some((check) => check.required && check.kind === 'test') || !design.checks.some((check) => check.required && check.kind === 'smoke')) throw new Error('Approval requires explicit required test and smoke checks.');
      if (design.questions.some((question) => question.blocking && !question.answer?.trim())) throw new Error('Resolve blocking design questions before approval.');
      const author = await this.git.identity();
      const approval = ApprovalSchema.parse({ id: randomUUID(), designId: design.id, designDigest: digest, baselineCommit: await this.git.head(), author: `${author.name} <${author.email}>`, createdAt: new Date().toISOString() });
      const approvalPath = `.sde/approvals/${approval.id}.json`;
      await writeJson(await projectPath(this.root, approvalPath), approval);
      await this.git.commit(`Approve design: ${design.title}`, ['.sde/project.json', `.sde/${this.designPath(design.id)}`, `.sde/revisions/${design.id}`, '.sde/services.json', approvalPath]);
      return this.load();
    });
  }

  async newDraft(feedbackIds: string[] = []): Promise<ProjectView> {
    return this.serial(async () => {
      await this.assertWritable(); const manifest = await this.manifest();
      let current = await this.readDesign(manifest.activeDesignId);
      const approved = (await this.approvals()).filter((item) => item.designId === current.id).at(-1);
      if (approved) current = (await this.getApproved(approved)).design;
      const feedback = await this.readCollection('feedback', EvaluationSchema);
      if (feedbackIds.some((id) => !feedback.some((item) => item.id === id))) throw new Error('Selected feedback no longer exists.');
      const selected = feedback.filter((item) => feedbackIds.includes(item.id));
      const next = validateDesign({ ...current, id: randomUUID(), roundId: randomUUID(), revision: 0, reviewedDigest: undefined, reviewSummary: undefined, sourceFeedbackIds: feedbackIds,
        decisions: [...current.decisions, ...selected.map((item) => `Evaluation ${item.id}: ${item.title} — ${item.body}`)] });
      await this.persistDesign(next); await writeJson(await this.location('project.json'), { ...manifest, activeDesignId: next.id }); return this.load();
    });
  }

  async history(): Promise<DesignRevision[]> {
    const manifest = await this.manifest(); const results: DesignRevision[] = [];
    for (const file of await jsonFiles(await this.location(`revisions/${manifest.activeDesignId}`))) {
      try { results.push(await readJson(file, DesignRevisionSchema)); } catch { /* Invalid snapshots never replace valid current content. */ }
    }
    return results.sort((a, b) => b.revision - a.revision);
  }

  async saveMessage(value: Message): Promise<void> {
    await this.serial(async () => {
      await this.assertWritable(); const message = MessageSchema.parse(value); const file = await this.location(`messages/${message.id}.json`);
      if (await exists(file)) {
        if (contentDigest(await readJson(file, MessageSchema)) !== contentDigest(message)) throw new Error('Completed messages are immutable. Add a new message instead.');
        return;
      }
      await writeJson(file, message);
    });
  }
  async saveFeedback(value: EvaluationItem): Promise<void> {
    await this.assertWritable(); const item = EvaluationSchema.parse(value);
    for (const attachment of item.attachments) await projectPath(this.root, attachment);
    await writeJson(await this.location(`feedback/${item.id}.json`), item);
  }
  async saveRun(value: ImplementationRun): Promise<void> {
    await this.assertWritable(); const run = RunSchema.parse(value);
    if (activeRunStates.has(run.status)) this.liveRuns.add(run.id); else this.liveRuns.delete(run.id);
    await writeJson(await this.location(`runs/${run.id}.json`), run);
  }
  async saveServices(value: ServiceDefinition[]): Promise<void> {
    await this.assertWritable(); const services = z.array(ServiceSchema).parse(value); assertUnique(services.map((item) => item.id), 'Service');
    const byId = new Map(services.map((item) => [item.id, item]));
    const visit = (id: string, ancestors: Set<string>) => {
      if (ancestors.has(id)) throw new Error('Service dependencies cannot contain a cycle.');
      const service = byId.get(id); if (!service) throw new Error(`Unknown service dependency: ${id}.`);
      for (const dependency of service.dependsOn) visit(dependency, new Set([...ancestors, id]));
    };
    for (const service of services) {
      visit(service.id, new Set());
      for (const command of [service.command, ...Object.values(service.platforms ?? {})]) await projectPath(this.root, command.cwd);
    }
    await writeJson(await this.location('services.json'), services);
  }

  async assertSourceClean(): Promise<void> {
    const status = await this.git.status();
    if (status.conflicts.length) throw new Error('Resolve Git conflicts before implementation.');
    const dirty = status.files.filter((file) => this.isCodePath(file.path));
    if (dirty.length) throw new Error(`Commit source and executable configuration before continuing: ${dirty.map((file) => file.path).join(', ')}`);
  }
  private isCodePath(relative: string): boolean { return !relative.startsWith('.sde/') || relative === '.sde/services.json'; }
  async codeDigest(): Promise<string> {
    const files = [...new Set((await this.git.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))]
      .filter((file) => this.isCodePath(file)).sort();
    const hash = createHash('sha256');
    for (const relative of files) {
      hash.update(relative); hash.update('\0');
      const file = path.resolve(this.root, relative);
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) { hash.update('link:'); hash.update(await fs.readlink(file)); }
        else if (stat.isFile()) { hash.update('file:'); hash.update(await fs.readFile(file)); }
        else hash.update('directory');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted'); else throw error; }
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  /** Validate a conflicted metadata file before the Git service stages its resolution. */
  async resolveConflict(relative: string, content: string): Promise<void> {
    if (relative.startsWith('.sde/') && relative.endsWith('.json')) {
      const value: unknown = JSON.parse(content);
      if (relative === '.sde/project.json') ManifestSchema.parse(value);
      else if (relative === '.sde/services.json') z.array(ServiceSchema).parse(value);
      else if (relative.includes('/diagrams/')) {
        const diagram = DiagramSchema.parse(value);
        const requirements = [...new Set(diagram.nodes.flatMap((node) => node.data.requirementIds))].map((id) => ({ id, title: id }));
        validateDesign({ ...freshDesign(), diagrams: [diagram], requirements });
      }
      else if (relative.includes('/prototypes/')) validatePrototype(value);
      else if (relative.endsWith('/design.json')) StoredDesignSchema.parse(value);
      else if (relative.startsWith('.sde/approvals/')) ApprovalSchema.parse(value);
      else if (relative.startsWith('.sde/messages/')) MessageSchema.parse(value);
      else if (relative.startsWith('.sde/feedback/')) EvaluationSchema.parse(value);
      else if (relative.startsWith('.sde/runs/')) RunSchema.parse(value);
      else if (relative.startsWith('.sde/revisions/')) validateDesign(value);
    }
    await this.git.resolveConflict(relative, content);
  }
}
