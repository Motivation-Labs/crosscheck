import { promptRepoPicker } from './repo-picker.js'

export type PRPickerAction = 'review' | 'fix' | 'recheck' | 'merge'

export interface PRPickerItem {
  key: string
  label: string
  action: PRPickerAction
  description: string
}

const ACTION_ORDER: PRPickerAction[] = ['review', 'fix', 'recheck', 'merge']

function actionLabel(action: PRPickerAction): string {
  if (action === 'review') return 'CR'
  if (action === 'fix') return 'fix'
  if (action === 'recheck') return 'recheck'
  return 'merge'
}

export function formatPRPickerRows(items: PRPickerItem[]): string[] {
  return [...items]
    .sort((a, b) => {
      const actionDiff = ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action)
      return actionDiff !== 0 ? actionDiff : a.label.localeCompare(b.label)
    })
    .map(item => `${actionLabel(item.action).padEnd(7)} ${item.label}`)
}

export async function promptPRPicker(items: PRPickerItem[]): Promise<string[]> {
  const sorted = [...items].sort((a, b) => {
    const actionDiff = ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action)
    return actionDiff !== 0 ? actionDiff : a.label.localeCompare(b.label)
  })
  const rows = sorted.map(item => `${actionLabel(item.action).padEnd(7)} ${item.label}`)
  const byRow = new Map(rows.map((row, index) => [row, sorted[index]?.key ?? row]))
  const descriptions = new Map(rows.map((row, index) => [row, sorted[index]?.description ?? '']))
  const selected = await promptRepoPicker(rows, {
    title: 'Select PRs to kickass',
    getDescription: row => descriptions.get(row) ?? '',
  })
  return selected.map(row => byRow.get(row) ?? row)
}
