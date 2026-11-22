import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Ativo, Leitura } from '../types'

// Troque o shape quando os campos de Ativo mudarem: valores antigos sobrevivem a um reload.
const leitura = atom({ plugin: 'codex-ativos', key: 'leitura' } as const, null, { shape: 'leitura-1' })
const PERIODO_MS = 5000

function duracao(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${ss}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const cwd = await $.session.cwd()
    const script = `${$.plugin.root}/hooks/ativos.mjs`
    let lendo = false // nunca sobrepõe leituras: uma lenta não empilha processos a cada período
    const ler = async () => {
      if (lendo) return
      lendo = true
      try {
        const r = await $.process.run(['node', script, cwd], { timeoutMs: 4000 }) // sem /usr/bin/env: funciona também no Windows (node.exe pelo PATH)
        const ativos: Ativo[] = r.exitCode === 0 ? JSON.parse(r.stdout) : []
        const novo: Leitura = { ativos, at: await $.clock.now() }
        await update($, leitura, () => novo)
      } catch {
        // leitura falhou: mantém a anterior; a próxima tentativa vem no próximo período
      } finally {
        lendo = false
      }
    }
    await ler()
    $.clock.every(PERIODO_MS, () => { void ler() })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, leitura)
    if (e.props.hasSurvey || !l || l.ativos.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const n = l.ativos.length

    return (
      <Box flexDirection="column">
        <Text bold>
          {n === 1 ? '1 subagente ativo' : `${n} subagentes ativos`}
        </Text>
        {l.ativos.map(a => (
          <Text key={`${a.source}:${a.id}`} dimColor>
            {`  ${a.kind} · ${a.repo} · ${duracao(l.at - a.startedAt)}${a.phase ? ` · ${a.phase}` : ''}`}
          </Text>
        ))}
      </Box>
    )
  })
}
