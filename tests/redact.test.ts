import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { redact, redactDeep } from "../src/redact.js";

describe("formatos adicionais de segredos", () => {
  it("redige Google API keys com exatamente 35 caracteres após AIza", () => {
    const token = `AIza${"aZ09_-".repeat(5)}abcde`;
    assert.equal(redact(`saída: ${token}.`), "saída: <redacted>.");
    assert.equal(redact(token.slice(0, -1)), token.slice(0, -1));
    assert.equal(redact(`${token}a`), `${token}a`);
  });

  for (const prefix of ["sk_live_", "sk_test_", "rk_live_", "rk_test_"]) {
    it(`redige Stripe ${prefix} com pelo menos 16 caracteres alfanuméricos`, () => {
      for (const length of [16, 32]) {
        assert.equal(redact(`token: ${prefix}${"aZ09".repeat(length / 4)}`), "token: <redacted>");
      }
      const shortToken = `${prefix}${"a".repeat(15)}`;
      assert.equal(redact(shortToken), shortToken);
    });
  }

  it("redige npm tokens com exatamente 36 caracteres alfanuméricos", () => {
    const token = `npm_${"aZ09".repeat(9)}`;
    assert.equal(redact(`(${token})`), "(<redacted>)");
    assert.equal(redact(token.slice(0, -1)), token.slice(0, -1));
    assert.equal(redact(`${token}a`), `${token}a`);
  });

  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "OPENSSH PRIVATE KEY"]) {
    it(`redige blocos PEM ${label} com quebras reais ou escapadas`, () => {
      for (const newline of ["\n", "\r\n", "\\n", "\\r\\n"]) {
        const pem = `-----BEGIN ${label}-----${newline}cHJpdmF0ZS1rZXk=${newline}-----END ${label}-----`;
        assert.equal(redact(`antes${newline}${pem}${newline}depois`), `antes${newline}<redacted>${newline}depois`);
      }
    });
  }

  it("redactDeep remove PEM de objetos e arrays sem corromper JSON ou alterar a entrada", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\ncHJpdmF0ZS1rZXk=\n-----END RSA PRIVATE KEY-----";
    const input = { output: pem, nested: { secret: pem, text: `antes\n${pem}\ndepois` }, items: [pem], count: 3 };
    const expected = { output: "<redacted>", nested: { secret: "<redacted>", text: "antes\n<redacted>\ndepois" }, items: ["<redacted>"], count: 3 };
    assert.deepEqual(redactDeep(input), expected);
    assert.deepEqual(JSON.parse(redact(JSON.stringify(input))), expected);
    assert.equal(input.output, pem);
  });

  it("redige múltiplos blocos separadamente e aceita END privado com outro rótulo", () => {
    const rsa = "-----BEGIN RSA PRIVATE KEY-----\nYWJj\n-----END RSA PRIVATE KEY-----";
    const ec = "-----BEGIN EC PRIVATE KEY-----\nZGVm\n-----END EC PRIVATE KEY-----";
    assert.equal(redact(`${rsa}\ntexto\n${ec}`), "<redacted>\ntexto\n<redacted>");
    for (const label of ["PRIVATE KEY", "EC PRIVATE KEY"]) {
      const mismatched = rsa.replace("END RSA PRIVATE KEY", `END ${label}`);
      assert.equal(redact(mismatched), "<redacted>");
    }
  });

  it("não combina delimitadores PEM pertencentes a strings JSON diferentes", () => {
    const input = { begin: "-----BEGIN PRIVATE KEY-----\nYWJj", end: "-----END PRIVATE KEY-----", count: 3 };
    assert.deepEqual(redactDeep(input), { ...input, begin: "<redacted>" });
  });

  it("redige PEM truncado até o fim do texto, inclusive BEGINs repetidos", () => {
    const truncated = "-----BEGIN PRIVATE KEY-----\nMIIEsecretbody truncated";
    assert.equal(redact(`log: ${truncated}`), "log: <redacted>");
    assert.equal(redact(`${truncated}\n${truncated}`), "<redacted>");
    assert.equal(redact(`log: ${truncated}\n"conteúdo privado" \\`), "log: <redacted>");
  });

  it("redactDeep falha fechado em PEM truncado ou com rótulos diferentes sem afetar strings vizinhas", () => {
    for (const ending of ["", "\n-----END PRIVATE KEY-----"]) {
      const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretbody${ending}`;
      const neighbor = 'texto "vizinho" \\';
      const input = { before: neighbor, output: `log: ${pem}`, after: neighbor, items: [pem, `${pem}\n"aspas" \\`, `${pem}\\`] };
      const suffix = ending ? '\n"aspas" \\' : "";
      const expected = { before: neighbor, output: "log: <redacted>", after: neighbor, items: ["<redacted>", `<redacted>${suffix}`, `<redacted>${ending ? "\\" : ""}`] };
      assert.deepEqual(redactDeep(input), expected);
      assert.deepEqual(JSON.parse(redact(JSON.stringify(input))), expected);
      assert.ok(!JSON.stringify(redactDeep(input)).includes("MIIEsecretbody"));
    }
  });

  it("redige 2 MiB de BEGINs sem END em menos de um segundo", () => {
    const line = `-----BEGIN PRIVATE KEY-----\n${"a".repeat(50)}\n`;
    const text = line.repeat(Math.ceil(2 * 1024 * 1024 / line.length));
    const started = performance.now();
    const output = redact(text);
    const elapsed = performance.now() - started;
    assert.equal(output, "<redacted>");
    assert.ok(elapsed < 1000, `redação de ${text.length} bytes levou ${elapsed.toFixed(1)} ms`);
  });

  it("preserva hashes git, UUIDs, palavras e caminhos comuns", () => {
    const text = "0123456789abcdef0123456789abcdef01234567 550e8400-e29b-41d4-a716-446655440000 AIza npm_config_cache /repo/src/redact.ts";
    assert.equal(redact(text), text);
  });

  it("preserva blocos PEM públicos e certificados", () => {
    for (const label of ["PUBLIC KEY", "RSA PUBLIC KEY", "CERTIFICATE"]) {
      const pem = `-----BEGIN ${label}-----\nYWJj\n-----END ${label}-----`;
      assert.equal(redact(pem), pem);
    }
  });
});
