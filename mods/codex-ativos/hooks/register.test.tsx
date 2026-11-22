import { expect, test } from 'claude-code/testing'

const BAND = { plugin: 'codex-ativos', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } } as const

function engine(on: any, stdout: string) {
  on('session.cwd', () => ({ value: '/proj' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout, stderr: '' } }))
  on('clock.now', () => ({ value: 1_000_000 + 65_000 }))
  on('clock.every', () => ({ value: {} }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

test('mostra quantos estão ativos e há quanto tempo', async ($, on) => {
  engine(on, JSON.stringify([
    { id: 'task-1', kind: 'rescue', repo: 'duo', startedAt: 1_000_000, phase: 'running', source: 'codex' },
    { id: 'review-2', kind: 'review', repo: 'site', startedAt: 1_000_000 + 60_000, phase: '', source: 'codex' },
  ]))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /subagentes/ }))?.text).toBe('2 subagentes Codex ativos')
  expect((await ui.find({ type: 'Text', text: /rescue/ }))?.text).toBe('  rescue · duo · 1:05 · running')
  expect((await ui.find({ type: 'Text', text: /review/ }))?.text).toBe('  review · site · 0:05')
  await ui.unmount()
})

test('sem ativos a faixa fica com o motor', async ($, on) => {
  engine(on, '[]')
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
