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
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type RequestTranslate } from './locales.js'
import type { HumanRequest } from './types.js'
export function RequestDetail({ item, rpc, onChanged, t = key => en[key] }: { item: HumanRequest; rpc: ClientConnectionRpc; onChanged(): void; t?: RequestTranslate }): JSX.Element {
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
    {item.response ? <><h3>{t('response')}</h3><Markdown>{item.response.body}</Markdown></> : <>
      <p><button onClick={() => setAnswer(t(item.type === 'training-merge' ? 'approveMerge' : item.type === 'test-review' ? 'approveTest' : 'approveContinue'))}>{t('approve')}</button> <button onClick={() => setAnswer(t('adjustReply'))}>{t('adjust')}</button></p>
      <textarea aria-label={t('response')} style={{ width: '100%', minHeight: 100 }} value={answer} onChange={e => setAnswer(e.currentTarget.value)} />
      <button disabled={busy || !answer.trim()} onClick={() => void submit()}>{t('submit')}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </article>
}
export function HumanRequestView({ rpc, t = key => en[key] }: { rpc: ClientConnectionRpc; t?: RequestTranslate }): JSX.Element {
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
    <select aria-label={t('status')} value={status} onChange={e => setStatus(e.currentTarget.value)}><option value="pending">{t('pending')}</option><option value="answered">{t('answered')}</option></select>
    {error && <p role="alert">{error}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap' }}><nav style={{ flex: '1 1 220px' }}>
      {items.map(item => <button key={item.id} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 12 }} onClick={() => setSelected(item.id)}>{item.title}<small style={{ display: 'block' }}>{item.type} · {item.createdAt}</small></button>)}
      {!items.length && <p>{t('empty')}</p>}
    </nav><div style={{ flex: '3 1 400px', minWidth: 0 }}>{active && <RequestDetail t={t} key={active.id + active.status} item={active} rpc={rpc} onChanged={() => setRefresh(n => n + 1)} />}</div></div>
  </section>
}
export const inject = ['connection', 'slots', 'locale']
export function apply(ctx: ClientContext): void {
  const rpc = (ctx.connection as unknown as { rpc: ClientConnectionRpc }).rpc
  ctx.effect(() => ctx.locale.register('mozi-human-requests', 'en', en))
  ctx.effect(() => ctx.locale.register('mozi-human-requests', 'zh', zh))
  const t = ctx.locale.bind('mozi-human-requests')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'human-requests', order: 20, locale: 'mozi-human-requests', label: () => t('title') }, ({ t }: { t: RequestTranslate }) => <HumanRequestView rpc={rpc} t={t} />))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'session-identity', order: -20 }, ({ sessionId }: { sessionId: SessionId }) => <small>{String(sessionId)}</small>))
}
