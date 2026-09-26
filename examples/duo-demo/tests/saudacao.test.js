import { strict as assert } from "node:assert";
import { test } from "node:test";
import { saudacao } from "../src/saudacao.js";

test("saudacao cumprimenta pelo nome", () => {
  assert.equal(saudacao("Ana"), "Olá, Ana!");
});
