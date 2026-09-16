/**
 * Structural client-face context (ticket 20).
 *
 * Structural typing only — no import from `@deepseek-ai/dsh-client-ui-renderer`
 * or `@deepseek-ai/dsh-client-locale` (peer surfaces, not dependencies).
 * Shapes mirror the verified seams in `docs/research/dsh-plugin-ui-patterns.md`:
 *
 * - `ctx.slots.inject(parent, cb)` waits for the parent slot declaration and
 *   installs its registration effect on the CALLER's fiber (Finding 5);
 * - `ctx.slots.register(options, component)` returns the disposer and is
 *   fiber-scoped (Finding 5, `registry.d.ts:77-83`);
 * - `ctx.locale.register(ns, {zh, en})` registers copy dictionaries and
 *   `ctx.locale.bind(ns)` returns the `t` seat for a namespace (Finding 6);
 * - `ctx.effect(execute, label?)` runs `execute` immediately and collects the
 *   returned function as the unload disposer (vendored cordis `effect`).
 */

import type { LocaleDictionary, SlotRegistrationOptions } from "./overlay.js";

/** `ctx.slots` surface used by this scaffold. */
export interface SlotsServiceLike {
  /**
   * Install `callback` once `<parent>`'s slot declaration exists; collapse of
   * the declaration disposes the effect. Registrations made inside the
   * callback land on this module's fiber and reverse with it.
   */
  inject(parent: string, callback: () => unknown): unknown;
  /** Register a component into a slot; returns the exact disposer. */
  register(options: SlotRegistrationOptions, component: unknown): unknown;
}

/** `ctx.locale` surface used by this scaffold. */
export interface LocaleServiceLike {
  /** Register an `{en, zh}` copy dictionary under a plugin-owned namespace. */
  register(namespace: string, dictionary: LocaleDictionary): unknown;
  /** Bind the `t` seat for a namespace. */
  bind(namespace: string): (key: string) => string;
}

/**
 * Client-side settings scope (ticket 21 data path). The browser exposes a
 * settings service that can watch a plugin namespace — the same namespace
 * the host half mirrors the roster snapshot into (design-16 §4.2 fallback;
 * Finding 7 worked example 3 injects the settings scope this way).
 */
export interface ClientSettingsScopeLike {
  /** Watch a namespace document; returns the unsubscribe disposer. */
  watch(namespace: string, onChange: (value: unknown) => void): () => void;
}

/** Services handed to an `inject` callback child context. */
export interface ClientInjectedServices {
  settings?: ClientSettingsScopeLike;
}

/**
 * Cordis-level `inject` used to wait for the optional settings service.
 * Optional on the context: a client runtime without it leaves the roster
 * channel missing and the panel degrades to unavailable copy.
 */
export type ClientInjectFn = (
  services: readonly string[],
  callback: (child: ClientInjectedServices) => void,
) => unknown;

/** Cordis effect seat shared by host and client fibers. */
export interface ClientEffectContext {
  effect(execute: () => unknown, label?: string): unknown;
}

/** The narrow client context this scaffold's `apply` needs. */
export interface ClientContext extends ClientEffectContext {
  slots: SlotsServiceLike;
  locale: LocaleServiceLike;
  inject?: ClientInjectFn;
}
