/**
 * Ticket 153 step 2 — the live preference read on the activation path.
 *
 * The product's ONE language switch is the host `locale` settings namespace
 * (`dsh-client-locale/lib/index.js:5-11`: namespace `locale`, field
 * `preference`, ids `["zh", "en"]`). These pin the read and the wiring: a
 * `zh` preference makes the ACTIVATED session's injected policy the ZH block,
 * and every absent/failed/unknown read composes the EN block.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  buildDispatcherPolicySection,
  POLICY_SECTION_HEADINGS_ZH,
} from "../src/core/policy/prompts.js";
import {
  LOCALE_PREFERENCE_FIELD,
  LOCALE_SETTINGS_NAMESPACE,
  readLocalePreference,
  resolveHostPolicyLanguage,
} from "../src/adapter/locale-preference.js";
import { DISPATCHER_START_COMMAND } from "../src/adapter/activation-command.js";

type AnyCtx = Record<string, unknown>;

/** The host `settings` shape this plugin reads: `describe()` → descriptors. */
function localeSettings(preference: unknown) {
  return {
    describe: () => [
      { ns: "other-plugin", value: { whatever: 1 } },
      {
        ns: LOCALE_SETTINGS_NAMESPACE,
        value:
          preference === undefined
            ? {}
            : { [LOCALE_PREFERENCE_FIELD]: preference },
      },
    ],
  };
}

/** A getter over a fixed service value, matching `ctx.get(name)`. */
function getterOf(service: unknown) {
  return (name: string) => {
    void name;
    return service;
  };
}

describe("locale preference read (ticket 153)", () => {
  it("reads the locale namespace's preference field", () => {
    assert.equal(readLocalePreference(getterOf(localeSettings("zh"))), "zh");
    assert.equal(readLocalePreference(getterOf(localeSettings("en"))), "en");
    assert.equal(
      readLocalePreference(getterOf(localeSettings(undefined))),
      undefined,
      "absence delegates to the browser — no preference field",
    );
    assert.equal(readLocalePreference(undefined), undefined, "no getter at all");
  });

  it("fails closed to EN on every unreadable shape", () => {
    const throwing = () => {
      throw new Error("service unavailable");
    };
    const describeThrows = {
      describe: () => {
        throw new Error("boom");
      },
    };
    const cases: readonly (readonly [string, unknown])[] = [
      ["no getter", undefined],
      ["getter throws", throwing],
      ["no service", getterOf(undefined)],
      ["service is a scalar", getterOf(42)],
      ["no describe", getterOf({})],
      ["describe throws", getterOf(describeThrows)],
      ["describe is not a list", getterOf({ describe: () => ({}) })],
      ["no locale row", getterOf({ describe: () => [{ ns: "x", value: {} }] })],
      [
        "row value is not an object",
        getterOf({
          describe: () => [{ ns: LOCALE_SETTINGS_NAMESPACE, value: "zh" }],
        }),
      ],
      ["unknown language", getterOf(localeSettings("ja"))],
      ["regional tag", getterOf(localeSettings("zh-CN"))],
      ["non-string", getterOf(localeSettings(7))],
    ];
    for (const [label, getter] of cases) {
      assert.equal(
        resolveHostPolicyLanguage(getter as never),
        "en",
        `must fail closed to EN: ${label}`,
      );
    }
    assert.equal(
      resolveHostPolicyLanguage(getterOf(localeSettings("zh"))),
      "zh",
      "the exact shipped id is the only switch",
    );
  });
});

