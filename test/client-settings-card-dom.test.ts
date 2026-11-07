/**
 * Settings card — DOM-level repairs (jsdom, offline S8).
 *
 * Two claims pinned here:
 *
 * 1. the card store is SHARED by the row's `summary` and `page` seats, so
 *    only the page binds it: a summary mount (which carries no form) must
 *    never blank the page card, and only the page's unmount detaches. The
 *    summary is mounted in both orders to cover the remount-order defect.
 * 2. each field control is associated with its explanation line: the input
 *    carries `aria-describedby` naming the hint/invalid paragraph, and an
 *    unaccepted draft sets `aria-invalid` on that control.
 *
 * Rendering uses jsdom + react-dom (the established `test/client-*.test.ts`
 * idiom). Everything is offline: no network, no host, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── jsdom globals BEFORE react-dom initializes (the host renderer's stand-in)

import { createRequire } from "node:module";

// jsdom ships no type declarations and @types/jsdom is not a dependency (DOM
// tests run through tsx, which does not typecheck), so describe the surface
// this file uses locally and load the package through require.
const loadCjs = createRequire(import.meta.url);
const { JSDOM } = loadCjs("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: { url?: string; pretendToBeVisual?: boolean },
  ) => { window: Window };
};

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

(globalThis as Record<string, unknown>)["window"] = dom.window;
(globalThis as Record<string, unknown>)["document"] = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

import { createPluginSettingsCard } from "../src/client/settings-card.js";
import {
  SETTINGS_CARD_INVALID_KEY,
  SETTINGS_CARD_UNSAVED_KEY,
  createSettingsCardStore,
} from "../src/client/settings-card-store.js";
import { localeDictionary } from "../src/client/overlay.js";
import type {
  ConfigFormSnapshotLike,
  ConfigPageFormLike,
} from "../src/client/context.js";

const CARD_CLASS = "multitask-dispatcher-settings-card";
const t = (key: string): string => localeDictionary.en[key] ?? key;

/** A served document, as the page would hand it in. */
function readyState(): ConfigFormSnapshotLike {
  return {
    status: "ready",
    value: { enabled: true },
    writable: true,
    revision: 1,
  };
}

/** The shipped page form shape: a plain object + atomic mutate. */
function createPlainForm(): ConfigPageFormLike {
  return {
    state: readyState(),
    mutate: async () => true,
  };
}

/** Mount one element into a fresh container and return the container. */
async function mount(element: ReturnType<typeof createElement>): Promise<{
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
  unmount(): Promise<void>;
}> {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    root,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("settings card — one store, summary and page seats (jsdom)", () => {
  it("the summary never blanks the page card, and only the page detaches", async () => {
    const store = createSettingsCardStore();
    const Card = createPluginSettingsCard(t, store);

    const page = await mount(
      createElement(Card, { view: "page", form: createPlainForm() }),
    );
    assert.ok(
      page.container.querySelector(`section.${CARD_CLASS}`),
      "the page seat renders the card",
    );

    // The summary seat is a SECOND cell sharing the store. It carries no
    // form; attaching it (the old behaviour) would blank the page card.
    const summary = await mount(createElement(Card, { view: "summary" }));
    assert.equal(store.getBox().view.available, true);
    assert.ok(
      page.container.querySelector(`section.${CARD_CLASS}`),
      "the page card survives the summary mount",
    );
    assert.ok(
      (summary.container.textContent ?? "").length > 0,
      "the summary renders its one-line description",
    );

    await summary.unmount();
    assert.equal(
      store.getBox().view.available,
      true,
      "a summary unmount must not detach the page's form",
    );

    await page.unmount();
    assert.equal(
      store.getBox().view.available,
      false,
      "the page's unmount detaches the shared store",
    );
  });

  it("a summary mounted FIRST does not block a later page mount", async () => {
    const store = createSettingsCardStore();
    const Card = createPluginSettingsCard(t, store);

    const summary = await mount(createElement(Card, { view: "summary" }));
    assert.equal(store.getBox().view.available, false);

    const page = await mount(
      createElement(Card, { view: "page", form: createPlainForm() }),
    );
    assert.equal(store.getBox().view.available, true);
    assert.ok(page.container.querySelector(`section.${CARD_CLASS}`));

    await page.unmount();
    await summary.unmount();
  });
});

describe("settings card — dirty state reaches screen readers (jsdom)", () => {
  it("names the unsaved badge in the header's accessible name while dirty", async () => {
    const store = createSettingsCardStore();
    const Card = createPluginSettingsCard(t, store);
    const page = await mount(
      createElement(Card, { view: "page", form: createPlainForm() }),
    );
    const header = page.container.querySelector(
      `section.${CARD_CLASS} button.${CARD_CLASS}__header`,
    );
    assert.ok(header, "the header renders");
    assert.doesNotMatch(
      header.getAttribute("aria-label") ?? "",
      new RegExp(t(SETTINGS_CARD_UNSAVED_KEY)),
    );

    await act(async () => {
      store.edit("enabled", "false");
    });
    // The visible Unsaved badge is inside the button whose aria-label wins;
    // without this the badge is invisible to a screen reader.
    assert.match(
      header.getAttribute("aria-label") ?? "",
      new RegExp(t(SETTINGS_CARD_UNSAVED_KEY)),
    );
    await page.unmount();
  });
});

describe("settings card — control/explanation association (jsdom)", () => {
  it("every control names its hint id, and an invalid draft marks the control", async () => {
    const store = createSettingsCardStore();
    const Card = createPluginSettingsCard(t, store);
    const page = await mount(
      createElement(Card, { view: "page", form: createPlainForm() }),
    );

    // Open the disclosure so the field controls render.
    const header = page.container.querySelector("section button");
    assert.ok(header, "the card header renders");
    await act(async () => {
      (header as HTMLButtonElement).click();
    });

    const enabledId = `${CARD_CLASS}-field-enabled`;
    const enabled = page.container.querySelector<HTMLInputElement>(
      `#${enabledId}`,
    );
    assert.ok(enabled, "the enabled control renders");
    assert.equal(enabled.getAttribute("aria-describedby"), `${enabledId}-hint`);
    assert.equal(enabled.getAttribute("aria-invalid"), null);
    const enabledHint = page.container.querySelector(`#${enabledId}-hint`);
    assert.ok(enabledHint, "the enabled hint paragraph renders");
    assert.equal(enabledHint.textContent, t("settings.card.field.enabled.hint"));

    // Stage an unaccepted draft: the control must carry aria-invalid, keep
    // pointing at the same paragraph, and that paragraph now says why.
    await act(async () => {
      store.edit("wakeCoalesceWindowMs", "soon");
    });
    const timeoutId = `${CARD_CLASS}-field-wakeCoalesceWindowMs`;
    const timeout = page.container.querySelector<HTMLInputElement>(
      `#${timeoutId}`,
    );
    assert.ok(timeout, "the number control renders");
    assert.equal(timeout.getAttribute("aria-invalid"), "true");
    assert.equal(timeout.getAttribute("aria-describedby"), `${timeoutId}-hint`);
    const timeoutHint = page.container.querySelector(`#${timeoutId}-hint`);
    assert.ok(timeoutHint);
    assert.equal(timeoutHint.textContent, t(SETTINGS_CARD_INVALID_KEY));

    await page.unmount();
  });
});
