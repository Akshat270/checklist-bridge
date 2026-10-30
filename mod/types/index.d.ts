// The values the mod keeps in $.state.
// `rev` goes up on every change to the checklists, so the pane redraws. `openTask` is the task whose card
// the user opened ('' for the next task), `showShared` whether the "Shared with Claude" section is open, and
// `awayPicker` whether the ☾ Away time choices are showing.
export type Rev = number

declare module 'claude-code' {
  interface PluginState {
    'checklist-bridge': { rev: Rev; openTask: string; showShared: boolean; awayPicker: boolean }
  }
}
