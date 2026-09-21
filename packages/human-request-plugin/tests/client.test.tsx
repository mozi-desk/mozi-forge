/** Render generic Markdown through the public React component for any request type. */
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HumanRequestView, RequestDetail } from '../src/client.js'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
it('renders Markdown and a single response form for an unfamiliar type', () => {
  const markup = renderToStaticMarkup(<RequestDetail item={{ id: 'one', type: 'future-review', sessionId: 'session', title: 'Question', body: '# Evidence\n**Actual output**\n<script>bad()</script>', status: 'pending', createdAt: '2026-09-14' }} rpc={{} as ClientConnectionRpc} onChanged={() => undefined} />)
  expect(markup).toContain('<h1>Evidence</h1>')
  expect(markup).toContain('<strong>Actual output</strong>')
  expect(markup).not.toContain('<script>')
  expect(markup).toContain('Submit response')
})

import { en, zh } from '../src/locales.js'
it.each([{ dict: en, submit: 'Submit response', pending: 'Pending', empty: 'No requests' },
  { dict: zh, submit: '提交答复', pending: '待处理', empty: '暂无需求' }])('renders request controls in $pending locale', ({ dict, submit, pending, empty }) => {
  const t = (key: keyof typeof en) => dict[key]
  const rpc = {} as ClientConnectionRpc
  const view = renderToStaticMarkup(<HumanRequestView rpc={rpc} t={t} />)
  expect(view).toContain(pending)
  expect(view).toContain(empty)
  expect(view).toContain(`aria-label="${dict.status}"`)
  const item = { id: 'one', type: 'future-review', sessionId: 'session', title: 'Original title', body: '原始需求正文', status: 'pending' as const, createdAt: '2026-09-14' }
  const detail = renderToStaticMarkup(<RequestDetail item={item} rpc={rpc} t={t} onChanged={() => undefined} />)
  expect(detail).toContain(submit)
  expect(detail).toContain(dict.approve)
  expect(detail).toContain(dict.adjust)
  expect(detail).toContain('原始需求正文')
  const answered = renderToStaticMarkup(<RequestDetail item={{ ...item, status: 'answered', response: { body: 'Original answer', answeredAt: '2026-09-15' } }} rpc={rpc} t={t} onChanged={() => undefined} />)
  expect(answered).toContain(dict.response)
  expect(answered).toContain('Original answer')
  expect(answered).not.toContain('<textarea')
})
