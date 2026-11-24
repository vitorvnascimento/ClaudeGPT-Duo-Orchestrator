// Hook de teste da bateria do Windows no lugar do gate do duo. O duo chama o hook com [script, allowlist, log, prazo];
// os hooks da sonda (probe-win) gravam no argv[2]: tira a allowlist para que gravem no log do gate desta tentativa.
process.argv.splice(2, 1);
await import("../../fixtures/agy/probe-win/hooks/timeout.mjs");