describe("activation path passes the preference through (ticket 153)", () => {
  /** A stub ctx rich enough for `apply` to boot dormant and activate. */
  function activationCtx(service: unknown) {
    const registeredCommands: Array<{
      name: string;
      handler: (input: unknown) => unknown;
    }> = [];
    const listeners = new Map<string, Array<(payload: never) => void>>();
    const disposers: Array<() => void> = [];
    const registeredTools: Array<{ name: string }> = [];
    const ctx: AnyCtx = {
      disposers,
      listeners,
      registeredTools,
      registeredCommands,
      get: getterOf(service),
      effect(execute: () => unknown, label?: string) {
        void label;
        const result = execute();
        if (typeof result === "function") {
          disposers.push(result as () => void);
          return;
        }
        // Cordis effect contract (ticket 44): a generator effect runs now and
        // each function it yields is collected as unload cleanup. The command
        // registrations use exactly this shape.
        if (
          typeof result === "object" &&
          result !== null &&
          Symbol.iterator in result
        ) {
          for (const step of result as Iterable<unknown>) {
            if (typeof step === "function") disposers.push(step as () => void);
          }
        }
      },
      on(name: string, cb: (payload: never) => void) {
        const list = listeners.get(name) ?? [];
        list.push(cb);
        listeners.set(name, list);
        return () => {
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter((entry) => entry !== cb),
          );
        };
      },
      commands: {
        register(definition: {
          name: string;
          handler: (input: unknown) => unknown;
        }) {
          registeredCommands.push(definition);
          return () => {};
        },
      },
      tools: {
        schemas: () => registeredTools,
        register(definition: { name: string }) {
          registeredTools.push(definition);
          return () => {};
        },
      },
      agents: { get: () => undefined },
      subagents: {
        startActivation: async () => ({}),
        interrupt: () => {},
        sendMessage: async () => ({}),
        listChildren: () => [],
      },
      jobs: { list: () => [] },
      storageDomain: {
        async open() {
          const table = new Map<string, unknown>();
          return {
            table() {
              return {
                get: (key: string) => table.get(key) as never,
                entries: () => table.entries() as never,
                put: async (key: string, value: unknown) => {
                  table.set(key, value);
                },
                delete: async (key: string) => table.delete(key),
              };
            },
            async close() {},
            name: "multitask_dispatcher",
          };
        },
      },
    };
    return {
      ctx,
      registeredCommands,
      registeredTools,
      disposers,
      listeners,
    };
  }

  function activateAndReadPolicy(
    harness: ReturnType<typeof activationCtx>,
  ): string {
    const start = harness.registeredCommands.find(
      (command) => command.name === DISPATCHER_START_COMMAND,
    );
    assert.ok(start, "the activation command is registered");
    const injected: unknown[] = [];
    const agent = {
      session: {
        id: "s-1",
        header: { parentSession: null, delegationDepth: 0 },
      },
      followup() {},
      inject(message: unknown) {
        injected.push(message);
      },
    };
    const result = start.handler({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    }) as { kind: string };
    assert.equal(result.kind, "success", "activation succeeded");
    assert.equal(injected.length, 1, "exactly one policy inject");
    const message = injected[0] as {
      content: Array<{ type: string; text?: string }>;
    };
    return message.content.map((block) => block.text ?? "").join("\n");
  }

  it("a zh preference makes the activated session's policy the ZH block", () => {
    const harness = activationCtx(localeSettings("zh"));
    apply(harness.ctx as never, volatileConfig({ enabled: true }) as never);
    const policy = activateAndReadPolicy(harness);
    assert.equal(policy, buildDispatcherPolicySection("user", 1, "zh"));
    assert.ok(policy.startsWith(POLICY_SECTION_HEADINGS_ZH[0]));
  });

  it("an en preference, an absent preference and a failed read all compose EN", () => {
    const scenarios: readonly (readonly [string, unknown])[] = [
      ["en preference", localeSettings("en")],
      ["absent preference", localeSettings(undefined)],
      ["no settings service", undefined],
      ["unknown language", localeSettings("ja")],
    ];
    for (const [label, service] of scenarios) {
      const harness = activationCtx(service);
      apply(harness.ctx as never, volatileConfig({ enabled: true }) as never);
      const policy = activateAndReadPolicy(harness);
      assert.equal(
        policy,
        buildDispatcherPolicySection("user", 1, "en"),
        `${label}: must compose the EN face`,
      );
    }
  });
});
