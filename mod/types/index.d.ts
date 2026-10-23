// The values the mod keeps in $.state.
// `rev` goes up on every change to the checklists, so the pane redraws. `openTask` is the task whose card
// the user opened ('' for the next task), and `showShared` whether the "Shared with Claude" section is open.
export type Rev = number

declare module 'claude-code' {
  interface PluginState {
    'checklist-bridge': { rev: Rev; openTask: string; showShared: boolean }
  }
}
