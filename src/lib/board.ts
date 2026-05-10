import chalk from 'chalk'
import type { Config, DisplayTheme } from '../config/schema.js'
import type { WorkflowStep } from './workflow.js'

// ── Phase state ───────────────────────────────────────────────────────────────

export type PRPhase =
  | 'queued'      // waiting for review to start
  | 'reviewing'   // review CLI running
  | 'reviewed'    // review done, comment posted
  | 'fixing'      // fix CLI running
  | 'fixed'       // fix done (or skipped)
  | 'rechecking'  // recheck CLI running
  | 'rechecked'   // recheck done (or skipped)

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
  completedAt?: number      // set by completePR — slot kept 5s for live retention
  prLoc?: number
  phase?: PRPhase
  verdict?: string | null   // review step verdict (undefined = not yet reviewed)
  commentCount?: number
  fixCount?: number         // undefined = hasn't run, 0 = skipped, N = applied
  recheckVerdict?: string | null  // recheck step verdict
}

export interface PRUpdate {
  label?: string
  prLoc?: number
  phase?: PRPhase
  verdict?: string | null
  commentCount?: number
  fixCount?: number
  recheckVerdict?: string | null
}

export interface PRCompletionData {
  elapsedMs: number
  url: string
}

interface Stats {
  prsReceived: number
  crsCompleted: number
  fixesApplied: number
  errorsOccurred: number
  crTotalMs: number
  sessionStart: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BAR_FILLED = '█'
const BAR_EMPTY = '░'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fixed-width timestamp: always "HH:MM:SS AM/PM" (zero-padded hour) so columns stay aligned
export function fmtTime(d = new Date()): string {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
}

// Width of a fmtTime() result — constant regardless of time of day ("01:00:00 AM".length = 11)
export const FMT_TIME_WIDTH = 11

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
    errorsOccurred: 0,
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
    this.slots.set(key, { prNumber, repo, branch, label: 'cloning...', startedAt: Date.now(), phase: 'queued' })
    this.stats.prsReceived++
  }

  updatePR(key: string, updates: PRUpdate): void {
    const slot = this.slots.get(key)
    if (!slot) return
    if (updates.label !== undefined) slot.label = updates.label
    if (updates.prLoc !== undefined) slot.prLoc = updates.prLoc
    if (updates.phase !== undefined) slot.phase = updates.phase
    if (updates.verdict !== undefined) slot.verdict = updates.verdict
    if (updates.commentCount !== undefined) slot.commentCount = updates.commentCount
    if (updates.fixCount !== undefined) slot.fixCount = updates.fixCount
    if (updates.recheckVerdict !== undefined) slot.recheckVerdict = updates.recheckVerdict
  }

  completePR(key: string, data: PRCompletionData): void {
    const slot = this.slots.get(key)
    if (!slot) return

    // Mark as completed — kept in slots map for 5-second live-block retention
    slot.completedAt = Date.now()
    slot.label = 'done'

    const verdict = slot.verdict ?? null
    const commentCount = slot.commentCount ?? 0
    const fixCount = slot.fixCount

    // Count completed CRs regardless of whether verdict was parseable
    if (verdict !== null || slot.phase === 'reviewed' || slot.phase === 'rechecked' || slot.phase === 'fixed') {
      this.stats.crsCompleted++
      this.stats.crTotalMs += data.elapsedMs
    }
    if (fixCount !== undefined && fixCount > 0) this.stats.fixesApplied++

    const t = this.theme
    const ts = fmtTime()
    const indent = ' '.repeat(FMT_TIME_WIDTH + 2)
    const elapsed = `(${Math.round(data.elapsedMs / 1000)}s)`

    // line 1 — use recheck verdict for badge when available
    const finalVerdict = slot.recheckVerdict !== undefined ? slot.recheckVerdict : verdict
    const badge = this.verdictBadge(finalVerdict)
    const branch = truncate(slot.branch, 22)
    const line1 = `${t.dim(ts)}  ${badge}  #${slot.prNumber}  ${chalk.dim(slot.repo)}  ${t.dim(branch)}  ${t.dim(elapsed)}  ${t.dim('→')} ${t.accent(data.url)}`

    // line 2 — always shown: PR | CR | Fix pipeline summary
    const pipe = chalk.dim(' | ')
    const hasFixStep = this.steps.some(s => s.type === 'fix')

    const prSection = slot.prLoc !== undefined
      ? `PR ${makeBar(locToFilled(slot.prLoc), 10, t.barPRFill, t.barEmpty)} ${t.dim(String(slot.prLoc) + 'loc')}`
      : `PR ${makeBar(0, 10, t.barPRFill, t.barEmpty)} ${t.dim('—')}`

    let crSection: string
    if (verdict !== null) {
      const crFill = this.crFillFn(verdict)
      const crLabel = this.crLabelFn(verdict)
      crSection = `CR ${makeBar(commentCountToFilled(commentCount), 8, crFill, t.barEmpty)} ${crLabel(`${commentCount} issues (${verdict})`)}`
    } else {
      crSection = `CR ${makeBar(0, 8, t.barEmpty, t.barEmpty)} ${t.warning('⚠ no verdict')}`
    }

    let fixSection: string
    if (!hasFixStep) {
      fixSection = `Fix ${t.dim('—')}`
    } else if (fixCount !== undefined && fixCount > 0) {
      fixSection = `Fix ${makeBar(fixCountToFilled(fixCount), 6, t.barFixFill, t.barEmpty)} ${t.accent(String(fixCount) + ' applied')}`
    } else {
      fixSection = `Fix ${makeBar(0, 6, t.barFixFill, t.barEmpty)} ${t.dim('—')}`
    }

    this.printStatic(`\n${line1}\n${indent}${prSection}${pipe}${crSection}${pipe}${fixSection}`)

    // In non-TTY mode render() never runs, so purge the slot here instead of
    // relying on the render loop's 5-second cleanup.
    if (!this.isTTY) {
      this.slots.delete(key)
    }
  }

  failPR(key: string, error: string): void {
    const slot = this.slots.get(key)
    this.slots.delete(key)
    this.stats.errorsOccurred++
    if (slot) {
      const ts = fmtTime()
      this.printStatic(`${chalk.dim(ts)}  PR #${slot.prNumber}  ${chalk.red('✗')} ${error}`)
    }
  }

  /** Print 1–2 static lines to scrollback (above the live block). */
  log(line1: string, line2?: string): void {
    // Prepend a blank line for 2-line events so consecutive entries don't blur together
    this.printStatic(line2 ? `\n${line1}\n${line2}` : line1)
  }

  /** Record a connectivity event in the live section (tunnel/webhook events). */
  logConnectivity(line: string): void {
    const ts = chalk.dim(fmtTime())
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
    const { prsReceived, crsCompleted, fixesApplied, errorsOccurred, crTotalMs } = this.stats
    const avgCr = crsCompleted > 0
      ? `  │  avg CR: ${Math.round(crTotalMs / crsCompleted / 1000)}s`
      : ''
    const errorPart = errorsOccurred > 0
      ? ` · ${chalk.red(`errors: ${errorsOccurred}`)}`
      : ''
    return `PRs: ${prsReceived} · CRs: ${crsCompleted}${errorPart} · fixes: ${fixesApplied}${avgCr}`
  }

  private renderPRSlot(slot: PRSlot, frame: string): string {
    const t = this.theme
    const w = process.stdout.columns || 80
    const isCompleted = slot.completedAt !== undefined
    const totalElapsedMs = isCompleted
      ? slot.completedAt! - slot.startedAt
      : Date.now() - slot.startedAt
    const eSuffix = `${Math.floor(totalElapsedMs / 1000)}s`

    // ── Line 1: identity  <pad>  elapsed  phase-label ─────────────────────────
    const branch = truncate(slot.branch, 22)
    const icon = isCompleted ? t.success('✓') : t.spinner(frame)
    const phaseLabel = this.phaseLine1Label(slot, frame)
    const rightPart = `${t.dim(eSuffix)}  ${phaseLabel}`
    const identityPlain = `   #${slot.prNumber}  ${slot.repo}  ${branch}`
    const l1Pad = Math.max(2, w - stripAnsi(identityPlain).length - stripAnsi(rightPart).length - 2)
    const prNum = isCompleted ? t.dim(`#${slot.prNumber}`) : chalk.bold(`#${slot.prNumber}`)
    const repoStr = isCompleted ? t.dim(slot.repo) : chalk.white(slot.repo)
    const l1 = `  ${icon} ${prNum}  ${repoStr}  ${t.dim(branch)}` +
      ' '.repeat(l1Pad) + rightPart

    // ── Line 2: PR | CR | Fix | Recheck pipeline ────────────────────────────────
    const indent = '    '
    const pipe = t.dim(' | ')

    const prSection = slot.prLoc !== undefined
      ? `PR ${makeBar(locToFilled(slot.prLoc), 10, t.barPRFill, t.barEmpty)} ${t.dim(String(slot.prLoc) + 'loc')}`
      : `PR ${makeBar(0, 10, t.barPRFill, t.barEmpty)} ${t.dim('—')}`

    const crSection = this.renderCRSection(slot, frame)
    const fixSection = this.renderFixSection(slot, frame)
    const recheckSection = this.renderRecheckSection(slot, frame)

    const parts = [prSection, crSection, fixSection]
    if (recheckSection !== null) parts.push(recheckSection)

    return `${l1}\n${indent}${parts.join(pipe)}`
  }

  private phaseLine1Label(slot: PRSlot, frame: string): string {
    const t = this.theme
    if (slot.completedAt !== undefined) return t.dim('done')
    switch (slot.phase) {
      case 'reviewing':
      case 'rechecking':
      case 'fixing':
        return `${t.spinner(frame)} ${t.dim(slot.label)}`
      default:
        return t.dim(slot.label)
    }
  }

  private renderCRSection(slot: PRSlot, frame: string): string {
    const t = this.theme
    if (slot.phase === 'reviewing') {
      return `CR ${makeBar(0, 8, t.barPRFill, t.barEmpty)} ${t.spinner(frame)} ${t.dim('reviewing…')}`
    }
    if (slot.verdict === undefined) {
      return `CR ${makeBar(0, 8, t.barPRFill, t.barEmpty)} ${t.dim('queued')}`
    }
    if (slot.verdict === null) {
      return `CR ${makeBar(0, 8, t.barEmpty, t.barEmpty)} ${t.warning('⚠ no verdict')}`
    }
    const crFill = this.crFillFn(slot.verdict)
    const crLabel = this.crLabelFn(slot.verdict)
    const count = slot.commentCount ?? 0
    return `CR ${makeBar(commentCountToFilled(count), 8, crFill, t.barEmpty)} ${crLabel(`${count} issues (${slot.verdict})`)}`
  }

  private renderFixSection(slot: PRSlot, frame: string): string {
    const t = this.theme
    const hasFixStep = this.steps.some(s => s.type === 'fix')
    if (!hasFixStep) return `Fix ${t.dim('—')}`
    if (slot.phase === 'fixing') {
      return `Fix ${makeBar(0, 6, t.barFixFill, t.barEmpty)} ${t.spinner(frame)} ${t.dim('applying…')}`
    }
    if (slot.fixCount !== undefined) {
      if (slot.fixCount === 0) return `Fix ${makeBar(0, 6, t.barFixFill, t.barEmpty)} ${t.dim('— skipped')}`
      return `Fix ${makeBar(fixCountToFilled(slot.fixCount), 6, t.barFixFill, t.barEmpty)} ${t.success('✓')} ${t.accent(String(slot.fixCount) + ' applied')}`
    }
    return `Fix ${makeBar(0, 6, t.barFixFill, t.barEmpty)} ${t.dim('queued')}`
  }

  private renderRecheckSection(slot: PRSlot, frame: string): string | null {
    const t = this.theme
    const hasRecheckStep = this.steps.some(s => s.type === 'recheck')
    if (!hasRecheckStep) return null
    if (slot.phase === 'rechecking') {
      return `Recheck ${makeBar(0, 5, t.barPRFill, t.barEmpty)} ${t.spinner(frame)} ${t.dim('reviewing…')}`
    }
    if (slot.phase === 'rechecked') {
      if (slot.recheckVerdict === undefined) {
        return `Recheck ${makeBar(0, 5, t.barFixFill, t.barEmpty)} ${t.dim('— skipped')}`
      }
      if (slot.recheckVerdict === null) {
        return `Recheck ${makeBar(0, 5, t.barEmpty, t.barEmpty)} ${t.warning('⚠ no verdict')}`
      }
      const fill = this.crFillFn(slot.recheckVerdict)
      const label = this.crLabelFn(slot.recheckVerdict)
      return `Recheck ${makeBar(0, 5, fill, t.barEmpty)} ${label(slot.recheckVerdict)}`
    }
    return `Recheck ${makeBar(0, 5, t.barPRFill, t.barEmpty)} ${t.dim('queued')}`
  }

  private render(): string {
    if (!this.config) return ''

    // Clean up completed slots past the 5-second retention window
    const now = Date.now()
    for (const [key, slot] of this.slots) {
      if (slot.completedAt !== undefined && now - slot.completedAt > 5000) {
        this.slots.delete(key)
      }
    }

    const cfg = this.config
    const t = this.theme
    const w = process.stdout.columns || 80
    // Use w-1 to prevent the exact-terminal-width cursor wrap ambiguity that
    // causes the first char of the next line to appear at the end of the separator.
    const sep = t.separator('─'.repeat(w - 1))

    // ── Section 1 (top): session summary ─────────────────────────────────────
    const summaryRow = `${this.statsRow()}  │  ${t.dim('↑')} ${this.uptime()}`

    // ── Section 2 (middle): connectivity / status ─────────────────────────────
    // Two-column fixed-width grid. B1 covers "  ● crosscheck  <label>: <value>"
    // so the right column always starts at the same position on both rows.
    // The row-2 indent (16 chars) aligns "workflow:" under "tunnel:" on row 1:
    //   "  ● crosscheck  " = 2 + 1 + 1 + 10 + 2 = 16 visible chars
    const CONN_INDENT = ' '.repeat(16)  // aligns row-2 labels under row-1 labels
    // B1+B2 must equal w-1 (same constraint as the separator) to avoid the
    // exact-terminal-width cursor wrap that breaks eraseLive() line counting.
    const B1 = Math.min(52, Math.floor((w - 1) * 0.65))
    const B2 = (w - 1) - B1

    const lb = (styled: string, width: number): string =>
      styled + ' '.repeat(Math.max(2, width - stripAnsi(styled).length))

    const { type: tunnelType, url, alive } = this.tunnel
    const tunnelLabel = tunnelType === 'serve' ? 'endpoint' : 'tunnel'
    const tunnelDisplay = url
      ? `${url.replace(/^https?:\/\//, '')} ${alive ? t.success('✓') : t.warning('⚠')}`
      : t.dim('connecting...')

    const connRow1 = lb(`  ${chalk.greenBright('●')} ${chalk.bold('crosscheck')}  ${tunnelLabel}: ${tunnelDisplay}`, B1) +
      lb(`${cfg.mode} · ${cfg.quality.tier}`, B2)

    const stepFlow = this.steps.map(s => s.name).join(t.dim(' → '))
    const vendors: string[] = []
    if (cfg.vendors.claude.enabled) vendors.push('claude')
    if (cfg.vendors.codex.enabled) vendors.push('codex')

    const connRow2 = lb(`${CONN_INDENT}workflow: ${stepFlow}`, B1) +
      lb(vendors.join(' · '), B2)

    const activeConn = this.connLog.filter(l => l.trim())

    // ── Section 3 (bottom): active PR catalog ──────────────────────────────────
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

    return [summaryRow, sep, connRow1, connRow2, ...activeConn, sep, ...prContent, sep].join('\n')
  }

  private redraw(): void {
    const content = this.render()
    if (content) this.writeLive(content)
  }
}
