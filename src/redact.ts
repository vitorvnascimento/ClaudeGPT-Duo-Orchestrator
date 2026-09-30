// Redação de segredos antes de qualquer persistência (logs, artefatos, telemetria).
const PATTERNS: RegExp[] = [
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|authorization)"?\s*[:=]\s*"?)[^"\s,}\\]{6,}/gi,
];

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

let envSecrets: string[] | undefined;

function secretEnvValues(): string[] {
  if (!envSecrets) {
    envSecrets = Object.entries(process.env)
      .filter(([k, v]) => SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length >= 8 && !/^([/~]|[A-Za-z]:\\)/.test(v))
      .map(([, v]) => v as string);
  }
  return envSecrets;
}

function redactPrivateKeyText(text: string, inside = false): { text: string; inside: boolean } {
  const delimiter = /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
  const parts: string[] = [];
  let cursor = 0;
  let blockStart = inside ? 0 : -1;
  for (let match = delimiter.exec(text); match; match = delimiter.exec(text)) {
    if (match[1] === "BEGIN") {
      if (!inside) blockStart = match.index;
      inside = true;
    } else {
      parts.push(text.slice(cursor, inside ? blockStart : cursor), "<redacted>");
      cursor = delimiter.lastIndex;
      blockStart = -1;
      inside = false;
    }
  }
  if (inside) {
    parts.push(text.slice(cursor, blockStart), "<redacted>");
    cursor = text.length;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), inside };
}

function mapPrivateKeyStrings(value: unknown, transform: (text: string) => string, keyTransform: (key: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapPrivateKeyStrings(item, transform, keyTransform));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [keyTransform(key), mapPrivateKeyStrings(item, transform, keyTransform)]));
  }
  return value;
}

/**
 * Nomes de propriedade são redigidos isoladamente (preservam a estrutura do evento), mas os delimitadores neles
 * movem o estado do bloco: um BEGIN numa chave (ex.: argumentos arbitrários de uma chamada MCP) redige os valores seguintes.
 */
function keyStepper(state: { inside: boolean; ended?: boolean }): (key: string) => string {
  return (key) => {
    if (!/-----(?:BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(key)) return key;
    if (/-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(key)) state.ended = true;
    state.inside = redactPrivateKeyText(key, state.inside).inside;
    return redactPrivateKeyText(key).text;
  };
}

function redactPrivateKeys(text: string): string {
  if (!/-----(?:BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactPrivateKeyText(text).text;
  }
  // O estado atravessa as strings: um bloco partido entre elementos (ex.: array de linhas) não vaza o corpo.
  const state = { inside: false };
  return JSON.stringify(mapPrivateKeyStrings(parsed, (value) => {
    const result = redactPrivateKeyText(value, state.inside);
    state.inside = result.inside;
    return result.text;
  }, keyStepper(state)));
}

export function createStreamRedactor(): (line: string) => string {
  const state: { inside: boolean; ended?: boolean } = { inside: false };
  return (line) => {
    const wasInside = state.inside;
    state.ended = false;
    const transform = (value: string): string => {
      if (/-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(value)) state.ended = true;
      const result = redactPrivateKeyText(value, state.inside);
      state.inside = result.inside;
      return result.text;
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return redact(transform(line));
    }
    const safe = mapPrivateKeyStrings(parsed, transform, keyStepper(state));
    if (wasInside && !state.ended) return JSON.stringify({ redacted: "private-key" });
    return redact(JSON.stringify(safe));
  };
}

export function redact(text: string): string {
  let out = text;
  for (const value of secretEnvValues()) {
    out = out.split(value).join("<redacted:env>");
  }
  out = redactPrivateKeys(out);
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix?: unknown) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}<redacted>` : "<redacted>",
    );
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}
