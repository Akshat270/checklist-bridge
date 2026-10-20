// The values the mod keeps in $.state. `rev` goes up on every change to the checklists, so the pane redraws.
export type Rev = number

declare module 'claude-code' {
  interface PluginState {
    'checklist-bridge': { rev: Rev }
  }
}
