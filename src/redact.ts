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

function redactPrivateKeys(text: string): string {
  const begin = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
  let beginMatch = begin.exec(text);
  if (!beginMatch) return text;
  let serialized = false;
  try {
    JSON.parse(text);
    serialized = true;
  } catch {}
  const end = serialized
    ? /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|\\[\s\S]|"/g
    : /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
  const parts: string[] = [];
  let cursor = 0;
  while (beginMatch) {
    parts.push(text.slice(cursor, beginMatch.index), "<redacted>");
    end.lastIndex = begin.lastIndex;
    let endMatch = end.exec(text);
    while (endMatch?.[0]?.startsWith("\\")) endMatch = end.exec(text);
    if (!endMatch) {
      cursor = text.length;
      break;
    }
    cursor = endMatch[0] === '"' ? endMatch.index : end.lastIndex;
    begin.lastIndex = end.lastIndex;
    beginMatch = begin.exec(text);
  }
  parts.push(text.slice(cursor));
  return parts.join("");
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
