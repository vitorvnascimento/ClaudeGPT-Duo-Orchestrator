import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findRollout } from "./codex-rollout.js";

export type ComputerUseAction = {
  at: string; app: string | null; kind: "view" | "click" | "type" | "shortcut" | "scroll" | "other";
  inputBytes?: number; inputSha256?: string;
};
export type ComputerUseEvidence = {
  actions: ComputerUseAction[]; appsUsed: string[];
  screenshots: Array<{ path: string; sha256: string; bytes: number }>;
  permission: { kind: "app_permission"; app: string } | null;
  violations: string[]; warnings: string[];
};

const aliases: Record<string, string> = {
  "com.apple.finder": "finder", "com.apple.safari": "safari", "com.google.chrome": "googlechrome",
  chrome: "googlechrome",
  "com.apple.calculator": "calculator",
  "com.apple.mail": "mail", messages: "messages", imessage: "messages", "com.apple.ichat": "messages",
  "com.apple.messages": "messages", "com.apple.mobilesms": "messages",
  keychain: "keychainaccess", "com.apple.keychainaccess": "keychainaccess",
  "1password7": "1password", "1password8": "1password", "com.agilebits.onepassword": "1password",
  "com.agilebits.onepassword7": "1password", "com.1password.1password": "1password",
  "com.1password.1password7": "1password", "com.1password.1password8": "1password",
  "com.bitwarden.desktop": "bitwarden", "com.bitwarden.bitwarden": "bitwarden",
  systempreferences: "systemsettings", "com.apple.systempreferences": "systemsettings",
  "com.apple.systemsettings": "systemsettings", "com.apple.terminal": "terminal",
  iterm: "iterm2", "com.googlecode.iterm2": "iterm2", "com.iterm2.iterm2": "iterm2",
  settings: "systemsettings", "com.apple.preferences": "systemsettings", "com.apple.settings": "systemsettings",
  "com.apple.passwords": "passwords", "com.apple.scripteditor2": "scripteditor", "com.apple.shortcuts": "shortcuts",
  "com.apple.automator": "automator", "com.mitchellh.ghostty": "ghostty", "dev.warp.warpstable": "warp",
  "dev.warp.warppreview": "warp", "org.alacritty": "alacritty", "net.kovidgoyal.kitty": "kitty",
  "com.github.wez.wezterm": "wezterm", "co.zeit.hyper": "hyper", "com.anthropic.claudefordesktop": "claude",
  "com.apple.console": "console", "com.apple.activitymonitor": "activitymonitor", "com.apple.diskutility": "diskutility",
  "com.openai.codex": "codex", "com.openai.chat": "chatgpt", "com.openai.chatgpt": "chatgpt",
};
export const SENSITIVE_APP_NAMES: readonly string[] = Object.freeze([
  "passwords", "scripteditor", "shortcuts", "automator", "ghostty", "warp", "alacritty", "kitty", "wezterm",
  "hyper", "claude", "console", "activitymonitor", "diskutility",
  "mail", "messages", "keychainaccess", "1password", "bitwarden", "systemsettings", "terminal", "iterm2", "codex", "chatgpt",
]);

