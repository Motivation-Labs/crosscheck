export type CrosscheckStepType = 'review' | 'recheck' | 'fix' | 'conflict-resolve'

export interface CrosscheckAnnotationInput {
  origin: string
  reviewer: string
  verdict: string
  type: CrosscheckStepType
  model: string
  round: number
  service: string
}

export interface CrosscheckCommitTrailerInput {
  reviewer: string
  model: string
  step: CrosscheckStepType
  service: string
}

const DEFAULT_TYPE: CrosscheckStepType = 'review'
const DEFAULT_MODEL = 'default'
const DEFAULT_ROUND = 1
const DEFAULT_SERVICE = 'crosscheck'

const STEP_TYPES = new Set<CrosscheckStepType>(['review', 'recheck', 'fix', 'conflict-resolve'])

export function buildAnnotation(input: CrosscheckAnnotationInput): string {
  return `<!-- crosscheck: origin=${fieldValue(input.origin)} reviewer=${fieldValue(input.reviewer)} model=${fieldValue(input.model)} type=${fieldValue(input.type)} round=${input.round} verdict=${fieldValue(input.verdict)} service=${fieldValue(input.service)} -->`
}

export function parseAnnotation(body: string): CrosscheckAnnotationInput | null {
  const matches = [...body.matchAll(/<!-- crosscheck: ([^>]+) -->/g)]
  const last = matches.at(-1)
  if (!last) return null

  const fields = parseFields(last[1])
  const origin = fields.get('origin')
  const reviewer = fields.get('reviewer')
  if (!origin || !reviewer) return null

  return {
    origin,
    reviewer,
    model: fields.get('model') ?? DEFAULT_MODEL,
    type: parseType(fields.get('type')),
    round: parseRound(fields.get('round')),
    verdict: fields.get('verdict') ?? 'UNKNOWN',
    service: fields.get('service') ?? DEFAULT_SERVICE,
  }
}

export function buildCommitTrailers(input: CrosscheckCommitTrailerInput): string {
  return [
    `Crosscheck-Reviewer: ${fieldValue(input.reviewer)}`,
    `Crosscheck-Model: ${fieldValue(input.model)}`,
    `Crosscheck-Step: ${fieldValue(input.step)}`,
    `Crosscheck-Service: ${fieldValue(input.service)}`,
  ].join('\n')
}

function parseFields(attrs: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const match of attrs.matchAll(/\b([a-z_]+)=([^\s]+)/g)) {
    fields.set(match[1], match[2])
  }
  return fields
}

function parseType(value: string | undefined): CrosscheckStepType {
  return value !== undefined && STEP_TYPES.has(value as CrosscheckStepType)
    ? value as CrosscheckStepType
    : DEFAULT_TYPE
}

function parseRound(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ROUND
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ROUND
}

function fieldValue(value: string): string {
  return value.trim().replace(/\s+/g, '_')
}
