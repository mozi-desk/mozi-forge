/**
 * Purpose: Define native model-visible session query schemas and service validation.
 * Example: a negative event offset fails before any evidence file is opened.
 * Cursors are opaque and bind the complete request to a frozen revision.
 */
import { validateArgs } from '@deepseek-ai/dsh-tools'
export const inspectParameters = {
  session_id: { type: 'string', required: true, description: 'Exact session ID in the current Harness runtime.' }, refresh: { type: 'boolean' },
} as const
export const queryParameters = {
  session_id: { type: 'string', required: true, description: 'Exact session ID in the current Harness runtime.' }, revision: { type: 'string', required: true, description: 'Frozen revision returned by session_inspect.' },
  kind: { type: 'string', enum: ['turn', 'step', 'tool', 'event'] },
  from: { type: 'integer', description: 'Inclusive event sequence lower bound, not a turn number.' }, through: { type: 'integer', description: 'Inclusive event sequence upper bound.' },
  signal: { type: 'string', enum: ['high-tokens', 'tool-failure', 'suspected-error', 'incomplete-tool', 'suspected-loop', 'large-output', 'long-running'] },
  tool: { type: 'string' }, query: { type: 'string', description: 'Literal text in evidence, not a regular expression.' },
  sort: { type: 'string', enum: ['sequence', 'tokens', 'elapsed', 'output'] }, cursor: { type: 'string', description: 'Returned nextCursor; keep all other request parameters unchanged.' },
} as const
export const readParameters = {
  session_id: { type: 'string', required: true, description: 'Exact session ID in the current Harness runtime.' }, revision: { type: 'string', required: true, description: 'Frozen revision returned by session_inspect.' },
  from: { type: 'integer', required: true, description: 'Existing inclusive event endpoint returned by query.' }, through: { type: 'integer', required: true, description: 'Existing inclusive event endpoint at or after from.' },
  view: { type: 'string', enum: ['focused', 'raw'] }, cursor: { type: 'string', description: 'Returned nextCursor; keep all other request parameters unchanged.' },
} as const
/** Validate at the service boundary as well as Harness execution, before I/O. */
export function validate(parameters: typeof inspectParameters | typeof queryParameters | typeof readParameters, input: unknown): void {
  const issues = validateArgs({ input: { type: 'object', required: true, additionalProperties: false, properties: parameters } }, { input })
  if (issues.length) throw new Error(`INVALID_SESSION_INPUT: ${issues.join('; ')}`)
  const row = input as Record<string, unknown>
  for (const key of ['session_id', 'revision', 'query', 'tool', 'cursor']) if (row[key] !== undefined && (!(row[key] as string).trim() || (row[key] as string).length > 2048)) throw new Error(`INVALID_SESSION_INPUT: ${key} must be nonempty and at most 2048 characters`)
  for (const key of ['from', 'through']) if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) throw new Error(`INVALID_SESSION_INPUT: ${key} must be a nonnegative safe integer`)
  if (row.from !== undefined && row.through !== undefined && Number(row.from) > Number(row.through)) throw new Error('INVALID_SESSION_INPUT: through must be at least from')
}
