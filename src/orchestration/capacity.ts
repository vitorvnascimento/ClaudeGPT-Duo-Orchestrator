// Falta de capacidade do fornecedor ("model at capacity", "overloaded", 529/503): é passageira e, em geral, de um
// modelo só. Diferente da cota, não esgota a conta: o modelo fica indisponível por alguns minutos e a seleção
// procura outro de nível igual ou superior. Nada da conta é gravado.
import { join } from "node:path";
import type { Provider } from "../config.js";
import { readJson, type Store, writeJsonAtomic } from "../state/store.js";

export const CAPACITY_COOLDOWN_MS = 10 * 60 * 1000;

type CapacityEntry = { provider: Provider; model: string | null; until: string };

function capacityPath(store: Store): string {
  return join(store.base, "capacity-state.json");
}

function entries(store: Store, now: number): CapacityEntry[] {
  const raw = readJson<{ entries?: unknown }>(capacityPath(store));
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  return list.filter((e): e is CapacityEntry =>
    !!e && typeof e === "object"
    && ((e as CapacityEntry).provider === "claude" || (e as CapacityEntry).provider === "codex")
    && ((e as CapacityEntry).model === null || typeof (e as CapacityEntry).model === "string")
    && typeof (e as CapacityEntry).until === "string" && Date.parse((e as CapacityEntry).until) > now);
}

/** Registra falta de capacidade; sem modelo conhecido, vale para o modelo padrão do fornecedor (model=null). */
export function recordCapacity(store: Store, provider: Provider, model: string | null, now = Date.now()): string {
  const until = new Date(now + CAPACITY_COOLDOWN_MS).toISOString();
  const key = (e: CapacityEntry) => `${e.provider}:${e.model ?? ""}`.toLowerCase();
  const fresh: CapacityEntry = { provider, model, until };
  const kept = entries(store, now).filter((e) => key(e) !== key(fresh));
  writeJsonAtomic(capacityPath(store), { entries: [...kept, fresh] });
  return until;
}

/** Motivo do bloqueio se o modelo está sem capacidade agora; null se está livre. */
export function capacityBlock(store: Store, provider: Provider, model: string | null, now = Date.now()): string | null {
  const m = model?.toLowerCase() ?? null;
  const hit = entries(store, now).find((e) => e.provider === provider && (e.model?.toLowerCase() ?? null) === m);
  return hit ? `modelo ${model ?? "padrão"} sem capacidade no fornecedor até ${hit.until}` : null;
}
