import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { BrailleSpinner } from '@/components/ui/braille-spinner'
import { FadeText } from '@/components/ui/fade-text'
import {
  Activity,
  AlertCircle,
  Layers3,
  Loader2,
  type LucideIcon,
  RefreshCw,
  Sparkles
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $desktopActionTasks, buildRailTasks, type RailTask, type RailTaskStatus } from '@/store/activity'
import { $previewServerRestart } from '@/store/preview'
import { $activeSessionId, $sessions, $workingSessionIds } from '@/store/session'
import {
  $subagentsBySession,
  buildSubagentTree,
  type SubagentNode,
  type SubagentStatus,
  type SubagentStreamEntry
} from '@/store/subagents'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { OverlayMain, OverlayNavItem, OverlaySidebar, OverlaySplitLayout } from '../overlays/overlay-split-layout'
import { OverlayView } from '../overlays/overlay-view'

type AgentsSection = 'tree' | 'activity' | 'history'

interface SectionDef {
  description: string
  icon: LucideIcon
  id: AgentsSection
  label: string
}

const SECTIONS: readonly SectionDef[] = [
  { description: 'Live subagent spawn tree for the current turn', icon: Layers3, id: 'tree', label: 'Spawn tree' },
  { description: 'Background work across sessions and the desktop', icon: Activity, id: 'activity', label: 'Activity' },
  { description: 'Past spawn snapshots, replay, and diff', icon: RefreshCw, id: 'history', label: 'History' }
]

const SECTION_IDS = SECTIONS.map(s => s.id) as readonly AgentsSection[]

const RAIL_TONE: Record<RailTaskStatus, string> = {
  error: 'text-destructive',
  running: 'text-foreground',
  success: 'text-emerald-500'
}

const RAIL_ICON: Record<RailTaskStatus, LucideIcon> = {
  error: AlertCircle,
  running: Loader2,
  success: Sparkles
}

const STATUS_GLYPH: Record<SubagentStatus, string> = {
  completed: '✓',
  failed: '✗',
  interrupted: '■',
  queued: '○',
  running: '●'
}

const STREAM_GLYPH: Record<SubagentStreamEntry['kind'], string> = {
  progress: '·',
  summary: '✓',
  thinking: '💭',
  tool: '●'
}

const STREAM_TONE: Record<SubagentStreamEntry['kind'], string> = {
  progress: 'text-muted-foreground/75',
  summary: 'text-foreground/85',
  thinking: 'text-muted-foreground/80',
  tool: 'text-foreground/85'
}

interface AgentsViewProps {
  initialSection?: AgentsSection
  onClose: () => void
}

export function AgentsView({ initialSection = 'tree', onClose }: AgentsViewProps) {
  const [section, setSection] = useRouteEnumParam('section', SECTION_IDS, initialSection)

  const activeSessionId = useStore($activeSessionId)
  const sessions = useStore($sessions)
  const workingSessionIds = useStore($workingSessionIds)
  const previewRestart = useStore($previewServerRestart)
  const desktopActionTasks = useStore($desktopActionTasks)
  const subagentsBySession = useStore($subagentsBySession)

  const activityTasks = useMemo(
    () => buildRailTasks(workingSessionIds, sessions, previewRestart, desktopActionTasks),
    [desktopActionTasks, previewRestart, sessions, workingSessionIds]
  )

  const active = SECTIONS.find(s => s.id === section) ?? SECTIONS[0]!

  const activeSubagents = useMemo(
    () => (activeSessionId ? (subagentsBySession[activeSessionId] ?? []) : []),
    [activeSessionId, subagentsBySession]
  )

  const tree = useMemo(() => buildSubagentTree(activeSubagents), [activeSubagents])

  return (
    <OverlayView closeLabel="Close agents" onClose={onClose}>
      <OverlaySplitLayout>
        <OverlaySidebar>
          {SECTIONS.map(s => (
            <OverlayNavItem
              active={s.id === section}
              icon={s.icon}
              key={s.id}
              label={s.label}
              onClick={() => setSection(s.id)}
            />
          ))}
        </OverlaySidebar>

        <OverlayMain>
          <header className="mb-4">
            <h2 className="text-sm font-semibold text-foreground">{active.label}</h2>
            <p className="text-xs text-muted-foreground">{active.description}</p>
          </header>

          {section === 'tree' ? (
            <SubagentTree tree={tree} />
          ) : section === 'activity' ? (
            <ActivityList tasks={activityTasks} />
          ) : (
            <SectionStub label={active.label} />
          )}
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}

const fmtDuration = (seconds?: number) => {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `${seconds.toFixed(1)}s`

  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)

  return `${m}m ${s}s`
}

const fmtTokens = (value?: number) => {
  if (!value) return ''

  return value >= 1000 ? `${(value / 1000).toFixed(1)}k tok` : `${value} tok`
}

