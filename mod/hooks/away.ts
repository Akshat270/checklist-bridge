// "/checklist away 2h", "away 45m", "away 1h30m", "away 18:30", "away 6:30pm": when the user is back.
import { MAX_AWAY_MS } from './lib/model'

export type Away = { ms: number; label: string }

const label = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function parseAway(text: string, now = new Date()): Away | undefined {
  const s = text.trim().toLowerCase().replace(/\s+/g, '')
  const span = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m(?:in)?)?$/.exec(s)
  if (span && (span[1] || span[2])) {
    const ms = Math.round((Number(span[1] ?? 0) * 60 + Number(span[2] ?? 0)) * 60_000)
    if (ms <= 0 || ms > MAX_AWAY_MS) return undefined
    return { ms, label: label(new Date(now.getTime() + ms)) }
  }
  const clock = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(s)
  if (clock && (clock[2] || clock[3])) {
    let h = Number(clock[1])
    const m = Number(clock[2] ?? 0)
    if (m > 59 || h > 23 || (clock[3] && (h < 1 || h > 12))) return undefined
    if (clock[3] === 'pm' && h < 12) h += 12
    if (clock[3] === 'am' && h === 12) h = 0
    const at = new Date(now)
    at.setHours(h, m, 0, 0)
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
    return { ms: at.getTime() - now.getTime(), label: label(at) }
  }
  return undefined
}
