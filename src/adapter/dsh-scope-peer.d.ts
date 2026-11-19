/** Public host peer surface used by the dispatcher; no implementation is vendored. */
declare module "@deepseek-ai/dsh-scope" {
  /** Read the enclosing scope key; undefined selects the global registry. */
  export function scopeParentOf(key: object): object | undefined;
}
