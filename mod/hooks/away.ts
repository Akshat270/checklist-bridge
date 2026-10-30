// Away mode in the mod: the user tells Claude they are away until a time, so it doesn't wait for them.
// "/checklist away 2h" (also 45m, 1h30m, 18:30, 6:30pm), or the pane's ☾ Away button with quick choices.
// The rules Claude follows while the user is away are in lib/model.ts (setAway, awayNote), as in VS Code.
import { MAX_AWAY_MS } from './lib/model'

export type Away = { ms: number; label: string; midnightIn?: number }

/** The pane's quick choices, as in the VS Code panel. */
export const AWAY_CHOICES: { label: string; ms: number }[] = [
  { label: '30 min', ms: 30 * 60_000 },
  { label: '1 h', ms: 60 * 60_000 },
  { label: '2 h', ms: 2 * 60 * 60_000 },
  { label: '4 h', ms: 4 * 60 * 60_000 },
]
export const EXTEND_MS = 30 * 60_000

const clock = (at: Date) => at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * Away for `ms` from now: the end time as this computer's clock shows it, and, if that is after midnight,
 * how long until midnight, so "tomorrow" is said until then and not after (as the VS Code panel does).
 */
export function awayFor(ms: number, now = Date.now()): Away | undefined {
  if (!(ms >= 60_000) || ms > MAX_AWAY_MS) return undefined
  const midnight = new Date(now).setHours(24, 0, 0, 0)
  return { ms, label: clock(new Date(now + ms)), midnightIn: now + ms >= midnight ? midnight - now : undefined }
}

/** How long is left, in words: "45 min", "1 h 20 min". */
export function leftText(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
}

export function parseAway(text: string, now = new Date()): Away | undefined {
  const s = text.trim().toLowerCase().replace(/\s+/g, '')
  const span = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m(?:in)?)?$/.exec(s)
  if (span && (span[1] || span[2])) return awayFor(Math.round((Number(span[1] ?? 0) * 60 + Number(span[2] ?? 0)) * 60_000), now.getTime())
  const at = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(s)
  if (at && (at[2] || at[3])) {
    let h = Number(at[1])
    const m = Number(at[2] ?? 0)
    if (m > 59 || h > 23 || (at[3] && (h < 1 || h > 12))) return undefined
    if (at[3] === 'pm' && h < 12) h += 12
    if (at[3] === 'am' && h === 12) h = 0
    const end = new Date(now)
    end.setHours(h, m, 0, 0)
    if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
    return awayFor(end.getTime() - now.getTime(), now.getTime())
  }
  return undefined
}
