import chalk from 'chalk'

export type Verdict = 'APPROVE' | 'NEEDS WORK' | 'BLOCK'

// Primary: strict line match.
// Handles: heading prefix (## VERDICT:), bold label (**VERDICT:**), bold value (VERDICT: **APPROVE**),
// NEEDS_WORK / NEEDS  WORK spelling variants, trailing period.
const PRIMARY_RE = /^(?:#{1,6}\s*)?(?:\*{1,2})?VERDICT:(?:\*{1,2})?\s*(?:\*{1,2})?(APPROVE|NEEDS[\s_]+WORK|BLOCK)(?:\*{1,2})?\.?\s*$/im
// Fallback: VERDICT: token anywhere in the text (inline prose, blockquote, bold value)
const FALLBACK_RE = /VERDICT:\s*(?:\*{1,2})?(APPROVE|NEEDS[\s_]+WORK|BLOCK)(?:\*{1,2})?/gi

function normalizeVerdict(raw: string): Verdict {
  return raw.toUpperCase().replace(/[\s_]+/, ' ').trim() as Verdict
}

export function parseVerdict(text: string): { verdict: Verdict | null; clean: string } {
  // Primary: look for a clean VERDICT: line (last match wins in case of duplicates)
  const primaryMatches = [...text.matchAll(new RegExp(PRIMARY_RE.source, 'gim'))]
  if (primaryMatches.length > 0) {
    const last = primaryMatches[primaryMatches.length - 1]
    const verdict = normalizeVerdict(last[1])
    const clean = text.replace(new RegExp(PRIMARY_RE.source, 'gim'), '').replace(/\n{3,}/g, '\n\n').trim()
    return { verdict, clean }
  }

  // Fallback: VERDICT: anywhere — last occurrence wins
  const fallbackMatches = [...text.matchAll(FALLBACK_RE)]
  if (fallbackMatches.length > 0) {
    const last = fallbackMatches[fallbackMatches.length - 1]
    const verdict = normalizeVerdict(last[1])
    const idx = last.index ?? 0
    const rawClean = text.slice(0, idx) + text.slice(idx + last[0].length)
    return { verdict, clean: rawClean.replace(/\n{3,}/g, '\n\n').trim() }
  }

  return { verdict: null, clean: text }
}

export const NULL_VERDICT_WARNING =
  '> ⚠️ crosscheck could not extract a verdict from this review.'

// Posted when the severity gate downgrades a NEEDS WORK review to APPROVE because
// it carries no blocking finding — keeps the notes visible without driving the loop.
export const SEVERITY_GATE_NOTE =
  '> ℹ️ No blocking (Critical/High/Medium) findings — approving with comments. The notes below are non-blocking; address at your discretion.'

// A list of "no findings" phrasings, reduced to letters-only (punctuation, bullets,
// and whitespace stripped) so "- None.", "N/A", and "None found" all compare equal.
const EMPTY_SECTION_PHRASES = new Set([
  'none', 'nonefound', 'noneidentified', 'nonenoted', 'nonidentified', 'na',
  'nocritical', 'nocriticalissues', 'nocriticalissuesfound', 'noblocking',
  'noblockingissues', 'noissues', 'noissuesfound',
])

// Whether the review's "Critical Issues" section (Claude's mandated format) lists a
// real finding rather than an explicit "None". Returns false when the section is
// absent — a NEEDS WORK without an explicit Critical section is, by the reviewer's
// own definition, non-blocking.
function criticalSectionHasContent(text: string): boolean {
  const heading = text.match(/^#{1,6}\s*Critical(?:\s+Issues?)?\b.*$/im)
  if (!heading) return false
  const rest = text.slice((heading.index ?? 0) + heading[0].length)
  const next = rest.match(/^#{1,6}\s+\S/m)
  const body = (next ? rest.slice(0, next.index) : rest)
  const letters = body.replace(/[^a-z]/gi, '').toLowerCase()
  if (letters === '') return false
  return !EMPTY_SECTION_PHRASES.has(letters)
}

// A review blocks merge when it contains a P0/P1 (critical/high) or P2 (medium/correctness)
// finding. Only P3 nits (style, naming) are non-blocking.
// Recognises both Codex priority markers ([P0]/[P1]/[P2]) and Claude's structured
// "## Critical Issues" section.
export function hasBlockingFindings(reviewText: string): boolean {
  if (/\[P[012]\]/i.test(reviewText)) return true
  return criticalSectionHasContent(reviewText)
}

export interface SeverityGateResult {
  verdict: Verdict | null
  // True when the gate changed the verdict (NEEDS WORK → APPROVE).
  downgraded: boolean
}

// Severity gate: only P3-only (nit/style) reviews are downgraded from NEEDS WORK to
// APPROVE, preventing review-loop churn on trivial suggestions. P2 (medium/correctness)
// findings keep the NEEDS WORK verdict and require human attention before merge.
// BLOCK and APPROVE are never altered.
export function applySeverityGate(verdict: Verdict | null, reviewText: string): SeverityGateResult {
  if (verdict === 'NEEDS WORK' && !hasBlockingFindings(reviewText)) {
    return { verdict: 'APPROVE', downgraded: true }
  }
  return { verdict, downgraded: false }
}

export function formatVerdict(verdict: Verdict | null): string {
  if (!verdict) return chalk.dim('verdict  —')
  if (verdict === 'APPROVE')    return `verdict  ${chalk.green('✅ APPROVE')}`
  if (verdict === 'NEEDS WORK') return `verdict  ${chalk.yellow('⚠  NEEDS WORK')}`
  if (verdict === 'BLOCK')      return `verdict  ${chalk.red('🚫 BLOCK')}`
  return chalk.dim('verdict  —')
}

// Prepend a bold verdict badge to the review comment posted to GitHub
export function prependVerdictToComment(text: string, verdict: Verdict | null): string {
  if (!verdict) return text
  const badge =
    verdict === 'APPROVE'    ? '✅ **APPROVE**' :
    verdict === 'NEEDS WORK' ? '⚠️ **NEEDS WORK**' :
                               '🚫 **BLOCK**'
  return `${badge}\n\n${text}`
}
