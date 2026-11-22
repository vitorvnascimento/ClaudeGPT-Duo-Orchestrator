export type Ativo = { id: string; kind: string; repo: string; startedAt: number; phase: string; source: 'codex' | 'duo' }
export type Leitura = { ativos: Ativo[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'codex-ativos': { leitura: Shaped<Leitura | null> }
  }
}
