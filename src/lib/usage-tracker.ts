import { getRepo } from "../repo/mod.ts";

function currentHour(): string {
  return new Date().toISOString().slice(0, 13); // "2026-03-09T15"
}

export function recordUsage(
  keyId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): Promise<void> {
  return getRepo().usage.record(keyId, model, currentHour(), 1, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
}

export function queryUsage(opts: {
  keyId?: string;
  start: string;
  end: string;
}) {
  return getRepo().usage.query(opts);
}
