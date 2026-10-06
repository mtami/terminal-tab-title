export type TabTitleBackend = string

declare module 'claude-code' {
  interface PluginState {
    'terminal-tab-title': { isNamed: boolean }
  }
}
