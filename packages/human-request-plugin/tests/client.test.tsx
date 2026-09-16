/** Render generic Markdown through the public React component for any request type. */
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { RequestDetail } from '../src/client.js'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
it('renders Markdown and a single response form for an unfamiliar type', () => {
  const markup = renderToStaticMarkup(<RequestDetail item={{ id: 'one', type: 'future-review', sessionId: 'session', title: 'Question', body: '# Evidence\n**Actual output**\n<script>bad()</script>', status: 'pending', createdAt: '2026-09-14' }} rpc={{} as ClientConnectionRpc} onChanged={() => undefined} />)
  expect(markup).toContain('<h1>Evidence</h1>')
  expect(markup).toContain('<strong>Actual output</strong>')
  expect(markup).not.toContain('<script>')
  expect(markup).toContain('提交答复')
})
