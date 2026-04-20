// Display/normalization for model names.
// Copilot's upstream uses dot-separated versions for Claude models
// (e.g. "claude-opus-4.7"), but Anthropic's canonical form uses dashes
// (e.g. "claude-opus-4-7"). The dashboard UI displays/generates the dashed
// form (see substituteModelName in src/ui/dashboard/client.tsx), and this
// function normalizes it back to the dotted form at the API entry.

/** Canonical upstream form — for calls into Copilot. */
export function normalizeModelName(id: string): string {
  if (!id.startsWith("claude-")) return id;
  return id.replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, "$1.$2");
}
