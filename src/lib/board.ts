import chalk from 'chalk'
import type { Config, DisplayTheme } from '../config/schema.js'
import type { WorkflowStep } from './workflow.js'

// ── Types ────────────────────────────────────────────────────────────────────

type ChalkFn = (s: string) => string

interface Theme {
  spinner: ChalkFn
  success: ChalkFn
  warning: ChalkFn
  error: ChalkFn
  dim: ChalkFn
  accent: ChalkFn
  barPRFill: ChalkFn
  barEmpty: ChalkFn
  barCRApprove: ChalkFn
  barCRNeedsWork: ChalkFn
  barCRBlock: ChalkFn
  barFixFill: ChalkFn
  separator: ChalkFn
}

interface PRSlot {
  prNumber: number
  repo: string
  branch: string
  label: string
  startedAt: number
  prLoc?: number
  verdict?: string | null
  commentCount?: number
  fixCount?: number
}

export interface PRUpdate {
  label?: string
  prLoc?: number
  verdict?: string | null
  commentCount?: number
  fixCount?: number  // set via onPhaseChange after address step
}

export interface PRCompletionData {
  elapsedMs: number
  url: string
}

interface Stats {
  prsReceived: number
  crsCompleted: number
  fixesApplied: number
  crTotalMs: number
  sessionStart: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BAR_FILLED = '█'
const BAR_EMPTY = '░'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Strip ANSI escape codes for visible-width calculations
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function makeBar(filled: number, total: number, fillFn: ChalkFn, emptyFn: ChalkFn): string {
  const f = Math.max(0, Math.min(total, Math.round(filled)))
  return fillFn(BAR_FILLED.repeat(f)) + emptyFn(BAR_EMPTY.repeat(total - f))
}

function locToFilled(loc: number): number {
  if (loc <= 0) return 0
  if (loc <= 10) return 1
  if (loc <= 50) return 2
  if (loc <= 150) return 3
  if (loc <= 300) return 5
  if (loc <= 600) return 6
  if (loc <= 1000) return 7
  if (loc <= 2000) return 8
  if (loc <= 4000) return 9
  return 10
}

function commentCountToFilled(n: number): number {
  if (n === 0) return 0
  if (n <= 2) return 2
  if (n <= 5) return 3
  if (n <= 9) return 4
  if (n <= 14) return 5
  if (n <= 20) return 6
  if (n <= 30) return 7
  return 8
}

function fixCountToFilled(n: number): number {
  if (n === 0) return 0
  if (n === 1) return 1
  if (n <= 3) return 2
  if (n <= 6) return 3
  if (n <= 10) return 4
  if (n <= 20) return 5
  return 6
}

function resolveColor(spec: string): ChalkFn {
  if (spec === 'dim') return chalk.dim
  if (spec === 'bold') return chalk.bold
  if (spec.startsWith('#')) return chalk.hex(spec)
  const method = (chalk as unknown as Record<string, unknown>)[spec]
  if (typeof method === 'function') return method as ChalkFn
  return chalk.white
}

function buildTheme(cfg: DisplayTheme): Theme {
  const empty = resolveColor(cfg.bar_empty)
  return {
    spinner: chalk.greenBright,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    dim: chalk.dim,
    accent: chalk.cyan,
    barPRFill: resolveColor(cfg.bar_fill),
    barEmpty: empty,
    barCRApprove: resolveColor(cfg.cr_approve),
    barCRNeedsWork: resolveColor(cfg.cr_needs_work),
    barCRBlock: resolveColor(cfg.cr_block),
    barFixFill: resolveColor(cfg.fix_fill),
    separator: chalk.dim,
  }
}

// ── PRBoard ───────────────────────────────────────────────────────────────────

const CONN_LOG_MAX = 6  // max connectivity log lines kept in memory

export class PRBoard {
  private slots = new Map<string, PRSlot>()
  private frameIdx = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private liveLines = 0
  private liveContent = ''
  private readonly isTTY: boolean = Boolean(process.stdout.isTTY)
  private connLog: string[] = []

