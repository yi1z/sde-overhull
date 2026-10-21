import { z } from 'zod';
import type { AgentEvent } from './types';

type Request = Pick<AgentEvent, 'method' | 'data'>;
export type AgentResponseAction = 'accept' | 'decline' | 'cancel';
export const supportedAgentRequests = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

const specialPath = z.union([
  z.object({ kind: z.enum(['root', 'minimal', 'tmpdir', 'slash_tmp']) }).strict(),
  z.object({ kind: z.literal('project_roots'), subpath: z.string().nullable().optional() }).strict(),
  z
    .object({ kind: z.literal('unknown'), path: z.string(), subpath: z.string().nullable().optional() })
    .strict(),
]);
const filePath = z.union([
  z.object({ type: z.literal('path'), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal('glob_pattern'), pattern: z.string().min(1) }).strict(),
  z.object({ type: z.literal('special'), value: specialPath }).strict(),
]);
export const PermissionProfileSchema = z
  .object({
    network: z.object({ enabled: z.boolean().nullable().optional() }).strict().nullable().optional(),
    fileSystem: z
      .object({
        read: z.array(z.string().min(1)).nullable().optional(),
        write: z.array(z.string().min(1)).nullable().optional(),
        entries: z
          .array(z.object({ access: z.enum(['read', 'write', 'deny']), path: filePath }).strict())
          .nullable()
          .optional(),
        globScanMaxDepth: z.number().int().positive().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

function object(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, any>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function permissionSubset(requested: unknown, selected: unknown): void {
  const grant = PermissionProfileSchema.parse(selected);
  // Denying all permissions must remain possible even when a newer server
  // asks for an unknown permission type that this client cannot grant.
  if (Object.keys(grant).length === 0) return;
  const request = PermissionProfileSchema.parse(requested);
  if (grant.network?.enabled && !request.network?.enabled)
    throw new Error('Network access was not requested.');
  for (const field of ['read', 'write', 'entries'] as const) {
    const allowed = request.fileSystem?.[field] ?? [];
    for (const entry of grant.fileSystem?.[field] ?? []) {
      if (!allowed.some((item) => canonical(item) === canonical(entry)))
        throw new Error('Permission grants must be a subset of the requested paths and access levels.');
    }
  }
  if (
    grant.fileSystem?.globScanMaxDepth != null &&
    grant.fileSystem.globScanMaxDepth !== request.fileSystem?.globScanMaxDepth
  )
    throw new Error('Permission grants cannot change the requested glob scan depth.');
  // A partial allow-list must not discard explicit restrictions in the request.
  const allowsFiles = !!(
    grant.fileSystem?.read?.length ||
    grant.fileSystem?.write?.length ||
    grant.fileSystem?.entries?.some((entry) => entry.access !== 'deny')
  );
  if (allowsFiles) {
    for (const denied of request.fileSystem?.entries?.filter((entry) => entry.access === 'deny') ?? []) {
      if (!grant.fileSystem?.entries?.some((entry) => canonical(entry) === canonical(denied)))
        throw new Error('Retain the requested filesystem restrictions when granting access.');
    }
  }
}

/** Validate the primitive fields defined by MCP form elicitation. Unknown form
 * extensions fail visibly; clients may still decline or cancel those requests. */
function validateForm(schemaValue: unknown, input: unknown): Record<string, unknown> {
  const schema = object(schemaValue, 'This elicitation has no supported form schema.');
  if (schema.type !== 'object') throw new Error('This elicitation requires an unsupported form schema.');
  const properties = object(schema.properties, 'This elicitation has no form properties.');
  const content = object(input, 'Enter a JSON object containing the requested form values.');
  const required = z.array(z.string()).parse(schema.required ?? []);
  for (const key of required)
    if (!Object.hasOwn(content, key)) throw new Error(`A value is required for ${key}.`);
  for (const [key, value] of Object.entries(content)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`Unexpected form field: ${key}.`);
    const field = object(properties[key], `Invalid form schema for ${key}.`);
    switch (field.type) {
      case 'string': {
        let validator = z.string();
        if (field.minLength != null) validator = validator.min(field.minLength);
        if (field.maxLength != null) validator = validator.max(field.maxLength);
        if (field.format === 'email') validator = validator.email();
        if (field.format === 'uri') validator = validator.url();
        if (field.format === 'date') validator = validator.date();
        if (field.format === 'date-time') validator = validator.datetime({ offset: true });
        validator.parse(value);
        const options = field.enum ?? field.oneOf?.map((option: any) => option.const);
        if (options && !options.includes(value)) throw new Error(`Choose a listed option for ${key}.`);
        break;
      }
      case 'number':
      case 'integer': {
        let validator = z.number().finite();
        if (field.type === 'integer') validator = validator.int();
        if (field.minimum != null) validator = validator.min(field.minimum);
        if (field.maximum != null) validator = validator.max(field.maximum);
        validator.parse(value);
        break;
      }
      case 'boolean':
        z.boolean().parse(value);
        break;
      case 'array': {
        let validator = z.array(z.string());
        if (field.minItems != null) validator = validator.min(field.minItems);
        if (field.maxItems != null) validator = validator.max(field.maxItems);
        const values = validator.parse(value);
        const options = field.items?.enum ?? field.items?.anyOf?.map((option: any) => option.const);
        if (!Array.isArray(options) || values.some((item) => !options.includes(item)))
          throw new Error(`Choose listed options for ${key}.`);
        break;
      }
      default:
        throw new Error(`Unsupported form field type for ${key}.`);
    }
  }
  return content;
}

/** Produces protocol-specific, one-turn responses. Permission input, when
 * supplied, is an exact subset of the displayed request; omitted input grants
 * exactly the displayed profile. It never creates persistent/session grants. */
export function buildAgentResponse(
  request: Request,
  action: AgentResponseAction,
  input?: unknown,
): Record<string, unknown> {
  z.enum(['accept', 'decline', 'cancel']).parse(action);
  const data = (request.data ?? {}) as Record<string, any>;
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: action };
    case 'item/permissions/requestApproval': {
      const permissions = action === 'accept' ? PermissionProfileSchema.parse(input ?? data.permissions) : {};
      if (action === 'accept') permissionSubset(data.permissions, permissions);
      return { permissions, scope: 'turn' };
    }
    case 'item/tool/requestUserInput': {
      if (action !== 'accept') throw new Error('Cancel the agent turn to dismiss its questions.');
      const questions = z
        .array(z.object({ id: z.string().min(1) }))
        .min(1)
        .parse(data.questions);
      const inputAnswers = object(input, 'Answer the agent questions before sending.');
      const answers: Record<string, { answers: string[] }> = Object.create(null);
      for (const question of questions) {
        const raw = inputAnswers[question.id];
        const values = z
          .array(z.string().trim().min(1))
          .min(1)
          .parse(Array.isArray(raw) ? raw : [raw]);
        answers[question.id] = { answers: values };
      }
      return { answers };
    }
    case 'mcpServer/elicitation/request':
      if (action !== 'accept' || data.mode === 'url') return { action, content: null };
      return { action, content: validateForm(data.requestedSchema, input) };
    default:
      throw new Error(`Unsupported agent request: ${request.method ?? 'unknown'}.`);
  }
}

/** Revalidate at the privileged process boundary, not only in renderer controls. */
export function validateAgentResponse(request: Request, value: unknown): Record<string, unknown> {
  const response = object(value, 'Agent responses must be structured objects.');
  if (request.method === 'item/permissions/requestApproval') {
    const parsed = z
      .object({ permissions: PermissionProfileSchema, scope: z.literal('turn') })
      .strict()
      .parse(response);
    permissionSubset((request.data as any)?.permissions, parsed.permissions);
    return parsed;
  }
  if (request.method === 'item/tool/requestUserInput') {
    const parsed = z
      .object({ answers: z.record(z.object({ answers: z.array(z.string()) }).strict()) })
      .strict()
      .parse(response);
    return buildAgentResponse(
      request,
      'accept',
      Object.fromEntries(Object.entries(parsed.answers).map(([id, answer]) => [id, answer.answers])),
    );
  }
  if (request.method === 'mcpServer/elicitation/request') {
    const parsed = z
      .object({ action: z.enum(['accept', 'decline', 'cancel']), content: z.unknown().optional() })
      .strict()
      .parse(response);
    return buildAgentResponse(request, parsed.action, parsed.content);
  }
  const parsed = z
    .object({ decision: z.enum(['accept', 'decline', 'cancel']) })
    .strict()
    .parse(response);
  return buildAgentResponse(request, parsed.decision);
}
