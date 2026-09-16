/**
 * Purpose: Show generic Markdown requests and save human answers through one RPC.
 * Example: any new request type appears without a type-specific component; answering
 * updates the same JSON record and resumes its owner. Polling is disposed on unmount.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useEffect, useState, type JSX } from 'react'
import Markdown from 'react-markdown'
import type { HumanRequest } from './types.js'
export function RequestDetail({ item, rpc, onChanged }: { item: HumanRequest; rpc: ClientConnectionRpc; onChanged(): void }): JSX.Element {
  const [answer, setAnswer] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await rpc.call('/mozi-human-requests', 'respond', { id: item.id, body: answer })
      if (!result.ok) throw new Error(result.error.message)
      onChanged()
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <article style={{ padding: 20, minWidth: 0, overflowWrap: 'anywhere' }}>
    <h2>{item.title}</h2><p>{item.type} · {item.createdAt}</p>
    <Markdown>{item.body}</Markdown>
    {item.response ? <><h3>人工答复</h3><Markdown>{item.response.body}</Markdown></> : <>
      <p><button onClick={() => setAnswer(item.type === 'training-merge' ? '批准合入本次修改。' : item.type === 'test-review' ? '通过验收' : '同意，请继续。')}>同意</button> <button onClick={() => setAnswer('请调整：')}>请调整</button></p>
      <textarea aria-label="人工答复" style={{ width: '100%', minHeight: 100 }} value={answer} onChange={e => setAnswer(e.currentTarget.value)} />
      <button disabled={busy || !answer.trim()} onClick={() => void submit()}>提交答复</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </article>
}
export function HumanRequestView({ rpc }: { rpc: ClientConnectionRpc }): JSX.Element {
  const [items, setItems] = useState<HumanRequest[]>([]), [selected, setSelected] = useState(''), [status, setStatus] = useState('pending'), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const result = await rpc.call('/mozi-human-requests', 'list', { status })
        if (!result.ok) throw new Error(result.error.message)
        if (!disposed) { setItems(result.value as HumanRequest[]); setError('') }
      } catch (e) { if (!disposed) setError(String(e)) }
    }
    void load(); const timer = setInterval(() => void load(), 3000)
    return () => { disposed = true; clearInterval(timer) }
  }, [rpc, status, refresh])
  const active = items.find(i => i.id === selected) ?? items[0]
  return <section style={{ height: '100%', overflow: 'auto' }}>
    <select aria-label="需求状态" value={status} onChange={e => setStatus(e.currentTarget.value)}><option value="pending">待处理</option><option value="answered">已答复</option></select>
    {error && <p role="alert">{error}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap' }}><nav style={{ flex: '1 1 220px' }}>
      {items.map(item => <button key={item.id} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 12 }} onClick={() => setSelected(item.id)}>{item.title}<small style={{ display: 'block' }}>{item.type} · {item.createdAt}</small></button>)}
      {!items.length && <p>暂无需求</p>}
    </nav><div style={{ flex: '3 1 400px', minWidth: 0 }}>{active && <RequestDetail key={active.id + active.status} item={active} rpc={rpc} onChanged={() => setRefresh(n => n + 1)} />}</div></div>
  </section>
}
export const inject = ['connection', 'slots']
export function apply(ctx: ClientContext): void {
  const rpc = (ctx.connection as unknown as { rpc: ClientConnectionRpc }).rpc
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'human-requests', order: 20, label: '人类需求' }, () => <HumanRequestView rpc={rpc} />))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'session-identity', order: -20 }, ({ sessionId }: { sessionId: SessionId }) => <small>{String(sessionId)}</small>))
}
