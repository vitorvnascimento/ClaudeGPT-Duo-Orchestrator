#!/usr/bin/env node
// Lista os subagentes Codex ativos agora, em JSON: jobs queued/running do plugin openai-codex (todos os
// repositórios; job com pid morto não conta) e slots do duo no projeto da sessão (.duo/locks/slot-*.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const alive = (pid) => {
  if (pid == null) return true; // job ainda sem processo registrado
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
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
      id: j.id, kind: j.kindLabel || j.kind || 'Codex',
      repo: path.basename(j.workspaceRoot || d.replace(/-[0-9a-f]{16}$/, '')),
      startedAt: Date.parse(j.startedAt || j.createdAt) || Date.now(),
      phase: j.status === 'queued' ? 'na fila' : (j.phase || ''), source: 'codex',
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
    if (!s || !alive(s.pid)) continue;
    ativos.push({
      id: s.taskId, kind: `duo ${s.kind ?? ''}`.trim(), repo: path.basename(cwd),
      startedAt: Date.parse(s.startedAt) || Date.now(), phase: s.isolation ?? '', source: 'duo',
    });
  }
}

ativos.sort((a, b) => a.startedAt - b.startedAt);
process.stdout.write(JSON.stringify(ativos));
