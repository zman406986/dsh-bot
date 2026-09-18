/**
 * Ticket 49 — the capsule and panel must style themselves from the host's
 * shared design-token layer, not from a private palette.
 *
 * Offline only (S8): the tokens are ordinary CSS custom properties defined on
 * `body` by the shipped theme stylesheet
 * (`dsh-client-ui-theme/lib/client.js:1052-1060`, light on `body`, dark on
 * `body[data-ds-dark-theme]`), so a surface becomes theme-correct simply by
 * referencing them — no service, no subscription, no boot-graph edge. These
 * pins hold that contract: no raw colour literal may come back, every colour
 * resolves through a `--dsw-*` token, the role mapping is the documented one,
 * and the two named traps stay shut.
 *
 * The pre-existing CSS contracts (namespacing, the ring being the only
 * animation, reduced-motion degradation) stay in their own tickets' files.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPSULE_CSS } from "../src/client/capsule.js";
import { ROSTER_PANEL_CSS } from "../src/client/panel.js";

/** Distinct `var(--dsw-…)` tokens referenced by a stylesheet, sorted. */
function tokensIn(css: string): string[] {
  return [
    ...new Set(
      [...css.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((match) => match[1]!),
    ),
  ].sort();
}

const SURFACES = [
  { name: "capsule (CAPSULE_CSS)", css: CAPSULE_CSS },
  { name: "roster panel (ROSTER_PANEL_CSS)", css: ROSTER_PANEL_CSS },
] as const;

/** The colour-bearing declarations of one selector, for role assertions. */
function ruleFor(css: string, selector: string): string {
  const at = css.indexOf(selector + "{");
  assert.notEqual(at, -1, `selector ${selector} is gone`);
  const open = css.indexOf("{", at);
  const end = css.indexOf("}", open);
  return css.slice(open + 1, end);
}

describe("theme tokens — no private palette survives (ticket 49)", () => {
  for (const { name, css } of SURFACES) {
    it(`${name}: carries no raw colour literal`, () => {
      assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "hex literal");
      assert.doesNotMatch(css, /(?<![a-z])rgba?\(/, "bare rgb()/rgba() literal");
      assert.doesNotMatch(css, /hsla?\(/, "hsl() literal");
    });

    it(`${name}: every colour resolves through a host token`, () => {
      const tokens = tokensIn(css);
      assert.ok(tokens.length > 0, "no tokens referenced at all");
      for (const token of tokens) {
        assert.match(
          token,
          /^--dsw-(alias|elevation)-[a-z0-9-]+$/,
          `unexpected token namespace: ${token}`,
        );
      }
    });

    it(`${name}: no token is given a hex fallback`, () => {
      // A fallback would smuggle the rejected private palette back in and
      // make the theme contract optional when it is not.
      assert.doesNotMatch(css, /var\(--dsw-[^)]*#[0-9a-fA-F]/);
    });

    it(`${name}: never uses brand-primary as an accent`, () => {
      // Despite the name it is the high-contrast *label* colour
      // (neutral-bluish-1000 light / neutral-bluish-50 dark), so a status dot
      // painted with it is black-on-light and white-on-dark — the exact
      // near-miss this ticket exists to prevent.
      assert.ok(
        !css.includes("var(--dsw-alias-brand-primary)"),
        "brand-primary is the label colour, not an accent",
      );
    });
  }

  it("the token sets are exactly the documented mapping", () => {
    assert.deepEqual(tokensIn(CAPSULE_CSS), [
      "--dsw-alias-bg-layer-3",
      "--dsw-alias-border-l2",
      "--dsw-alias-border-l3",
      "--dsw-alias-interactive-bg-hover",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-state-success-primary",
      "--dsw-elevation-panel",
    ]);
    assert.deepEqual(tokensIn(ROSTER_PANEL_CSS), [
      "--dsw-alias-border-l3",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-state-success-primary",
      "--dsw-alias-state-warn-primary",
    ]);
  });
});

describe("theme tokens — role mapping (ticket 49)", () => {
  it("capsule: floating chip and card are layered surfaces with host elevation", () => {
    const chip = ruleFor(CAPSULE_CSS, ".multitask-dispatcher-capsule__chip");
    assert.match(chip, /background:var\(--dsw-alias-bg-layer-3\)/);
    assert.match(chip, /border:1px solid var\(--dsw-alias-border-l3\)/);
    assert.match(chip, /color:var\(--dsw-alias-label-primary\)/);

    const card = ruleFor(CAPSULE_CSS, ".multitask-dispatcher-capsule__card");
    assert.match(card, /background:var\(--dsw-alias-bg-layer-3\)/);
    assert.match(card, /color:var\(--dsw-alias-label-primary\)/);
    assert.match(card, /box-shadow:var\(--dsw-elevation-panel\)/);
  });

  it("capsule: dot states use the state family, idle uses the muted label", () => {
    assert.match(
      ruleFor(CAPSULE_CSS, ".multitask-dispatcher-capsule__dot"),
      /background:var\(--dsw-alias-label-tertiary\)/,
    );
    assert.match(
      ruleFor(
        CAPSULE_CSS,
        '.multitask-dispatcher-capsule__dot[data-dot="active"]',
      ),
      /background:var\(--dsw-alias-state-business-primary\)/,
    );
    assert.match(
      ruleFor(
        CAPSULE_CSS,
        '.multitask-dispatcher-capsule__dot[data-dot="error"]',
      ),
      /background:var\(--dsw-alias-state-error-primary\)/,
    );
  });

  it("capsule: wake badge, failed-send notice and button surface use their siblings", () => {
    assert.match(
      ruleFor(CAPSULE_CSS, ".multitask-dispatcher-capsule__wake"),
      /color:var\(--dsw-alias-state-success-primary\)/,
    );
    assert.match(
      ruleFor(CAPSULE_CSS, ".multitask-dispatcher-capsule__action-notice"),
      /color:var\(--dsw-alias-state-error-primary\)/,
    );
    assert.match(
      ruleFor(CAPSULE_CSS, ".multitask-dispatcher-capsule__activation-button"),
      /background:var\(--dsw-alias-interactive-bg-hover\)/,
    );
  });

  it("panel: every FSM dot maps to its state token", () => {
    const panel = ".multitask-dispatcher-roster-panel__dot";
    assert.match(
      ruleFor(ROSTER_PANEL_CSS, panel),
      /background:var\(--dsw-alias-label-tertiary\)/,
    );
    assert.match(
      ruleFor(ROSTER_PANEL_CSS, `${panel}[data-visual="working"]`),
      /background:var\(--dsw-alias-state-business-primary\)/,
    );
    assert.match(
      ruleFor(ROSTER_PANEL_CSS, `${panel}[data-visual="starting"]`),
      /background:var\(--dsw-alias-state-warn-primary\)/,
    );
    assert.match(
      ruleFor(ROSTER_PANEL_CSS, `${panel}[data-visual="done"]`),
      /background:var\(--dsw-alias-state-success-primary\)/,
    );
    assert.match(
      ruleFor(ROSTER_PANEL_CSS, `${panel}[data-visual="failed"]`),
      /background:var\(--dsw-alias-state-error-primary\)/,
    );
    assert.match(
      ruleFor(ROSTER_PANEL_CSS, `${panel}[data-visual="stopped"]`),
      /background:var\(--dsw-alias-label-tertiary\)/,
    );
  });

  it("panel: the working ring keeps translucency via color-mix over the accent", () => {
    const ring = ruleFor(
      ROSTER_PANEL_CSS,
      '.multitask-dispatcher-roster-panel__dot[data-visual="working"]::after',
    );
    assert.match(
      ring,
      /border:2px solid color-mix\(in srgb,var\(--dsw-alias-state-business-primary\) 55%,transparent\)/,
    );
  });

  it("panel: markers and the steer control are themed", () => {
    assert.match(
      ruleFor(
        ROSTER_PANEL_CSS,
        ".multitask-dispatcher-roster-panel__row-marker--blocked",
      ),
      /color:var\(--dsw-alias-state-warn-primary\)/,
    );
    assert.match(
      ruleFor(
        ROSTER_PANEL_CSS,
        ".multitask-dispatcher-roster-panel__row-marker--landed",
      ),
      /color:var\(--dsw-alias-state-success-primary\)/,
    );
    const steer = ruleFor(
      ROSTER_PANEL_CSS,
      ".multitask-dispatcher-roster-panel__steer",
    );
    assert.match(steer, /border:1px solid var\(--dsw-alias-border-l3\)/);
    assert.match(steer, /color:inherit/);
  });
});
