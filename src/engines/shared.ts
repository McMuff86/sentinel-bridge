import type { EngineConfig, ModelPricing, TokenUsage } from "../types.js";

export type TokenUsageDelta = {
  input?: number;
  output?: number;
  cachedInput?: number;
};

export function mergeEngineConfig(
  baseConfig: EngineConfig,
  overrides?: Partial<EngineConfig>,
): EngineConfig {
  if (!overrides) {
    return {
      ...baseConfig,
      env: cloneEnv(baseConfig.env),
      pricing: clonePricing(baseConfig.pricing),
    };
  }

  return {
    ...baseConfig,
    ...overrides,
    args: overrides.args ?? baseConfig.args,
    env: mergeEnv(baseConfig.env, overrides.env),
    pricing: {
      ...clonePricing(baseConfig.pricing),
      ...clonePricing(overrides.pricing),
    },
  };
}

export function emptyTokenUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cachedInput: 0,
    total: 0,
  };
}

export function mergeTokenUsage(
  current: TokenUsage,
  delta?: TokenUsageDelta,
): TokenUsage {
  if (!delta) {
    return { ...current };
  }

  const input = current.input + toNumber(delta.input);
  const output = current.output + toNumber(delta.output);
  const cachedInput = current.cachedInput + toNumber(delta.cachedInput);

  return {
    input,
    output,
    cachedInput,
    total: input + output + cachedInput,
  };
}

export function calculateLinearUsageCost(
  pricing: ModelPricing,
  delta?: TokenUsageDelta,
): number {
  if (!delta) {
    return 0;
  }

  const cost =
    (toNumber(delta.input) * pricing.inputPer1M +
      toNumber(delta.output) * pricing.outputPer1M +
      toNumber(delta.cachedInput) * pricing.cachedInputPer1M) /
    1_000_000;

  return roundUsd(cost);
}

export function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mergeEnv(
  baseEnv?: Record<string, string | undefined>,
  overrideEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  if (!baseEnv && !overrideEnv) {
    return undefined;
  }

  return {
    ...cloneEnv(baseEnv),
    ...cloneEnv(overrideEnv),
  };
}

function cloneEnv(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  return env ? { ...env } : undefined;
}

function clonePricing(
  pricing?: Partial<ModelPricing>,
): Partial<ModelPricing> | undefined {
  return pricing ? { ...pricing } : undefined;
}
