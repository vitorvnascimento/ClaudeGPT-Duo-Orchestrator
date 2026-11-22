#!/usr/bin/env node
// Lista os subagentes ativos agora, em JSON: jobs queued/running do plugin openai-codex (todos os
// repositórios; job com pid morto não conta) e vagas do duo no projeto da sessão (.duo/locks/slot-*.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const alive = (pid) => {
  if (pid == null) return true; // job ainda sem processo registrado
  if (!Number.isInteger(pid) || pid <= 1) return false; // 1 = launchd/init: nunca é um executor
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// Campos vêm de arquivos que um repositório qualquer pode escrever: só texto, sem caracteres de controle
// (escape de terminal), separadores de linha nem controles bidi, com tamanho limitado.
const BAD = /^(?:[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Bidi_Control})$/u;
const clean = (v, max = 80) => {
  if (typeof v !== 'string') return '';
  // Percorre por code point (nunca parte um par substituto) e para ao juntar `max`.
  let out = '', n = 0;
  for (const ch of v) { if (BAD.test(ch)) continue; out += ch; if (++n >= max) break; }
  return out;
};
// Só arquivo regular e pequeno (nunca FIFO, /dev/zero por link etc.).
const MAX_BYTES = 256 * 1024;
const readJson = (p) => {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
};
const ativos = [];

const root = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'codex-openai-codex'), 'state');
let dirs = [];
try { dirs = fs.readdirSync(root).slice(0, 200); } catch {}
for (const d of dirs) {
  const jobs = readJson(path.join(root, d, 'state.json'))?.jobs;
  for (const j of Array.isArray(jobs) ? jobs.slice(0, 200) : []) {
    if (!j || (j.status !== 'queued' && j.status !== 'running') || !alive(j.pid)) continue;
    ativos.push({
      id: clean(j.id), kind: clean(j.kindLabel) || clean(j.kind) || 'Codex',
      repo: clean(path.basename(typeof j.workspaceRoot === 'string' && j.workspaceRoot ? j.workspaceRoot : d.replace(/-[0-9a-f]{16}$/, ''))),
      startedAt: Date.parse(j.startedAt || j.createdAt) || Date.now(),
      phase: j.status === 'queued' ? 'na fila' : clean(j.phase), source: 'codex',
    });
  }
}

// Vagas do duo: só os valores que o duo grava (enums e id de task); qualquer outro valor descarta a vaga.
const KINDS = new Set(['implement', 'review', 'test', 'investigate', 'asset']);
const ISOLATIONS = new Set(['in-place', 'worktree']);
const TASK_ID = /^task-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const cwd = process.argv[2];
if (cwd) {
  const locks = path.join(cwd, '.duo', 'locks');
  let files = [];
  try { files = fs.readdirSync(locks).filter((f) => /^slot-\d{1,4}\.json$/.test(f)).slice(0, 64); } catch {}
  for (const f of files) {
    const s = readJson(path.join(locks, f));
    if (!s || !alive(s.pid) || !KINDS.has(s.kind) || !ISOLATIONS.has(s.isolation) || typeof s.taskId !== 'string' || !TASK_ID.test(s.taskId)) continue;
    ativos.push({
      id: s.taskId, kind: `duo ${s.kind}`, repo: clean(path.basename(cwd)),
      startedAt: Date.parse(s.startedAt) || Date.now(), phase: s.isolation, source: 'duo',
    });
  }
}

ativos.sort((a, b) => a.startedAt - b.startedAt);
process.stdout.write(JSON.stringify(ativos.slice(0, 50)));