/** Only identities, never file paths or free-form tool/model text. Empty means invalid. */
export function canonicalAppId(app: string): string {
  if (app.length > 200 || !/^[\p{L}\p{N} ._()+-]+$/u.test(app)) return "";
  const key = app.trim().toLowerCase().replace(/\.(app|exe)$/, "").replace(/[\s_-]+/g, "");
  return Object.hasOwn(aliases, key) ? aliases[key]! : key;
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_LINE = 8 * 1024 * 1024;
const MAX_CALLS = 10_000;
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;

/** No raw fallback, including stderr, malformed JSON, agent prose and unknown event shapes. */
export function sanitizeComputerUseLine(line: string): string {
  const safeTypes = new Set(["item.started", "item.updated", "item.completed", "thread.started", "turn.started", "turn.completed", "turn.failed", "error", "response_item", "event_msg"]);
  const safeItems = new Set(["mcp_tool_call", "agent_message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "message", "command_execution"]);
  let event = "malformed";
  let itemType = "unknown";
  try {
    const record = obj(JSON.parse(line));
    event = typeof record.type === "string" && safeTypes.has(record.type) ? record.type : "unknown";
    const item = obj(record.item ?? record.payload);
    if (typeof item.type === "string" && safeItems.has(item.type)) itemType = item.type;
  } catch { /* intentionally retain no text */ }
  return JSON.stringify({ type: "computer_use_event", event, itemType, bytes: Buffer.byteLength(line), sha256: hash(line), omitted: true });
}

type Token = { text: string; value?: string; start: number; end: number };
type ParsedAction = Omit<ComputerUseAction, "at">;

/** A complete, deliberately narrow grammar, not a regex-based JavaScript auditor.
 * Accepts literal getApp bindings and awaited app methods with literal arguments.
 * Expressions, wrappers, computed access, control flow and interpolation fail closed.
 * Even accepted calls are after-the-fact evidence, never an execution sandbox.
 */
function parseCode(code: string, bindings: Map<string, string>): ParsedAction[] {
  if (Buffer.byteLength(code) > 64 * 1024) throw new Error("code_limit");
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < code.length) {
    if (/\s/.test(code[pos]!)) { pos++; continue; }
    if (code.startsWith("//", pos)) {
      while (pos < code.length && !/[\r\n\u2028\u2029]/.test(code[pos]!)) pos++;
      continue;
    }
    if (code.startsWith("/*", pos)) { const end = code.indexOf("*/", pos + 2); if (end < 0) throw new Error("comment"); pos = end + 2; continue; }
    const start = pos;
    const ch = code[pos]!;
    if (ch === '"' || ch === "'") {
      pos++;
      let value = "";
      let closed = false;
      while (pos < code.length) {
        const c = code[pos++]!;
        if (c === ch) { closed = true; break; }
        if (c === "\n" || c === "\r") throw new Error("string");
        if (c !== "\\") { value += c; continue; }
        const esc = code[pos++]!;
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "/": "/" };
        if (Object.hasOwn(simple, esc)) value += simple[esc];
        else if (esc === "u" || esc === "x") {
          const length = esc === "u" ? 4 : 2;
          const hex = code.slice(pos, pos + length);
          if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) throw new Error("escape");
          value += String.fromCharCode(parseInt(hex, 16)); pos += length;
        } else throw new Error("escape");
      }
      if (!closed) throw new Error("string");
      tokens.push({ text: "<string>", value, start, end: pos });
    } else {
      const match = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|(?:\d+(?:\.\d+)?))/.exec(code.slice(pos));
      if (match) pos += match[0].length;
      else if ("().,;:{}[]-".includes(ch) || ch === "=") pos++;
      else throw new Error("token");
      tokens.push({ text: code.slice(start, pos), start, end: pos });
    }
    if (tokens.length > 16_384) throw new Error("token_limit");
  }
  let i = 0;
  const peek = (): string | undefined => tokens[i]?.text;
  const take = (expected: string): void => { if (peek() !== expected) throw new Error("syntax"); i++; };
  const ident = (): string => { const t = peek(); if (!t || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) throw new Error("identifier"); i++; return t; };
  const literal = (depth = 0): void => {
    if (depth > 16) throw new Error("depth");
    const t = peek();
    if (t === "<string>" || t === "true" || t === "false" || t === "null" || (t && /^\d/.test(t))) { i++; return; }
    if (t === "-") { i++; if (!/^\d/.test(peek() ?? "")) throw new Error("number"); i++; return; }
    if (t === "[" || t === "{") {
      i++; const close = t === "[" ? "]" : "}";
      while (peek() !== close) {
        if (t === "{") {
          if (peek() === "<string>") i++; else ident();
          take(":");
        }
        literal(depth + 1);
        if (peek() !== close) { take(","); if (peek() === close) break; }
      }
      take(close); return;
    }
    throw new Error("nonliteral");
  };
  const actions: ParsedAction[] = [];
  const local = new Map(bindings);
  const kinds: Record<string, ComputerUseAction["kind"]> = {
    getScreenshot: "view", getAXState: "view", getAXStateAndScreenshot: "view",
    click: "click", drag: "click", scroll: "scroll", typeText: "type", paste: "type", setValue: "type", pressKey: "shortcut",
  };
  while (i < tokens.length) {
    let binding: string | undefined;
    if (["let", "const", "var"].includes(peek() ?? "")) { i++; binding = ident(); take("="); }
    else if (tokens[i + 1]?.text === "=") { binding = ident(); take("="); }
    if (binding === "cua" || binding === "await") throw new Error("binding");
    take("await");
    const target = ident(); take("."); const method = ident(); take("(");
    const begin = tokens[i - 1]!.end;
    let app: string;
    let kind: ComputerUseAction["kind"];
    if (target === "cua" && method === "getApp") {
      if (peek() !== "<string>") throw new Error("dynamic_app");
      app = canonicalAppId(tokens[i++]!.value!);
      if (!app || peek() !== ")") throw new Error("app");
      if (binding === "cua" || binding === "await") throw new Error("binding");
      if (binding) local.set(binding, app);
      kind = "view";
    } else {
      app = local.get(target) ?? "";
      if (!app || !Object.hasOwn(kinds, method)) throw new Error("target");
      // A result binding is not an app handle, even if it shadows an earlier handle.
      if (binding) local.delete(binding);
      kind = kinds[method]!;
      if (peek() !== ")") {
        literal();
        while (peek() === ",") { i++; literal(); }
      }
    }
    const end = tokens[i]?.start ?? code.length;
    take(")");
    const input = code.slice(begin, end);
    actions.push({ app, kind, inputBytes: Buffer.byteLength(input), inputSha256: hash(input) });
    if (peek() === ";") i++;
    // Without a separator only an actual newline can terminate an awaited statement.
    else if (i < tokens.length && !/[\r\n\u2028\u2029]/.test(code.slice(tokens[i - 1]!.end, tokens[i]!.start))) throw new Error("separator");
  }
  if (!actions.length) throw new Error("empty_code");
  if (local.size > MAX_CALLS) throw new Error("binding_limit");
  bindings.clear(); for (const [key, value] of local) bindings.set(key, value);
  return actions;
}

