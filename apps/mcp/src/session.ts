// MCP process-wide agent session memory. One MCP process serves one agent, so
// any explicit sessionId declared by a tool is remembered and propagated as the
// `x-taskboard-session` header on every subsequent request. No imports from
// tools/connection here — this module stays leaf-level to avoid cycles.
let remembered: string | undefined;

const clean = (id?: string | null): string | undefined => {
  if (typeof id !== 'string') return undefined;
  const trimmed = id.trim();
  return trimmed || undefined;
};

/** Remember a non-blank session; blanks/null are ignored (keeping the old one). */
export function rememberSession(id?: string | null): void {
  const value = clean(id);
  if (value) remembered = value;
}

/** The session declared earlier in this process, if any. */
export function rememberedSession(): string | undefined {
  return remembered;
}

/** Explicit session wins; blank/absent falls back to the remembered one. */
export function effectiveSession(explicit?: string | null): string | undefined {
  return clean(explicit) ?? remembered;
}
