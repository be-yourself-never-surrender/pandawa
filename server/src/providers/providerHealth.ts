import { decryptSecret } from "../auth/cryptoVault.js";
import type { ProviderRecord } from "./llmClient.js";

export type ProviderHealthStatus = "ready" | "no_key" | "error" | "disabled" | "unchecked";

export interface ProviderHealthSnapshot {
  status: ProviderHealthStatus;
  latencyMs?: number;
  error?: string;
  checkedAt?: string;
}

interface CachedHealthEntry {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

const healthCache = new Map<string, CachedHealthEntry>();

export function recordProviderHealth(
  providerId: string,
  result: { ok: boolean; latencyMs?: number; error?: string; detail?: string }
): void {
  if (!providerId) return;
  healthCache.set(providerId, {
    ok: Boolean(result.ok),
    ...(typeof result.latencyMs === "number" ? { latencyMs: Math.round(result.latencyMs) } : {}),
    ...(!result.ok ? { error: String(result.error || result.detail || "Connection error").slice(0, 240) } : {}),
    checkedAt: new Date().toISOString(),
  });
}

export function clearProviderHealth(providerId: string): void {
  if (!providerId) return;
  healthCache.delete(providerId);
}

export function isLocalProviderUrl(baseUrl: string): boolean {
  const u = String(baseUrl || "").toLowerCase();
  return u.includes("127.0.0.1") || u.includes("localhost") || u.includes(":11434");
}

export function computeProviderHealth(p: ProviderRecord): ProviderHealthSnapshot {
  if (!p.enabled) {
    return { status: "disabled" };
  }
  const plainKey = decryptSecret(p.api_key || "").trim();
  const isLocal = isLocalProviderUrl(p.base_url);
  const hasUsableKey = isLocal || (plainKey.length > 0 && plainKey.toLowerCase() !== "ollama");
  if (!hasUsableKey) {
    return { status: "no_key" };
  }

  const cached = healthCache.get(p.id);
  if (!cached) {
    return { status: "unchecked" };
  }
  return {
    status: cached.ok ? "ready" : "error",
    ...(cached.latencyMs !== undefined ? { latencyMs: cached.latencyMs } : {}),
    ...(cached.error ? { error: cached.error } : {}),
    checkedAt: cached.checkedAt,
  };
}

export function estimateTokenCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const m = String(model || "").toLowerCase();
  const inTok = Math.max(0, Number(promptTokens) || 0);
  const outTok = Math.max(0, Number(completionTokens) || 0);
  if (inTok === 0 && outTok === 0) return 0;

  if (/:free\b|\bfree\b|ollama|^llama[\d.]|^qwen[\d.]|^mistral/i.test(m)) {
    return 0;
  }

  let inRate = 1.0;
  let outRate = 3.0;
  if (m.includes("opus")) {
    inRate = 15.0;
    outRate = 75.0;
  } else if (m.includes("sonnet")) {
    inRate = 3.0;
    outRate = 15.0;
  } else if (m.includes("haiku")) {
    inRate = 0.8;
    outRate = 4.0;
  } else if (m.includes("mini") || m.includes("nano") || m.includes("o3-mini") || m.includes("o1-mini")) {
    inRate = 0.4;
    outRate = 1.6;
  } else if (m.includes("gpt-4.1") || m.includes("gpt-4o") || m.includes("gpt-5") || m.includes("gpt-6")) {
    inRate = 2.5;
    outRate = 10.0;
  } else if (m.includes("flash")) {
    inRate = 0.15;
    outRate = 0.6;
  } else if (m.includes("gemini") && m.includes("pro")) {
    inRate = 1.25;
    outRate = 10.0;
  } else if (m.includes("deepseek") && (m.includes("reasoner") || m.includes("r1"))) {
    inRate = 0.55;
    outRate = 2.19;
  } else if (m.includes("deepseek")) {
    inRate = 0.27;
    outRate = 1.1;
  }

  return Number((((inTok / 1_000_000) * inRate) + ((outTok / 1_000_000) * outRate)).toFixed(6));
}