  private stats: Stats = {
    prsReceived: 0,
    crsCompleted: 0,
    fixesApplied: 0,
    crTotalMs: 0,
    sessionStart: Date.now(),
  }

  private tunnel: { type: string; url: string | null; alive: boolean } = {
    type: 'none', url: null, alive: false,
  }

  private config: Config | null = null
  private steps: WorkflowStep[] = []
  private theme: Theme = buildTheme({
    bar_fill: 'blue', bar_empty: 'dim',
    cr_approve: 'green', cr_needs_work: 'yellow', cr_block: 'red',
    fix_fill: 'cyan',
  })

  // ── Public API ─────────────────────────────────────────────────────────────

  setConfig(config: Config, steps: WorkflowStep[]): void {
    this.config = config
    this.steps = steps
    this.theme = buildTheme(config.display.theme)
  }

  setTunnel(type: string, url: string | null, alive: boolean): void {
    this.tunnel = { type, url, alive }
  }

  start(): void {
    if (!this.isTTY) return
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length
      this.redraw()
    }, 80)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.eraseLive()
  }

  addPR(key: string, prNumber: number, repo: string, branch: string): void {
    this.slots.set(key, { prNumber, repo, branch, label: 'cloning...', startedAt: Date.now() })
    this.stats.prsReceived++
  }

  updatePR(key: string, updates: PRUpdate): void {
    const slot = this.slots.get(key)
    if (!slot) return
    if (updates.label !== undefined) slot.label = updates.label
    if (updates.prLoc !== undefined) slot.prLoc = updates.prLoc
    if (updates.verdict !== undefined) slot.verdict = updates.verdict
    if (updates.commentCount !== undefined) slot.commentCount = updates.commentCount
    if (updates.fixCount !== undefined) slot.fixCount = updates.fixCount
  }

  completePR(key: string, data: PRCompletionData): void {
    const slot = this.slots.get(key)
    this.slots.delete(key)

    // Pull accumulated data from the slot (set via updatePR/onPhaseChange during workflow)
    const verdict = slot?.verdict ?? null
    const commentCount = slot?.commentCount ?? 0
    const fixCount = slot?.fixCount ?? 0

    if (verdict !== null) {
      this.stats.crsCompleted++
      this.stats.crTotalMs += data.elapsedMs
    }
    if (fixCount > 0) this.stats.fixesApplied++

    if (slot) {
      const t = this.theme
      const ts = new Date().toLocaleTimeString()
      const indent = ' '.repeat(ts.length + 2)
      const elapsed = `(${Math.round(data.elapsedMs / 1000)}s)`

      // line 1
      const badge = this.verdictBadge(verdict)
      const branch = truncate(slot.branch, 22)
      const line1 = `${t.dim(ts)}  ${badge}  #${slot.prNumber}  ${chalk.dim(slot.repo)}  ${t.dim(branch)}  ${t.dim(elapsed)}  ${t.dim('→')} ${t.accent(data.url)}`

      // line 2 — data summary
      const parts: string[] = []
      if (slot.prLoc !== undefined) {
        parts.push(`PR ${makeBar(locToFilled(slot.prLoc), 10, t.barPRFill, t.barEmpty)} ${t.dim(String(slot.prLoc) + 'loc')}`)
      }
      if (verdict !== null) {
        const crFill = this.crFillFn(verdict)
        const crLabel = this.crLabelFn(verdict)
        parts.push(`CR ${makeBar(commentCountToFilled(commentCount), 8, crFill, t.barEmpty)} ${crLabel(verdict)} ·${commentCount}`)
      }
      if (fixCount > 0) {
        parts.push(`FIX ${makeBar(fixCountToFilled(fixCount), 6, t.barFixFill, t.barEmpty)} ${t.accent(String(fixCount) + ' applied')}`)
      } else if (verdict !== null && verdict !== 'APPROVE') {
        parts.push(`FIX ${t.dim('skipped')}`)
      }

      const line2 = parts.length > 0 ? indent + parts.join('   ') : ''
      this.printStatic(line2 ? `${line1}\n${line2}` : line1)
    }
  }

  failPR(key: string, error: string): void {
    const slot = this.slots.get(key)
    this.slots.delete(key)
    if (slot) {
      const ts = new Date().toLocaleTimeString()
      this.printStatic(`${chalk.dim(ts)}  PR #${slot.prNumber}  ${chalk.red('✗')} ${error}`)
    }
  }

  /** Print 1–2 static lines to scrollback (above the live block). */
  log(line1: string, line2?: string): void {
    this.printStatic(line2 ? `${line1}\n${line2}` : line1)
  }

  /** Record a connectivity event in the live section (tunnel/webhook events). */
  logConnectivity(line: string): void {
    const ts = chalk.dim(new Date().toLocaleTimeString())
    this.connLog.push(`  ${ts}  ${line}`)
    if (this.connLog.length > CONN_LOG_MAX) this.connLog.shift()
  }

  // ── Private: display ───────────────────────────────────────────────────────

  private printStatic(content: string): void {
    this.eraseLive()
    process.stdout.write(content + '\n')
  }

  private countRenderedLines(content: string, columns: number): number {
    const w = columns || 80
    return content.split('\n').reduce((sum, line) => {
      return sum + Math.max(1, Math.ceil(stripAnsi(line).length / w))
    }, 0)
  }

  private eraseLive(): void {
    if (this.liveLines > 0 && this.isTTY) {
      // Recompute against current width in case terminal was resized since last write
      const lines = this.countRenderedLines(this.liveContent, process.stdout.columns || 80)
      process.stdout.write(`\x1B[${lines}A\x1B[0J`)
      this.liveLines = 0
      this.liveContent = ''
    }
  }

  private writeLive(content: string): void {
    this.eraseLive()
    process.stdout.write(content + '\n')
    const w = process.stdout.columns || 80
    this.liveContent = content
    this.liveLines = this.countRenderedLines(content, w)
  }

  // ── Private: theme helpers ─────────────────────────────────────────────────

  private verdictBadge(v: string | null): string {
    const t = this.theme
    if (v === 'APPROVE') return t.success('✅ APPROVE')
    if (v === 'NEEDS WORK') return t.warning('⚠  NEEDS WORK')
    if (v === 'BLOCK') return t.error('🚫 BLOCK')
    return t.dim('—')
  }

  private crFillFn(verdict: string | null): ChalkFn {
    const t = this.theme
    if (verdict === 'APPROVE') return t.barCRApprove
    if (verdict === 'BLOCK') return t.barCRBlock
    return t.barCRNeedsWork
  }

  private crLabelFn(verdict: string | null): ChalkFn {
    const t = this.theme
    if (verdict === 'APPROVE') return t.barCRApprove
    if (verdict === 'BLOCK') return t.barCRBlock
    return t.barCRNeedsWork
  }

  // ── Private: render ────────────────────────────────────────────────────────

  private uptime(): string {
    const totalSec = Math.floor((Date.now() - this.stats.sessionStart) / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  private statsRow(): string {
    const { prsReceived, crsCompleted, fixesApplied, crTotalMs } = this.stats
    const avgCr = crsCompleted > 0
      ? `  │  avg CR: ${Math.round(crTotalMs / crsCompleted / 1000)}s`
      : ''
    return `PRs: ${prsReceived} · CRs: ${crsCompleted} · fixes: ${fixesApplied}${avgCr}`
  }

  private renderPRSlot(slot: PRSlot, frame: string): string {
    const t = this.theme
    const w = process.stdout.columns || 80
    const elapsed = Math.floor((Date.now() - slot.startedAt) / 1000)
    const eSuffix = `${elapsed}s`

    // ── Line 1: identity + elapsed ───────────────────────────────────────────
    const branch = truncate(slot.branch, 22)
    const l1Plain = `  ${frame} #${slot.prNumber}  ${slot.repo}  ${branch}  `
    const l1Pad = Math.max(1, w - stripAnsi(l1Plain).length - eSuffix.length)
    const l1 = `  ${t.spinner(frame)} ${chalk.bold(`#${slot.prNumber}`)}  ${chalk.white(slot.repo)}  ${t.dim(branch)}  ` +
      ' '.repeat(l1Pad) + t.dim(eSuffix)

    // ── Line 2: data pipeline ─────────────────────────────────────────────────
    const indent = '    '
    const parts: string[] = []

    // PR size bar (shown as soon as loc is known; empty bar while cloning)
    if (slot.prLoc !== undefined) {
      parts.push(`PR ${makeBar(locToFilled(slot.prLoc), 10, t.barPRFill, t.barEmpty)} ${t.dim(String(slot.prLoc) + 'loc')}`)
    } else {
      parts.push(`PR ${makeBar(0, 10, t.barPRFill, t.barEmpty)}`)
    }

    // CR section — visible once verdict arrives
    if (slot.verdict !== undefined && slot.verdict !== null) {
      const crFill = this.crFillFn(slot.verdict)
      const crLabel = this.crLabelFn(slot.verdict)
      const count = slot.commentCount ?? 0
      parts.push(`CR ${makeBar(commentCountToFilled(count), 8, crFill, t.barEmpty)} ${crLabel(slot.verdict)} ·${count}`)
    }

    // FIX section — visible once fix data arrives or fix is in progress
    if (slot.fixCount !== undefined) {
      const n = slot.fixCount
      parts.push(`FIX ${makeBar(fixCountToFilled(n), 6, t.barFixFill, t.barEmpty)} ${t.accent(String(n) + ' applied')}`)
    }

    // Current phase indicator — always rightmost
    const phaseLabel = `${t.dim(frame)} ${slot.label}`
    parts.push(phaseLabel)

    const l2 = indent + parts.join('   ')

    return `${l1}\n${l2}`
  }

  private render(): string {
    if (!this.config) return ''
    const cfg = this.config
    const t = this.theme
    const w = process.stdout.columns || 80
    // Use w-1 to prevent the exact-terminal-width cursor wrap ambiguity that
    // causes the first char of the next line to appear at the end of the separator.
    const sep = t.separator('─'.repeat(w - 1))
    const indent = ' '.repeat(14)

    // ── Section 1: status dashboard ──────────────────────────────────────────
    const { url, alive } = this.tunnel
    const tunnelDisplay = url
      ? `${url.replace(/^https?:\/\//, '')} ${alive ? t.success('✓') : t.warning('⚠')}`
      : t.dim('connecting...')
    const row1 = `${chalk.greenBright('●')} ${chalk.bold('crosscheck')}  tunnel: ${tunnelDisplay}  │  ${cfg.mode} · ${cfg.quality.tier}  │  ${t.dim('↑')} ${this.uptime()}`

    const stepFlow = this.steps.map(s => s.name).join(t.dim(' → '))
    const vendors: string[] = []
    if (cfg.vendors.claude.enabled) vendors.push('claude')
    if (cfg.vendors.codex.enabled) vendors.push('codex')
    const row2 = `${indent}workflow: ${stepFlow}  │  ${vendors.join(' · ')}`
    const row3 = `${indent}${this.statsRow()}`

    // ── Section 1.5: connectivity log — only rendered when there are active entries.
    // Empty connLog lines are excluded so the idle state stays compact (no 3 blank rows).
    const activeConn = this.connLog.filter(l => l.trim())
    const connSection = activeConn.length > 0 ? [sep, ...activeConn] : []

    // ── Section 2: active PR slots ────────────────────────────────────────────
    const frame = FRAMES[this.frameIdx]
    const prContent: string[] = []

    if (this.slots.size === 0) {
      prContent.push(t.dim('  waiting for PRs...'))
    } else {
      let first = true
      for (const slot of this.slots.values()) {
        if (!first) prContent.push('')  // blank line between PRs
        prContent.push(this.renderPRSlot(slot, frame))
        first = false
      }
    }

    return [row1, row2, row3, ...connSection, sep, ...prContent, sep].join('\n')
  }

  private redraw(): void {
    const content = this.render()
    if (content) this.writeLive(content)
  }
}
