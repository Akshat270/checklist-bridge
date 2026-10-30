// The pane's colours: the two palettes of the design (dark and light terminal themes). A mod can't see
// the terminal's theme, so the user picks one in /config ("Colors"); dark is the default.
//
// Every colour means one thing: cyan = next / act here, amber = decide / away, red = urgent / couldn't
// do it, green = done / read by Claude, violet = blocked. The light palette uses darker shades of the
// same colours so text keeps its contrast on white.

export type Palette = {
  text: string
  title: string
  dim: string
  muted: string
  cyan: string
  green: string
  amber: string
  red: string
  violet: string
  /** Text on a filled badge or button. */
  onFill: string
  pillBg: string
  pillFg: string
  keyBg: string
  keyFg: string
  /** Secondary buttons. */
  btnBg: string
  notDoneBg: string
  /** The command well. */
  wellBg: string
  /** Card frames (cards are never filled: see pane.tsx). */
  nextBorder: string
  decideBorder: string
  urgentBorder: string
  awayBorder: string
  awayTrack: string
  sentBorder: string
  fieldBorder: string
  rule: string
  track: string
}

const DARK: Palette = {
  text: '#d9dbe0',
  title: '#f2f3f5',
  dim: '#8d929c',
  muted: '#6b707a',
  cyan: '#56c7da',
  green: '#5fcf8f',
  amber: '#e3b341',
  red: '#f07a6a',
  violet: '#c58cf2',
  onFill: '#101114',
  pillBg: '#3a3e47',
  pillFg: '#e6e8ec',
  keyBg: '#d9dbe0',
  keyFg: '#101114',
  btnBg: '#23262c',
  notDoneBg: '#2a1f1f',
  wellBg: '#101417',
  nextBorder: '#2f8a99',
  decideBorder: '#6b5a24',
  urgentBorder: '#8a3a31',
  awayBorder: '#6b5a24',
  awayTrack: '#2c2717',
  sentBorder: '#275b3f',
  fieldBorder: '#474b55',
  rule: '#30333a',
  track: '#3a3e47',
}

const LIGHT: Palette = {
  text: '#24272d',
  title: '#111317',
  dim: '#565c66',
  muted: '#6e737c',
  cyan: '#0b7186',
  green: '#1b7a43',
  amber: '#8a5d00',
  red: '#b42318',
  violet: '#8b3dbf',
  onFill: '#ffffff',
  pillBg: '#dcdee2',
  pillFg: '#24272d',
  keyBg: '#24272d',
  keyFg: '#ffffff',
  btnBg: '#eceef0',
  notDoneBg: '#fbeceb',
  wellBg: '#eef1f2',
  nextBorder: '#6fb3c1',
  decideBorder: '#d9b45a',
  urgentBorder: '#e29a92',
  awayBorder: '#d9b45a',
  awayTrack: '#efe4c4',
  sentBorder: '#8cc8a5',
  fieldBorder: '#b9bdc4',
  rule: '#d6d8dc',
  track: '#c4c7cc',
}

export type ThemeName = 'dark' | 'light'
export const palette = (name: unknown): Palette => (name === 'light' ? LIGHT : DARK)
