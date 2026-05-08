import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { z } from 'zod'

export const WorkflowStepSchema = z.object({
  name: z.string(),
  type: z.enum(['review', 'address', 'recheck']),
  reviewer: z.enum(['auto', 'claude', 'codex', 'origin']).default('auto'),
  when: z.string().optional(),
  max_rounds: z.number().int().positive().default(1),
  instructions: z.string().optional(),
})

export const WorkflowSchema = z.object({
  on: z.array(z.string()).default(['opened', 'synchronize']),
  steps: z.array(WorkflowStepSchema),
})

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

// Default pipeline: review then address issues (skipped if verdict is APPROVE).
// Execution always goes through this constant — there is no legacy direct-call path.
export const DEFAULT_WORKFLOW: WorkflowStep[] = [
  {
    name: 'review',
    type: 'review',
    reviewer: 'auto',
    max_rounds: 1,
  },
  {
    name: 'address',
    type: 'address',
    reviewer: 'origin',
    when: "review.verdict != 'APPROVE'",
    max_rounds: 1,
    instructions: 'Only fix issues explicitly called out in the review. Do not refactor unrelated code, rename variables, or add tests unless specifically requested.',
  },
]

export function loadWorkflow(operatorDir?: string): WorkflowStep[] {
  // Only look in the operator's own directory — never inside the PR checkout.
  // Loading workflow config from untrusted PR code would let a PR hijack the runner.
  const candidates = operatorDir ? [join(operatorDir, '.crosscheck', 'workflow.yml')] : []
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const raw = yaml.load(readFileSync(path, 'utf8'))
      return WorkflowSchema.parse(raw).steps
    } catch {
      // Malformed workflow file — fall through to default
    }
  }
  return DEFAULT_WORKFLOW
}

export interface StepResult {
  verdict?: string | null
  commentBody?: string
  commentUrl?: string
  applied_count?: number
  skipped?: boolean
}

// Evaluates simple "stepName.field op 'value'" expressions.
// Unparseable expressions default to true (run the step).
export function evaluateWhen(expr: string, results: Record<string, StepResult>): boolean {
  const m = expr.trim().match(/^(\w+)\.(\w+)\s*(==|!=|>=|<=|>|<)\s*(?:'([^']*)'|(null|-?\d+(?:\.\d+)?))$/)
  if (!m) return true

  const [, stepName, field, op, strVal, rawVal] = m
  const result = results[stepName]
  if (!result) return true

  const actual = result[field as keyof StepResult]
  const expected = strVal !== undefined ? strVal : rawVal === 'null' ? null : Number(rawVal)

  switch (op) {
    case '==': return actual === expected
    case '!=': return actual !== expected
    case '>':  return Number(actual) > Number(expected)
    case '<':  return Number(actual) < Number(expected)
    case '>=': return Number(actual) >= Number(expected)
    case '<=': return Number(actual) <= Number(expected)
    default:   return true
  }
}