type Screenshot = { bytes: Buffer; extension: string };
type Call = { rejected: boolean; targets: string[]; signature: string; results: Set<string>; at: string };

export class ComputerUseCollector {
  private readonly evidence: ComputerUseEvidence = { actions: [], appsUsed: [], screenshots: [], permission: null, violations: [], warnings: [] };
  private readonly requested: Set<string> | undefined;
  private readonly dir: string;
  private readonly since: number;
  private readonly attemptSince: number;
  private readonly priorEvidence?: ComputerUseEvidence;
  private readonly bindings = new Map<string, string>();
  private readonly calls = new Map<string, Call>();
  private readonly streamCalls: Call[] = [];
  private readonly rolloutCalls = new Map<string, Call>();
  // Keep pixels private until both event sources have attributed the complete call.
  private readonly pendingImages = new Map<string, Screenshot>();
  private readonly callImages = new Map<Call, Set<string>>();
  private readonly screenshotHashes = new Set<string>();
  private readonly apps = new Set<string>();
  private readonly rolloutMatches = new Set<Call>();
  private readonly rolloutOnly: Call[] = [];
  private readonly streamMatches = new Set<Call>();

  constructor(options: { apps?: readonly string[]; artifactsDir: string; sinceMs: number; attemptSinceMs?: number; priorEvidence?: ComputerUseEvidence }) {
    this.dir = resolve(options.artifactsDir);
    this.since = options.sinceMs;
    this.priorEvidence = options.priorEvidence;
    this.attemptSince = options.attemptSinceMs ?? this.since;
    this.requested = options.apps === undefined ? undefined : new Set(options.apps.map(canonicalAppId).filter(Boolean));
    if (!Number.isFinite(this.since)) this.violate("invalid_since_boundary");
    if (options.apps && (options.apps.length > 20 || options.apps.some(app => !canonicalAppId(app)))) this.violate("invalid_requested_apps");
  }