const fmtAge = (updatedAt: number, nowMs: number) => {
  const s = Math.max(0, Math.round((nowMs - updatedAt) / 1000))
  if (s < 2) return 'now'
  if (s < 60) return `${s}s ago`

  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`

  return `${Math.floor(m / 60)}h ago`
}

const flatten = (nodes: readonly SubagentNode[]): SubagentNode[] =>
  nodes.flatMap(node => [node, ...flatten(node.children)])

interface RootGroup {
  id: string
  label: string
  nodes: SubagentNode[]
  taskCount: number
}

function groupDelegations(roots: readonly SubagentNode[]): RootGroup[] {
  const groups: RootGroup[] = []
  let n = 0

  for (const node of roots) {
    const prev = groups.at(-1)
    const prevTail = prev?.nodes.at(-1)
    const closeInTime = prevTail ? Math.abs(node.startedAt - prevTail.startedAt) <= 5_000 : false
    const sameShape = prev && node.taskCount > 1 && prev.taskCount === node.taskCount
    const uniqueStep = prev ? !prev.nodes.some(item => item.taskIndex === node.taskIndex) : false

    if (prev && sameShape && closeInTime && uniqueStep) {
      prev.nodes.push(node)
      continue
    }

    if (node.taskCount > 1) {
      n += 1
      groups.push({ id: `delegation-${n}`, label: `Delegation ${n}`, nodes: [node], taskCount: node.taskCount })
      continue
    }

    groups.push({ id: node.id, label: '', nodes: [node], taskCount: node.taskCount })
  }

  return groups
}

function SubagentTree({ tree }: { tree: SubagentNode[] }) {
  const flat = useMemo(() => flatten(tree), [tree])
  const groups = useMemo(() => groupDelegations(tree), [tree])
  const [nowMs, setNowMs] = useState(() => Date.now())

  const active = flat.filter(n => n.status === 'running' || n.status === 'queued').length
  const failed = flat.filter(n => n.status === 'failed' || n.status === 'interrupted').length
  const tools = flat.reduce((sum, n) => sum + (n.toolCount ?? 0), 0)
  const files = flat.reduce((sum, n) => sum + n.filesRead.length + n.filesWritten.length, 0)
  const tokens = flat.reduce((sum, n) => sum + (n.inputTokens ?? 0) + (n.outputTokens ?? 0), 0)
  const cost = flat.reduce((sum, n) => sum + (n.costUsd ?? 0), 0)

  useEffect(() => {
    if (active <= 0 || typeof window === 'undefined') return

    const id = window.setInterval(() => setNowMs(Date.now()), 500)

    return () => window.clearInterval(id)
  }, [active])

  if (tree.length === 0) {
    return (
      <div className="grid place-items-center gap-3 py-12 text-center">
        <Sparkles className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground/90">No live subagents</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground/75">
          When a turn delegates work, child agents stream their progress here.
        </p>
      </div>
    )
  }

  const summary = [
    `${flat.length} ${flat.length === 1 ? 'agent' : 'agents'}`,
    active > 0 ? `${active} active` : '',
    failed > 0 ? `${failed} failed` : '',
    tools > 0 ? `${tools} tools` : '',
    files > 0 ? `${files} files` : '',
    tokens > 0 ? fmtTokens(tokens) : '',
    cost > 0 ? `$${cost.toFixed(2)}` : ''
  ].filter(Boolean)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
      <p className="shrink-0 text-[0.7rem] text-muted-foreground/70">{summary.join(' · ')}</p>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map(group => (
            <DelegationGroup group={group} key={group.id} nowMs={nowMs} />
          ))}
        </div>
      </div>
    </div>
  )
}

function DelegationGroup({ group, nowMs }: { group: RootGroup; nowMs: number }) {
  if (group.nodes.length === 1 && group.taskCount <= 1) {
    return <SubagentRow node={group.nodes[0]!} nowMs={nowMs} />
  }

  const activeWorkers = group.nodes.filter(n => n.status === 'running' || n.status === 'queued').length

  return (
    <section className="grid min-w-0 gap-3">
      <p className="text-[0.66rem] font-medium uppercase tracking-wider text-muted-foreground/70">
        {group.label} <span className="text-muted-foreground/50">·</span> {group.nodes.length} workers
        {activeWorkers > 0 ? <span className="text-primary/85"> · {activeWorkers} active</span> : null}
      </p>
      <div className="grid min-w-0 gap-4">
        {group.nodes.map(node => (
          <SubagentRow key={node.id} node={node} nowMs={nowMs} />
        ))}
      </div>
    </section>
  )
}

function StreamLine({ active, entry }: { active: boolean; entry: SubagentStreamEntry }) {
  const isMono = entry.kind === 'tool'
  const tone = entry.isError ? 'text-destructive' : STREAM_TONE[entry.kind]

  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[0.72rem] leading-relaxed">
      <span className={cn('shrink-0 text-[0.65rem]', tone)}>{STREAM_GLYPH[entry.kind]}</span>
      <span className={cn('min-w-0 flex-1 wrap-anywhere', tone, isMono && 'font-mono text-[0.69rem]')}>
        {entry.text}
        {active ? (
          <span className="ml-1 inline-block h-2.5 w-0.5 animate-pulse rounded-sm bg-primary/75 align-middle" />
        ) : null}
      </span>
    </div>
  )
}

function SubagentRow({ node, depth = 0, nowMs }: { node: SubagentNode; depth?: number; nowMs: number }) {
  const running = node.status === 'running' || node.status === 'queued'
  const elapsed = useElapsedSeconds(running, `subagent:${node.id}`)
  const durationSeconds =
    typeof node.durationSeconds === 'number' ? Math.max(0, Math.round(node.durationSeconds)) : elapsed
  const [open, setOpen] = useState(() => running || depth < 2)

  useEffect(() => {
    if (running) setOpen(true)
  }, [running])

  const visibleRows = open ? node.stream.slice(-10) : node.stream.slice(-2)
  const fileLines = [...node.filesWritten.map(p => `+ ${p}`), ...node.filesRead.map(p => `· ${p}`)]

  const subtitle = [
    node.model,
    fmtDuration(durationSeconds),
    node.toolCount ? `${node.toolCount} tools` : '',
    fmtTokens((node.inputTokens ?? 0) + (node.outputTokens ?? 0)),
    `updated ${fmtAge(node.updatedAt, nowMs)}`
  ].filter(Boolean)

  return (
    <div className={cn('grid min-w-0 max-w-full gap-2', depth > 0 && 'pl-4')}>
      <button
        aria-expanded={open}
        className="group flex w-full min-w-0 items-start gap-2.5 text-left"
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        <span
          className={cn(
            'mt-1 flex size-4 shrink-0 items-center justify-center text-[0.82rem] leading-none',
            running
              ? 'text-primary'
              : node.status === 'failed' || node.status === 'interrupted'
                ? 'text-destructive'
                : node.status === 'completed'
                  ? 'text-emerald-500'
                  : 'text-muted-foreground/70'
          )}
        >
          {running ? (
            <BrailleSpinner ariaLabel="Running" className="text-[0.82rem]" spinner="breathe" />
          ) : (
            STATUS_GLYPH[node.status]
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <FadeText
            className={cn(
              'wrap-anywhere text-[0.84rem] font-medium leading-snug text-foreground/95 transition-colors group-hover:text-foreground',
              running && 'text-foreground/85'
            )}
          >
            {node.goal}
          </FadeText>
          {subtitle.length > 0 ? (
            <FadeText className="text-[0.66rem] leading-snug text-muted-foreground/65">{subtitle.join(' · ')}</FadeText>
          ) : null}
        </span>
        {running ? <ActivityTimerText className="mt-1 shrink-0 text-[0.6rem]" seconds={durationSeconds} /> : null}
      </button>

      {visibleRows.length > 0 ? (
        <div className="grid min-w-0 gap-1 pl-7">
          {visibleRows.map((entry, i) => (
            <StreamLine
              active={running && i === visibleRows.length - 1}
              entry={entry}
              key={`${entry.kind}:${entry.at}:${i}`}
            />
          ))}
        </div>
      ) : null}

      {open && fileLines.length > 0 ? (
        <div className="grid min-w-0 gap-0.5 pl-7">
          <p className="text-[0.58rem] font-medium tracking-wider text-muted-foreground/60 uppercase">Files</p>
          {fileLines.slice(0, 8).map(line => (
            <p className="wrap-break-word font-mono text-[0.67rem] leading-relaxed text-muted-foreground/80" key={line}>
              {line}
            </p>
          ))}
          {fileLines.length > 8 ? (
            <p className="font-mono text-[0.67rem] leading-relaxed text-muted-foreground/65">
              +{fileLines.length - 8} more files
            </p>
          ) : null}
        </div>
      ) : null}

      {node.children.length > 0 ? (
        <div className="grid min-w-0 gap-3 pl-7">
          {node.children.map(child => (
            <SubagentRow depth={depth + 1} key={child.id} node={child} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ActivityList({ tasks }: { tasks: readonly RailTask[] }) {
  if (tasks.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground/75">
        No background activity. Long-running tools, preview restarts, and parallel sessions surface here.
      </p>
    )
  }

  return (
    <div className="grid min-h-0 gap-2 overflow-y-auto pr-1">
      {tasks.map(task => {
        const Icon = RAIL_ICON[task.status]

        return (
          <div className="flex items-start gap-2.5" key={task.id}>
            <Icon
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                RAIL_TONE[task.status],
                task.status === 'running' && 'animate-spin'
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground/90">{task.label}</div>
              {task.detail ? <div className="truncate text-xs text-muted-foreground/75">{task.detail}</div> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SectionStub({ label }: { label: string }) {
  return (
    <div className="grid place-items-center gap-3 py-12 text-center">
      <Sparkles className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium text-foreground/90">{label} — coming soon</p>
    </div>
  )
}
