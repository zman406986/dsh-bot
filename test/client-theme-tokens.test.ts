/**
 * Ticket 49 (extended by ticket 47) — the roster panel and the settings card
 * must style themselves from the host's shared design-token layer, not from
 * a private palette.
 *
 * Offline only (S8): the tokens are ordinary CSS custom properties defined on
 * `body` by the shipped theme stylesheet
 * (`dsh-client-ui-theme/lib/client.js:1052-1060`, light on `body`, dark on
 * `body[data-ds-dark-theme]`), so a surface becomes theme-correct simply by
 * referencing them — no service, no subscription, no boot-graph edge. These
 * pins hold that contract: no raw colour literal may come back, every colour
 * resolves through a `--dsw-*` token, the role mapping is the documented one,
 * and the two named traps stay shut. (The capsule surface left this suite
 * with its deletion — ticket 89; the wrapper shell's CSS is pinned in
 * client-wrapper-shell.test.ts.)
 *
 * The pre-existing CSS contracts (namespacing, the ring being the only
 * animation, reduced-motion degradation) stay in their own tickets' files.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROSTER_PANEL_CSS } from "../src/client/panel.js";
import { SESSION_KIND_GLYPH_CSS } from "../src/client/session-kind.js";
import { SETTINGS_CARD_CSS } from "../src/client/settings-card.js";
import { TOOLVIEW_CSS } from "../src/client/toolview-styles.js";

/** Distinct `var(--dsw-…)` tokens referenced by a stylesheet, sorted. */
function tokensIn(css: string): string[] {
  return [
    ...new Set(
      [...css.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((match) => match[1]!),
    ),
  ].sort();
}

const SURFACES = [
  { name: "roster panel (ROSTER_PANEL_CSS)", css: ROSTER_PANEL_CSS },
  { name: "settings card (SETTINGS_CARD_CSS)", css: SETTINGS_CARD_CSS },
  // Ticket 146: the dispatcher bot portrait draws with `currentColor` plus
  // this one token, so it carries the same contract as the other surfaces.
  { name: "session-kind glyph (SESSION_KIND_GLYPH_CSS)", css: SESSION_KIND_GLYPH_CSS },
  // Readable-status display: the tool row's three levels keep the muted
  // label role only; no state colour is repurposed as decoration.
  { name: "tool row (TOOLVIEW_CSS)", css: TOOLVIEW_CSS },
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
    assert.deepEqual(tokensIn(ROSTER_PANEL_CSS), [
      "--dsw-alias-border-l3",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-state-success-primary",
      "--dsw-alias-state-warn-primary",
    ]);
    // Ticket 47's card borrows the shipped settings card's own vocabulary
    // (border-l4 hairline, bg-layer-3 → bg-layer-2 when open, the label
    // ladder), with ONE deliberate substitution: the shipped failure line
    // paints `var(--dsw-alias-label-error)`, a token defined nowhere in
    // `dsh-client-ui-theme` — the reference is dead and the text would inherit.
    // We use the defined `state-error-primary` instead.
    assert.deepEqual(tokensIn(SETTINGS_CARD_CSS), [
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-bg-layer-3",
      "--dsw-alias-border-l2",
      "--dsw-alias-border-l4",
      "--dsw-alias-interactive-bg-hover",
      "--dsw-alias-label-dimmed",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-secondary",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-state-error-primary",
    ]);
    // Ticket 146: the portrait is `currentColor`-first; only the eyes take a
    // token, and it is the plain label colour (never the brand-primary trap).
    assert.deepEqual(tokensIn(SESSION_KIND_GLYPH_CSS), [
      "--dsw-alias-label-primary",
    ]);
    // Readable-status display: the row's primary/facts/details/row labels use
    // one muted role and nothing else.
    assert.deepEqual(tokensIn(TOOLVIEW_CSS), [
      "--dsw-alias-label-tertiary",
    ]);
  });
});

describe("theme tokens — role mapping (ticket 49)", () => {
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

describe("theme tokens — role mapping, settings card (ticket 47)", () => {
  const CARD = ".multitask-dispatcher-settings-card";

  it("the card is the shipped card's layered surface, as a list item", () => {
    const card = ruleFor(SETTINGS_CARD_CSS, CARD);
    assert.match(card, /border:\.5px solid var\(--dsw-alias-border-l4\)/);
    assert.match(card, /background:var\(--dsw-alias-bg-layer-3\)/);
    assert.match(card, /color:var\(--dsw-alias-label-primary\)/);
    // The tab renders every card inside a <ul>, so ours is an <li>.
    assert.match(card, /list-style:none/);
    assert.match(
      ruleFor(SETTINGS_CARD_CSS, `${CARD}[data-open="true"]`),
      /background:var\(--dsw-alias-bg-layer-2\)/,
    );
  });

  it("the text ladder and the controls are themed", () => {
    assert.match(
      ruleFor(SETTINGS_CARD_CSS, `${CARD}__name`),
      /color:var\(--dsw-alias-label-primary\)/,
    );
    assert.match(
      ruleFor(SETTINGS_CARD_CSS, `${CARD}__description`),
      /color:var\(--dsw-alias-label-tertiary\)/,
    );
    assert.match(
      ruleFor(SETTINGS_CARD_CSS, `${CARD}__input`),
      /border:1px solid var\(--dsw-alias-border-l2\)/,
    );
    assert.match(
      ruleFor(SETTINGS_CARD_CSS, `${CARD}__input`),
      /background:var\(--dsw-alias-bg-layer-3\)/,
    );
    // The save button is the inverted label fill, exactly as shipped.
    assert.match(
      SETTINGS_CARD_CSS,
      new RegExp(`${CARD}__save\\{background:var\\(--dsw-alias-label-primary\\);color:var\\(--dsw-alias-bg-layer-3\\)\\}`),
    );
    assert.match(
      SETTINGS_CARD_CSS,
      new RegExp(`${CARD}__discard\\{border-color:var\\(--dsw-alias-border-l2\\)`),
    );
  });

  it("the failure line uses the DEFINED error token — the shipped card's is dead", () => {
    // `dsh-client-ui-settings-plugins` paints its failure line with
    // `var(--dsw-alias-label-error)`, which no theme stylesheet defines: we do
    // not inherit that dead reference.
    assert.ok(!SETTINGS_CARD_CSS.includes("label-error"));
    assert.match(
      ruleFor(SETTINGS_CARD_CSS, `${CARD}__failed`),
      /color:var\(--dsw-alias-state-error-primary\)/,
    );
    assert.match(
      ruleFor(SETTINGS_CARD_CSS, `${CARD}__hint[data-invalid="true"]`),
      /color:var\(--dsw-alias-state-error-primary\)/,
    );
  });
});
