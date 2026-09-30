import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { assessComplexity } from "../src/orchestration/complexity.js";

const req = { kind: "implement" as const, objective: "Adicionar uma constante", risk: "low" as const, acceptance: { criteria: ["constante exportada"], commands: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }] } };
const files = [{ rel: "src/app.ts", isDir: false }];
describe("complexidade e pisos I1/I2", () => {
  for (const [name, request, entries, tier] of [
    ["pequena com aceite", req, files, "light"],
    ["sem comando", { ...req, acceptance: { criteria: ["ok"] } }, files, "standard"],
    ["sem escopo", req, [], "standard"],
    ["risco alto", { ...req, risk: "high" as const }, files, "deep"],
    ["diretório inteiro", req, [{ rel: "src", isDir: true }], "standard"],
    ["mais arquivos", req, ["a", "b", "c", "d"].map((rel) => ({ rel, isDir: false })), "standard"],
    ["objetivo longo", { ...req, objective: "a".repeat(401) }, files, "standard"],
    ["review não trivial", { ...req, kind: "review" as const }, files, "standard"],
    ["aceite amplo", { ...req, acceptance: { ...req.acceptance, criteria: ["a", "b", "c", "d"] } }, files, "standard"],
  ] as const) it(name, () => assert.equal(assessComplexity({ ...request, acceptance: { ...request.acceptance, criteria: [...request.acceptance.criteria] } }, [...entries], []).tier, tier));
  for (const rel of ["auth/login.ts", "security.ts", "crypto.ts", "secret.ts", "token.ts", "password.ts", "migration.ts", "payment.ts", "billing.ts", ".github/workflows/build.yml", "db/schema.sql", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
    it(`sensível ${rel}`, () => assert.deepEqual(assessComplexity(req, [{ rel, isDir: false }], []).floor, "deep"));
  for (const objective of ["corrigir race condition", "resolver concorrência", "arquitetura", "architecture", "deadlock", "migration", "crypto", "protocol", "distributed", "otimização do hot path"])
    it(`palavras só sobem: ${objective}`, () => assert.equal(assessComplexity({ ...req, objective, complexity: "light" }, files, []).tier, "deep"));
  it("complexity explícita respeita pisos; palavras simples não baixam alto risco", () => {
    assert.equal(assessComplexity({ ...req, risk: "high", complexity: "light", objective: "simples" }, files, []).tier, "deep");
    assert.equal(assessComplexity({ ...req, complexity: "deep" }, files, []).tier, "deep");
    assert.equal(assessComplexity(req, files, ["security"]).tier, "deep");
    assert.equal(assessComplexity(req, [...files, { rel: "b.ts", isDir: false }], [], 1).floor, "standard");
  });
  it("refatoração ampla sobe; pequena mantém light", () => {
    assert.equal(assessComplexity({ ...req, objective: "refatorar" }, files, []).tier, "light");
    assert.equal(assessComplexity({ ...req, objective: "refactor" }, ["a", "b", "c", "d"].map((rel) => ({ rel, isDir: false })), []).tier, "deep");
  });
});