  private violationCount = 0;
  get revision(): number { return this.violationCount + this.evidence.actions.length; }
  get hasViolations(): boolean { return this.violationCount > 0; }

  violate(message: string): void {
    this.violationCount++;
    if (this.evidence.violations.includes(message)) return;
    if (this.evidence.violations.length < 100) this.evidence.violations.push(message);
  }

  private addApp(app: string): void {
    if (!this.apps.has(app) && this.apps.size >= 100) { this.violate("app_identity_limit_exceeded"); return; }
    this.apps.add(app);
    if (this.requested && !this.requested.has(app)) this.violate(`unlisted_app:${app}`);
    if (SENSITIVE_APP_NAMES.includes(app)) this.violate(`denied_app:${app}`);
  }

  private timestamp(value: unknown, required = false): string | null {
    const ms = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : required ? NaN : Date.now();
    if (!Number.isFinite(new Date(ms).getTime()) || !Number.isFinite(this.since)) { this.violate("unauditable_timestamp"); return null; }
    if (ms < this.since) return null;
    return new Date(ms).toISOString();
  }

  private arguments(value: unknown): Record<string, unknown> | null {
    try { const parsed = typeof value === "string" ? JSON.parse(value) : value; if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null; return obj(parsed); }
    catch { return null; }
  }

  private signature(args: Record<string, unknown> | null): string {
    // Titles and JSON property ordering are not call identity. Pair equal code one-to-one.
    return hash(JSON.stringify(args && (typeof args.code === "string" && args.completion_summary === undefined ? ["code", args.code] : typeof args.completion_summary === "string" && args.code === undefined ? ["summary", args.completion_summary] : args)));
  }

  private ingestCall(args: Record<string, unknown> | null, at: string, bindings: Map<string, string>, existing?: Call): Call | undefined {
    if (this.calls.size + this.rolloutCalls.size >= MAX_CALLS) { this.violate("call_limit_exceeded"); return undefined; }
    const signature = this.signature(args);
    if (existing?.signature === signature) return existing;
    if (existing) {
      existing.rejected = true;
      this.violate("tool_arguments_changed");
      bindings.clear();
    }
    const call: Call = { rejected: !!existing, targets: [], signature, results: new Set(), at };
    if (!args) { call.rejected = true; this.violate("unparseable_call"); bindings.clear(); return call; }
    if (typeof args.completion_summary === "string" && args.code === undefined) return call;
    if (typeof args.code !== "string" || !args.code.trim() || args.completion_summary !== undefined) {
      call.rejected = true; this.violate("unparseable_call"); bindings.clear(); return call;
    }
    try {
      const actions = parseCode(args.code, bindings);
      if (this.evidence.actions.length + actions.length > MAX_CALLS) { call.rejected = true; this.violate("action_limit_exceeded"); return call; }
      const before = this.violationCount;
      call.targets = actions.map(action => action.app!);
      for (const action of actions) { this.addApp(action.app!); this.evidence.actions.push({ at, ...action }); }
      call.rejected ||= before !== this.violationCount;
    } catch {
      call.rejected = true;
      bindings.clear();
      this.violate("unparseable_call");
      this.evidence.actions.push({ at, app: null, kind: "other", inputBytes: Buffer.byteLength(args.code), inputSha256: hash(args.code) });
    }
    return call;
  }

  private sameAttempt(a: string, b: string): boolean {
    return (Date.parse(a) >= this.attemptSince) === (Date.parse(b) >= this.attemptSince);
  }

  private replay(code: string, bindings: Map<string, string>, call: Call, at: string): void {
    try {
      const actions = parseCode(code, bindings);
      for (const [i, action] of actions.entries()) {
        if (action.app === call.targets[i]) continue;
        call.rejected = true;
        this.violate("tool_target_changed");
        this.addApp(action.app!);
        if (this.evidence.actions.length < MAX_CALLS) this.evidence.actions.push({ at, ...action });
        else this.violate("action_limit_exceeded");
      }
    } catch {
      call.rejected = true;
      bindings.clear();
      this.violate("unparseable_call");
    }
  }

  onLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_LINE) { this.violate("stream_line_limit_exceeded"); this.bindings.clear(); return; }
    let record: Record<string, unknown>;
    try { record = obj(JSON.parse(line)); } catch { this.violate("unauditable_stream_line"); this.bindings.clear(); return; }
    const item = obj(record.item);
    const type = String(item.type);
    if (!type.endsWith("_call") && type !== "command_execution" && type !== "web_search" && item.server === undefined && item.tool === undefined) return;
    if (!["item.started", "item.updated", "item.completed"].includes(String(record.type))) {
      this.violate("unparseable_call");
      this.bindings.clear();
      return;
    }
    const at = this.timestamp(record.timestamp ?? item.timestamp);
    if (!at) { this.bindings.clear(); return; }
    if (item.type === "custom_tool_call" || (item.server === "functions" && item.tool === "exec")) { this.violate("unauditable_nested_tool_call"); this.bindings.clear(); return; }
    if (item.type !== "mcp_tool_call" || item.server !== "cua_repl") {
      this.violate("unauditable_other_tool_call"); this.bindings.clear(); return;
    }
    if (item.tool !== "js") { this.violate("unauditable_cua_tool"); this.bindings.clear(); return; }
    if (typeof item.id !== "string" || !item.id || item.id.length > 256) { this.violate("unauditable_call_identity"); this.bindings.clear(); return; }
    let call = this.calls.get(item.id);
    if (item.arguments !== undefined) {
      const args = this.arguments(item.arguments);
      const backfilled = !call ? this.rolloutOnly.find(prior => this.sameAttempt(prior.at, at) && prior.signature === this.signature(args) && !this.streamMatches.has(prior)) : undefined;
      if (backfilled) {
        this.streamMatches.add(backfilled);
        if (typeof args?.code === "string") this.replay(args.code, this.bindings, backfilled, at);
      }
      const next = this.ingestCall(args, at, this.bindings, call ?? backfilled);
      if (next && next !== call) {
        this.calls.set(item.id, next);
        this.streamCalls.push(next);
      }
      call = next;
    }
    if (!call) {
      this.violate("unparseable_call");
      this.violate("unauditable_missing_call_arguments");
      this.bindings.clear();
      // Still extract a real permission denial even when the call arguments were lost.
      call = { rejected: true, targets: [], signature: "missing", results: new Set(), at };
    }
    if (item.error != null) this.result({ error: item.error }, call);
    if (item.result !== undefined) this.result(item.result, call);
  }

  auditSession(codexHome: string, threadId: string): string | null {
    let file: string | null = null;
    try { file = findRollout(codexHome, threadId, this.since); }
    catch { /* Inaccessible directories also fail the audit. */ }
    if (file) this.readRollout(file, threadId);
    else this.violate("rollout_missing");
    return file;
  }

  /** Actual session identity is checked before any backfill is ingested. Old calls only
   * reconstruct literal app bindings; they cannot contribute actions or images. */
  readRollout(file: string, threadId: string): void {
    let lines: string[];
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) { this.violate("rollout_missing"); return; }
      if (stat.size > 64 * 1024 * 1024) { this.violate("rollout_size_limit_exceeded"); return; }
      lines = readFileSync(file, "utf8").split("\n", 100_001);
      if (lines.length > 100_000) { this.violate("rollout_record_limit_exceeded"); return; }
      lines = lines.filter(line => line.trim());
    } catch { this.violate("rollout_missing"); return; }
    const records: Record<string, unknown>[] = [];
    let session = false;
    for (const line of lines) {
      if (Buffer.byteLength(line) > MAX_LINE) { this.violate("rollout_line_limit_exceeded"); return; }
      try {
        const r = obj(JSON.parse(line)); records.push(r);
        if (r.type === "session_meta") {
          if (!threadId || obj(r.payload).id !== threadId) { this.violate("rollout_session_mismatch"); return; }
          session = true;
        }
      } catch { this.violate("rollout_missing"); this.violate("unauditable_rollout_line"); return; }
    }
    if (!session) { this.violate("rollout_missing"); this.violate("rollout_session_missing"); return; }
    const bindings = new Map<string, string>();
    const active = new Map<string, Call>();
    for (const r of records) {
      if (r.type !== "response_item") continue;
      const p = obj(r.payload);
      if (p.type === "custom_tool_call") {
        if (this.timestamp(r.timestamp, true)) this.violate("unauditable_nested_tool_call");
        bindings.clear(); continue;
      }
      if (p.type === "function_call" && (p.name === "mcp__cua_repl__js" || (p.name === "js" && p.namespace === "mcp__cua_repl"))) {
        const args = this.arguments(p.arguments);
        const at = this.timestamp(r.timestamp, true);
        if (!at) {
          // Reconstruct state only for valid timestamps strictly before the task.
          if (typeof r.timestamp === "string" && Date.parse(r.timestamp) < this.since && typeof args?.code === "string") {
            try { parseCode(args.code, bindings); } catch { bindings.clear(); }
          }
          continue;
        }
        const id = string(p.call_id);
        if (!id || id.length > 256) { this.violate("unauditable_call_identity"); bindings.clear(); continue; }
        const prior = this.rolloutCalls.get(id);
        const signature = this.signature(args);
        const byId = this.calls.get(id);
        const matched = prior ?? (byId && this.sameAttempt(byId.at, at) ? byId : undefined)
          ?? this.streamCalls.find(call => this.sameAttempt(call.at, at) && call.signature === signature && !this.rolloutMatches.has(call));
        if (matched) {
          if (matched.signature !== signature) {
            const changed = this.ingestCall(args, at, bindings, matched);
            if (changed) { this.rolloutCalls.set(id, changed); active.set(id, changed); }
            continue;
          }
          if (typeof args?.code === "string") this.replay(args.code, bindings, matched, at);
          this.rolloutMatches.add(matched);
          this.rolloutCalls.set(id, matched); active.set(id, matched);
        } else {
          const call = this.ingestCall(args, at, bindings);
          if (call) { this.rolloutCalls.set(id, call); active.set(id, call); this.rolloutOnly.push(call); }
        }
      } else if (p.type === "function_call_output") {
        const call = active.get(string(p.call_id) ?? "");
        if (!this.timestamp(r.timestamp, true)) continue;
        if (call) this.result(p.output, call, true);
        else this.violate("unparseable_call");
      } else if (p.type === "function_call" || String(p.type).endsWith("_call")) {
        if (this.timestamp(r.timestamp, true)) this.violate(p.namespace === "mcp__cua_repl" || String(p.name).startsWith("mcp__cua_repl__") ? "unauditable_cua_tool" : "unauditable_other_tool_call");
        bindings.clear();
      }
    }
  }

  private result(value: unknown, call: Call, serialized = false): void {
    const digest = hash(JSON.stringify(value));
    if (call.results.has(digest)) return;
    if (call.results.size >= 100) { call.rejected = true; this.violate("result_limit_exceeded"); return; }
    call.results.add(digest);
    let envelope = value;
    if (serialized && typeof value === "string") {
      try { envelope = JSON.parse(value); } catch { return; }
    }
    const root = obj(envelope);
    const error = string(root.error) ?? string(obj(root.error).message);
    const denial = error && /\bComputer Use was not approved to use ([^\r\n]+)/.exec(error);
    if (denial) {
      call.rejected = true;
      const display = denial[1]!.trim().replace(/\.$/, "");
      const app = canonicalAppId(display);
      if (!app) this.violate("unauditable_permission_target");
      else {
        this.addApp(app);
        if (Date.parse(call.at) >= this.attemptSince) {
          this.evidence.permission = { kind: "app_permission", app: display };
          this.violate("app_permission_denied");
        }
      }
    }
    if (call.rejected) return;
    const blocks = Array.isArray(envelope) ? envelope : root.content;
    if (!Array.isArray(blocks)) return;
    const images = new Map<string, Screenshot>();
    for (const entry of blocks) {
      const block = obj(entry);
      if (!["image", "image_url", "input_image", "output_image"].includes(String(block.type))) continue;
      const image = this.decodeImage(block);
      if (!image) { call.rejected = true; return; }
      images.set(hash(image.bytes), image);
    }
    if (!images.size) return;
    if (new Set([...this.pendingImages.keys(), ...images.keys()]).size > 20) {
      call.rejected = true;
      this.violate("screenshot_count_limit_exceeded");
      return;
    }
    const hashes = this.callImages.get(call) ?? new Set<string>();
    for (const [digest, image] of images) {
      this.pendingImages.set(digest, image);
      hashes.add(digest);
    }
    this.callImages.set(call, hashes);
  }

  private decodeImage(block: Record<string, unknown>): Screenshot | undefined {
    let mime = string(block.mimeType ?? block.mime_type);
    let data = string(block.data);
    const url = string(block.image_url) ?? string(obj(block.image_url).url) ?? string(block.url);
    if (!data && url) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (match) { mime = match[1]; data = match[2]; }
    }
    if (!data || data.length > Math.ceil(MAX_IMAGE / 3) * 4) { this.violate("screenshot_invalid_or_oversize"); return; }
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) { this.violate("screenshot_invalid_base64"); return; }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_IMAGE || bytes.toString("base64") !== data) { this.violate("screenshot_invalid_or_oversize"); return; }
    const extension = imageFormat(bytes);
    if (!extension || mime !== `image/${extension === "jpg" ? "jpeg" : extension}`) { this.violate("screenshot_invalid_format"); return; }
    return { bytes, extension };
  }

  private saveImages(images: Map<string, Screenshot>): void {
    const created: string[] = [];
    const verified: ComputerUseEvidence["screenshots"] = [];
    try {
      // Validate/create one directory at a time, before any file is opened.
      // O_NOFOLLOW on the image alone would still follow ancestor symlinks.
      const parents: string[] = [];
      for (let dir = this.dir; dirname(dir) !== dir; dir = dirname(dir)) parents.push(dir);
      for (const dir of parents.reverse()) {
        try { if (!lstatSync(dir).isDirectory()) throw new Error("unsafe directory"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          mkdirSync(dir, { mode: 0o700 });
        }
      }
      // Recount disk artifacts before every write: a resumed collector shares the
      // task's quota. Unrelated files and image-shaped symlinks are never evidence.
      const owned = this.ownedImages();
      for (const [digest, image] of images) owned.add(`computer-use-${digest}.${image.extension}`);
      if (owned.size > 20) { this.violate("screenshot_count_limit_exceeded"); return; }
      for (const [sha256, { bytes, extension }] of images) {
        if (this.screenshotHashes.has(sha256)) continue;
        const path = join(this.dir, `computer-use-${sha256}.${extension}`);
        let fd: number | undefined;
        try {
          try {
            fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            created.push(path);
            writeFileSync(fd, bytes);
          } catch (error) {
            if (fd !== undefined || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || stat.size !== bytes.length || hash(readFileSync(fd)) !== sha256) throw new Error("unsafe artifact");
          }
        } finally { if (fd !== undefined) closeSync(fd); }
        verified.push({ path, sha256, bytes: bytes.length });
      }
      for (const image of verified) this.screenshotHashes.add(image.sha256);
      this.evidence.screenshots.push(...verified);
    } catch {
      this.violate("screenshot_write_failed_or_unsafe_path");
      for (const path of created) {
        try { unlinkSync(path); } catch { this.violate("screenshot_cleanup_failed"); }
      }
    }
  }

  private ownedImages(): Set<string> {
    const owned = new Set<string>();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      const match = /^computer-use-([a-f0-9]{64})\.(png|jpg)$/.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      let fd: number | undefined;
      try {
        fd = openSync(join(this.dir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_IMAGE) continue;
        const bytes = readFileSync(fd);
        if (bytes.length === stat.size && imageFormat(bytes) === match[2] && hash(bytes) === match[1]) owned.add(entry.name);
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    return owned;
  }

  finish(reportedApps?: readonly string[]): ComputerUseEvidence {
    for (const [call, hashes] of this.callImages) {
      if (call.rejected) continue;
      const unseen = [...hashes].filter(id => !this.screenshotHashes.has(id));
      if (unseen.length) this.saveImages(new Map(unseen.map(id => [id, this.pendingImages.get(id)!])));
    }
    this.callImages.clear();
    this.pendingImages.clear();
    return this.snapshot(reportedApps);
  }

  snapshot(reportedApps?: readonly string[]): ComputerUseEvidence {
    const evidence: ComputerUseEvidence = {
      actions: this.evidence.actions.map(action => ({ ...action })),
      appsUsed: [...this.apps].sort(),
      screenshots: this.evidence.screenshots.map(image => ({ ...image })),
      permission: this.evidence.permission ? { ...this.evidence.permission } : null,
      violations: [...this.evidence.violations],
      warnings: [],
    };
    const priorEvidence = this.priorEvidence;
    if (priorEvidence) {
      // Reconcile historical rollout actions with prior stream observations one-to-one.
      const key = (action: typeof evidence.actions[number]) => JSON.stringify([action.app, action.kind, action.inputSha256]);
      const counts = new Map<string, number>();
      for (const action of priorEvidence.actions) counts.set(key(action), (counts.get(key(action)) ?? 0) + 1);
      evidence.actions = [...priorEvidence.actions, ...evidence.actions.filter(action => {
        if (Date.parse(action.at) >= this.attemptSince) return true;
        const id = key(action);
        const count = counts.get(id) ?? 0;
        if (!count) return true;
        counts.set(id, count - 1);
        return false;
      })];
      evidence.appsUsed = [...new Set([...priorEvidence.appsUsed, ...evidence.appsUsed])].sort();
      evidence.screenshots = [...new Map([...priorEvidence.screenshots, ...evidence.screenshots].map(img => [img.sha256, img])).values()];
      evidence.violations = [...new Set([...priorEvidence.violations.filter(v => v !== "app_permission_denied"), ...evidence.violations])];
    }
    if (reportedApps) {
      const reported = new Set(reportedApps.map(canonicalAppId));
      if (reportedApps.length > 20 || reported.has("") || reported.size !== evidence.appsUsed.length ||
          evidence.appsUsed.some(app => !reported.has(app))) evidence.violations.push("reported_apps_mismatch");
    } else if (evidence.appsUsed.length) evidence.warnings.push("reported_apps_missing");
    return evidence;
  }
}

function imageFormat(bytes: Buffer): "png" | "jpg" | null {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8; let header = false; let data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return null;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (!header && (type !== "IHDR" || length !== 13 || bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0)) return null;
      header = true;
      // CRC covers the chunk type and bytes; rejecting corrupt/truncated containers is cheap.
      let crc = 0xffffffff;
      for (let n = offset + 4; n < offset + 8 + length; n++) {
        crc ^= bytes[n]!;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(offset + 8 + length)) return null;
      if (type === "IDAT") data = true;
      offset += length + 12;
      if (type === "IEND") return length === 0 && data && offset === bytes.length ? "png" : null;
    }
    return null;
  }
  // Native getScreenshot forwards the screenshot bytes to nodeRepl.emitImage;
  // the installed docs permit JPEG as well as PNG. Validate the JPEG container
  // (frame dimensions, segment bounds, scan and EOI), without claiming to decode it.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2; let frame = false; let scan = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9) return frame && scan && offset === bytes.length ? "jpg" : null;
      if (marker === undefined || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const components = bytes[offset + 7];
        if (length < 11 || !components || length !== 8 + 3 * components || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) return null;
        frame = true;
      }
      if (marker === 0xda) {
        const components = bytes[offset + 2];
        if (!frame || !components || length !== 6 + 2 * components) return null;
        scan = true;
        offset += length;
        const start = offset;
        // Entropy bytes escape FF as FF00; restart markers remain inside scans.
        while (offset < bytes.length) {
          if (bytes[offset] !== 0xff) { offset++; continue; }
          let next = offset + 1;
          while (bytes[next] === 0xff) next++;
          const code = bytes[next];
          if (code === 0x00 || (code !== undefined && code >= 0xd0 && code <= 0xd7)) { offset = next + 1; continue; }
          break;
        }
        if (offset === start) return null;
      } else offset += length;
    }
  }
  return null;
}
