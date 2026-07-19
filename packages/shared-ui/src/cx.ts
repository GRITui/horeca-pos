/**
 * Tiny class-name joiner (internal). Filters out falsy segments so call sites
 * can write `cx(base, cond && "extra", props.className)` without extra deps.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
