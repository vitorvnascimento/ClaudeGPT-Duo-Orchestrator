import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createStreamRedactor, redact, redactDeep } from "../src/redact.js";
import { sanitizeEventLine } from "../src/adapters/sanitize.js";

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
    assert.deepEqual(redactDeep(input), { ...input, begin: "<redacted>", end: "<redacted>" });
  });

  it("redige PEM truncado até o fim do texto, inclusive BEGINs repetidos", () => {
    const truncated = "-----BEGIN PRIVATE KEY-----\nMIIEsecretbody truncated";
    assert.equal(redact(`log: ${truncated}`), "log: <redacted>");
    assert.equal(redact(`${truncated}\n${truncated}`), "<redacted>");
    assert.equal(redact(`log: ${truncated}\n"conteúdo privado" \\`), "log: <redacted>");
  });

  it("redige cauda truncada com END sem BEGIN até o delimitador", () => {
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "OPENSSH PRIVATE KEY"]) {
      const tail = `cHJpdmF0ZS1rZXk=\n-----END ${label}-----\npúblico`;
      assert.equal(redact(tail), "<redacted>\npúblico");
      assert.deepEqual(redactDeep({ tail, after: "público" }), { tail: "<redacted>\npúblico", after: "público" });
    }
  });

  it("redactDeep falha fechado em PEM truncado: preserva o que vem antes e redige o que vem depois do bloco aberto", () => {
    for (const ending of ["", "\n-----END PRIVATE KEY-----"]) {
      const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretbody${ending}`;
      const neighbor = 'texto "vizinho" \\';
      const input = { before: neighbor, output: `log: ${pem}`, after: neighbor, items: [pem, `${pem}\n"aspas" \\`, `${pem}\\`] };
      const suffix = ending ? '\n"aspas" \\' : "";
      const expected = ending
        ? { before: neighbor, output: "log: <redacted>", after: neighbor, items: ["<redacted>", `<redacted>${suffix}`, "<redacted>\\"] }
        : { before: neighbor, output: "log: <redacted>", after: "<redacted>", items: ["<redacted>", "<redacted>", "<redacted>"] };
      assert.deepEqual(redactDeep(input), expected);
      assert.deepEqual(JSON.parse(redact(JSON.stringify(input))), expected);
      assert.ok(!JSON.stringify(redactDeep(input)).includes("MIIEsecretbody"));
    }
  });

  it("redactDeep não vaza o corpo de um PEM partido entre strings (ex.: array de linhas)", () => {
    const lines = ["-----BEGIN PRIVATE KEY-----", "MIIEsecretbody1", "MIIEsecretbody2", "-----END PRIVATE KEY-----", "depois"];
    const output = redactDeep({ antes: "antes", lines });
    assert.deepEqual(output, { antes: "antes", lines: ["<redacted>", "<redacted>", "<redacted>", "<redacted>", "depois"] });
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

describe("redação por stream", () => {
  const begin = "-----BEGIN PRIVATE KEY-----";
  const end = "-----END PRIVATE KEY-----";

  it("redige linhas de PEM até END e retoma redação normal no sufixo", () => {
    const stream = createStreamRedactor();
    assert.equal(stream(`antes ${begin}`), "antes <redacted>");
    assert.equal(stream("cHJpdmF0ZS1rZXk="), "<redacted>");
    assert.equal(stream(`corpo ${end} depois sk-${"a".repeat(20)}`), "<redacted> depois <redacted>");
    assert.equal(stream("público"), "público");
  });

  it("deltas JSON dentro do bloco são marcações válidas e preservam sufixo após END", () => {
    const stream = createStreamRedactor();
    const delta = (text: string) => JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text } } });
    assert.equal(JSON.parse(stream(delta(begin))).event.delta.text, "<redacted>");
    assert.deepEqual(JSON.parse(stream(delta("cHJpdmF0ZS1rZXk="))), { redacted: "private-key" });
    assert.equal(JSON.parse(stream(delta(`${end} público`))).event.delta.text, "<redacted> público");
    assert.equal(stream(delta("público")), delta("público"));
  });

  it("EOF sem END falha fechado, sem contaminar outro stream", () => {
    const stream = createStreamRedactor();
    stream(JSON.stringify({ text: begin }));
    assert.deepEqual(JSON.parse(stream(JSON.stringify({ text: "corpo" }))), { redacted: "private-key" });
    assert.equal(stream("mesmo sem JSON"), "<redacted>");
    assert.equal(createStreamRedactor()("outro stream"), "outro stream");
  });

  it("BEGIN além do truncamento de logs ainda inicia redação antes de cortar a linha", () => {
    const stream = createStreamRedactor();
    sanitizeEventLine("codex", `${"x".repeat(2100)}${begin}`, stream);
    assert.equal(sanitizeEventLine("codex", "cHJpdmF0ZS1rZXk=", stream), "<redacted>");
    sanitizeEventLine("codex", end, stream);
    assert.equal(sanitizeEventLine("codex", "público", stream), "público");
  });

  it("raciocínio continua omitido quando um bloco aberto num evento anterior redige o campo type", () => {
    const codex = createStreamRedactor();
    const reasoning = (text: string) => JSON.stringify({ type: "item.completed", item: { id: "r1", type: "reasoning", text } });
    for (const text of [`pensando ${begin}`, `${end} RACIOCINIO_INTERNO`]) {
      const out = sanitizeEventLine("codex", reasoning(text), codex);
      assert.ok(!out.includes("RACIOCINIO_INTERNO") && !out.includes("pensando"), out);
      assert.equal(JSON.parse(out).item.omitted, true);
    }
    const claude = createStreamRedactor();
    const message = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
    sanitizeEventLine("claude", message([{ type: "thinking", thinking: `pensando ${begin}` }]), claude);
    const out = sanitizeEventLine("claude", message([{ type: "thinking", thinking: `${end} RACIOCINIO_INTERNO` }, { type: "text", text: "resposta" }]), claude);
    assert.ok(!out.includes("RACIOCINIO_INTERNO"), out);
    assert.deepEqual(JSON.parse(out).message.content, [{ type: "thinking", omitted: true }, { type: "text", text: "resposta" }]);
  });

  it("BEGIN numa chave JSON (ex.: argumentos MCP) redige os valores seguintes", () => {
    const event = { type: "item.completed", item: { type: "mcp_tool_call", arguments: { [begin]: "MIIEsecretbody", tail: end, depois: "público" } } };
    for (const out of [redact(JSON.stringify(event)), createStreamRedactor()(JSON.stringify(event))]) {
      assert.ok(!out.includes("MIIEsecretbody"), out);
      assert.deepEqual(JSON.parse(out).item.arguments, { "<redacted>": "<redacted>", tail: "<redacted>", depois: "público" });
    }
  });

  it("redige 1,25 MiB linearmente, inclusive múltiplos blocos na mesma linha", () => {
    const block = `${begin}\n${"a".repeat(50)}\n${end}\n`;
    const text = block.repeat(Math.ceil(1.25 * 1024 * 1024 / block.length));
    const stream = createStreamRedactor();
    const started = performance.now();
    const output = stream(JSON.stringify({ text }));
    const elapsed = performance.now() - started;
    assert.ok(!output.includes(begin) && !output.includes(end) && !output.includes("a".repeat(50)));
    assert.ok(elapsed < 1000, `redação de ${text.length} bytes levou ${elapsed.toFixed(1)} ms`);
    assert.equal(stream("público"), "público");
  });
});
