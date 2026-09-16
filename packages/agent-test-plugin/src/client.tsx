/**
 * Purpose: Display evaluation child-process status in the conversation header.
 * Example: a queued evaluation acquires a PID, reports progress and retains its exit
 * result for inspection. Polling is released when the component unmounts.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { agentTestProcessListSchema } from './processes.js'
import type { AgentTestProcessView } from './types.js'

export function agentTestProcessIsLive(process: AgentTestProcessView): boolean {
  return process.lifecycle !== 'exited'
}

export function agentTestProcessIsActive(
  process: AgentTestProcessView,
  jobsReady: boolean,
  liveJobIds: ReadonlySet<string>,
): boolean {
  return agentTestProcessIsLive(process)
    && (!jobsReady || (process.jobId !== undefined && liveJobIds.has(process.jobId)))
}

export function orderedAgentTestProcesses(
  processes: readonly AgentTestProcessView[],
  isActive: (process: AgentTestProcessView) => boolean = agentTestProcessIsLive,
): AgentTestProcessView[] {
  return [...processes].sort((left, right) => {
    const leftLive = isActive(left)
    const rightLive = isActive(right)
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    if (leftLive) return left.startedAt - right.startedAt
    return (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
  })
}

export function agentTestProcessDisplayStatus(
  process: AgentTestProcessView,
  jobsReady: boolean,
  liveJobIds: ReadonlySet<string>,
): string {
  if (agentTestProcessIsLive(process) && !agentTestProcessIsActive(process, jobsReady, liveJobIds)) {
    return 'stale / aborted'
  }
  if (process.lifecycle === 'exited') return process.testStatus
  return process.lifecycle
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes === 0 ? `${String(remainder)}s` : `${String(minutes)}m ${String(remainder)}s`
}

const styleId = '@mozi-forge/agent-test-plugin/process-panel'
const css = `
.mozi-agent-test-processes{position:relative}
.mozi-agent-test-processes__trigger{min-height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:3px 7px;font:inherit;font-size:12px}
.mozi-agent-test-processes__trigger:hover,.mozi-agent-test-processes__trigger:focus-visible{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2)}
.mozi-agent-test-processes__live{display:inline-block;min-width:17px;margin-left:5px;border-radius:9px;background:var(--dsw-alias-fill-success);color:var(--dsw-alias-label-primary);text-align:center;font-variant-numeric:tabular-nums}
.mozi-agent-test-processes__menu{position:absolute;z-index:100;top:calc(100% + 5px);left:0;box-sizing:border-box;width:460px;max-width:min(460px,calc(100vw - 32px));max-height:min(520px,calc(100vh - 140px));overflow:auto;margin:0;padding:6px;list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3)}
.mozi-agent-test-processes__row{padding:7px 8px;border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12px}
.mozi-agent-test-processes__row+li{border-top:1px solid var(--dsw-alias-border-l2)}
.mozi-agent-test-processes__summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;cursor:pointer;list-style:none}
.mozi-agent-test-processes__summary::-webkit-details-marker{display:none}
.mozi-agent-test-processes__title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono)}
.mozi-agent-test-processes__status{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mozi-agent-test-processes__progress{grid-column:1/-1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.mozi-agent-test-processes__details{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 9px;margin-top:8px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.mozi-agent-test-processes__details dt{color:var(--dsw-alias-label-tertiary)}
.mozi-agent-test-processes__details dd{min-width:0;margin:0;overflow-wrap:anywhere;font-family:var(--dsw-font-mono)}
`

if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(styleId)}]`) === null) {
  const style = document.createElement('style')
  style.dataset.plugin = '@mozi-forge/agent-test-plugin'
  style.dataset.pluginCss = styleId
  style.textContent = css
  document.head.appendChild(style)
}

interface AgentTestProcessActionProps {
  sessionId: SessionId
  rpc: ClientConnectionRpc
  useSessions: <T>(selector: (state: SessionListState) => T, equal?: (left: T, right: T) => boolean) => T
}

export function AgentTestProcessAction({ sessionId, rpc, useSessions }: AgentTestProcessActionProps): JSX.Element | null {
  const [processes, setProcesses] = useState<AgentTestProcessView[]>([])
  const jobs = useSessions(state => state.jobsBySession[sessionId])
  const jobsReady = useSessions(state => state.phase === 'ready')
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const root = useRef<HTMLDivElement>(null)
  const liveJobIds = useMemo(() => new Set((jobs ?? [])
    .filter(job => job.status === 'running' || job.status === 'stopping')
    .map(job => String(job.id))), [jobs])
  const ordered = useMemo(() => orderedAgentTestProcesses(
    processes,
    process => agentTestProcessIsActive(process, jobsReady, liveJobIds),
  ), [processes, jobsReady, liveJobIds])
  const liveCount = useMemo(() => processes.filter(
    process => agentTestProcessIsActive(process, jobsReady, liveJobIds),
  ).length, [processes, jobsReady, liveJobIds])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const refresh = async (): Promise<void> => {
      try {
        const result = await rpc.call(
          '/mozi-agent-tests',
          'processes',
          { sessionId: String(sessionId) },
          controller.signal,
        )
        if (!disposed && result.ok) {
          const parsed = agentTestProcessListSchema.safeParse(result.value)
          if (parsed.success) setProcesses(parsed.data as AgentTestProcessView[])
        }
      } catch {
        // Keep the last stable view while the Host is reconnecting.
      }
      if (!disposed) timer = setTimeout(() => { void refresh() }, 1_000)
    }
    void refresh()
    return () => {
      disposed = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [rpc, sessionId])

  useEffect(() => {
    if (!open || liveCount === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [open, liveCount])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (root.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  if (processes.length === 0) return null
  const label = liveCount > 0 ? `Agent Tests · ${String(liveCount)} running` : `Agent Tests · ${String(processes.length)}`

  return <div className="mozi-agent-test-processes" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape') setOpen(false)
  }}>
    <button
      type="button"
      className="mozi-agent-test-processes__trigger"
      aria-expanded={open}
      aria-label={label}
      onClick={() => setOpen(value => !value)}
    >
      Agent Tests
      {liveCount > 0 ? <span className="mozi-agent-test-processes__live">{liveCount}</span> : null}
    </button>
    {open ? <ul className="mozi-agent-test-processes__menu" aria-label="Agent Test DSH processes">
      {ordered.map(process => {
        const status = agentTestProcessDisplayStatus(process, jobsReady, liveJobIds)
        const duration = formatDuration((process.finishedAt ?? now) - process.startedAt)
        const processAddress = [process.pid === undefined ? undefined : `pid ${String(process.pid)}`, process.port === undefined ? undefined : `127.0.0.1:${String(process.port)}`]
          .filter(value => value !== undefined).join(' · ')
        return <li className="mozi-agent-test-processes__row" key={process.runId}>
          <details>
            <summary className="mozi-agent-test-processes__summary">
              <span className="mozi-agent-test-processes__title">{process.suite} · {process.runId}</span>
              <span className="mozi-agent-test-processes__status">{status} · {duration}</span>
              <span className="mozi-agent-test-processes__progress" title={process.progress}>{processAddress.length === 0 ? process.progress : `${processAddress} · ${process.progress}`}</span>
            </summary>
            <dl className="mozi-agent-test-processes__details">
              <dt>Job</dt><dd>{process.jobId ?? '—'}</dd>
              <dt>PID / port</dt><dd>{processAddress || '—'}</dd>
              <dt>Run root</dt><dd>{process.runRoot}</dd>
              <dt>stdout</dt><dd>{process.stdoutLog}</dd>
              <dt>stderr</dt><dd>{process.stderrLog}</dd>
              <dt>Report</dt><dd>{process.reportPath}</dd>
              <dt>Exit</dt><dd>{process.exitCode === undefined ? '—' : `${String(process.exitCode)} / ${String(process.signalCode ?? 'no signal')}`}</dd>
            </dl>
          </details>
        </li>
      })}
    </ul> : null}
  </div>
}

export const inject = [
  'connection',
  'slots',
]

export function apply(ctx: ClientContext): void {
  // Host and browser entries compile together; narrow the browser service here.
  const rpc = (ctx.connection as unknown as { rpc: ClientConnectionRpc }).rpc
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'agent-test-processes',
    order: 21,
  }, (props: Omit<AgentTestProcessActionProps, 'rpc'>) => (
    <AgentTestProcessAction {...props} rpc={rpc} />
  )))
}
