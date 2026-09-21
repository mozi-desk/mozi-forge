/** Localize host-generated request instructions while preserving authored Markdown. */
import type { HumanRequest } from './types.js'
import type { RequestTranslate } from './locales.js'
export function presentRequest(item: HumanRequest, t: RequestTranslate): { title: string; body: string } {
  let { title, body } = item
  if (item.type === 'test-review') {
    title = title.replace(/^(?:验收|Review) /u, `${t('reviewTitle')} `)
    for (const instruction of ['Choose Approve or Request changes, then submit your decision.', '请答复“通过验收”或“未通过：原因”。', 'Reply “Acceptance passed.” or “Changes requested: reason”.']) {
      if (body.endsWith(`\n\n${instruction}`)) body = body.slice(0, -instruction.length) + t('reviewInstruction')
    }
  }
  return { title, body }
}
