#!/usr/bin/env node
// Lista os subagentes Codex ativos agora, em JSON: jobs queued/running do plugin openai-codex (todos os
// repositórios; job com pid morto não conta) e slots do duo no projeto da sessão (.duo/locks/slot-*.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const alive = (pid) => {
  if (pid == null) return true; // job ainda sem processo registrado
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// Campos vêm de arquivos que um repositório qualquer pode escrever: só texto, sem caracteres de controle
// (escape de terminal), com tamanho limitado.
const clean = (v, max = 80) => {
  if (typeof v !== 'string') return '';
  // Controles C0/C1 (escape de terminal) e de direção bidi (reordenam a linha); texto RTL comum fica.
  const t = [...v.replace(/[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu, '')]; // por code point: nunca parte um par substituto
  return t.slice(0, max).join('');
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const ativos = [];

const root = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'codex-openai-codex'), 'state');
let dirs = [];
try { dirs = fs.readdirSync(root); } catch {}
for (const d of dirs) {
  for (const j of readJson(path.join(root, d, 'state.json'))?.jobs ?? []) {
    if ((j.status !== 'queued' && j.status !== 'running') || !alive(j.pid)) continue;
    ativos.push({
      id: clean(j.id), kind: clean(j.kindLabel) || clean(j.kind) || 'Codex',
      repo: clean(path.basename(typeof j.workspaceRoot === 'string' && j.workspaceRoot ? j.workspaceRoot : d.replace(/-[0-9a-f]{16}$/, ''))),
      startedAt: Date.parse(j.startedAt || j.createdAt) || Date.now(),
      phase: j.status === 'queued' ? 'na fila' : clean(j.phase), source: 'codex',
    });
  }
}

const cwd = process.argv[2];
if (cwd) {
  const locks = path.join(cwd, '.duo', 'locks');
  let files = [];
  try { files = fs.readdirSync(locks).filter((f) => /^slot-\d+\.json$/.test(f)); } catch {}
  for (const f of files) {
    const s = readJson(path.join(locks, f));
    if (!s || !Number.isInteger(s.pid) || s.pid <= 0 || !alive(s.pid)) continue;
    ativos.push({
      id: clean(s.taskId), kind: `duo ${clean(s.kind)}`.trim(), repo: clean(path.basename(cwd)),
      startedAt: Date.parse(s.startedAt) || Date.now(), phase: clean(s.isolation), source: 'duo',
    });
  }
}

ativos.sort((a, b) => a.startedAt - b.startedAt);
process.stdout.write(JSON.stringify(ativos));
