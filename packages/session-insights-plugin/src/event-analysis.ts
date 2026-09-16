/**
 * Purpose: Classify tool results using structured errors, exit codes and textual hints.
 * Example: a shell result with exitCode=2 is a failure; an unflagged "error: ..."
 * string is a suspected error only. Tool output remains evidence, never instructions.
 */
type Event = Record<string, unknown>

function record(value: unknown): Event {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Event : {}
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) current = record(current)[key]
  return current
}

function texts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(texts)
  if (value === null || typeof value !== 'object') return []
  const row = value as Record<string, unknown>
  return [
    ...(typeof row.text === 'string' ? [row.text] : []),
    ...(typeof row.content === 'string' ? [row.content] : texts(row.content)),
    ...texts(row.message),
  ]
}

/** Read only outcome-bearing fields; textual hints remain separate from confirmed failures. */
export function toolResultState(event: Event): { failed: boolean; suspectedError: boolean } {
  const data = record(event.data)
  const structuredError = data.error
  const blocksValue = nested(data, 'message', 'content')
  const blocks = Array.isArray(blocksValue) ? blocksValue : []
  const isError = blocks.some(blockValue => {
    const block = record(blockValue)
    return block.isError === true || (Array.isArray(block.content) && block.content.some(item => record(item).isError === true))
  })
  const output = texts(blocksValue).join('\n')
  // Shell adapters may encode their structured result in a text block.
  const exitFailure = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(exitFailure)
    if (!value || typeof value !== 'object') return false
    const row = value as Event
    if (typeof row.exitCode === 'number' && row.exitCode !== 0) return true
    return ['content', 'message', 'result', 'output'].some(key => exitFailure(row[key]))
  }
  const nonzeroExit = exitFailure(data) || texts(blocksValue).some(text => { try { return exitFailure(JSON.parse(text)) } catch { return false } })
  const textError = /^\s*(?:error|failed):/iu.test(output)
  const failed = structuredError != null || isError || nonzeroExit
  return { failed, suspectedError: !failed && textError }
}
