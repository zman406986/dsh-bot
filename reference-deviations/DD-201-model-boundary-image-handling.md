# DD-201 — Model-boundary image handling: resize, re-encode, and drop-to-placeholder
- **Area:** A25 attachments & media
- **Type:** missing-feature
- **Date:** 2026-09-23

## What the reference does

Immediately before the model call, a chat-inference middleware rewrites the image parts of the outgoing message list. It is a wrapper around the prompt executor: it reads the assembled messages, rewrites them, clears and re-appends the rewritten list, and only then delegates to the inner executor that actually streams to the model (`the reference tree's source/packages/chat-inference/middleware/image-resizing-middleware.ts:123-144`). Nothing is rewritten if nothing changed — the original message object is returned untouched when every part already fits (`:46`, `:96`).

Two message roles are covered: user messages carrying image parts (`:9-46`) and tool results carrying experimental image content (`:49-97`). Parts that are not images, or that do not carry byte payloads in the expected shape, are passed through untouched (`:15-22`).

The resize policy lives in a separate utility (`the reference tree's source/packages/utils/image-resize.ts`). Three recorded constants set the budget: a longest-side dimension cap of 1024 px (`:4`), a byte cap of 1 MB (`:6`), and a distinct, larger dimension cap of 1280 px reserved for one specific modern image format (`:5`). Aspect ratio is preserved by scaling the long side to the cap and deriving the short side proportionally, floored at 1 px (`:23-36`). A part already inside both caps is returned as-is without decoding (`:63`).

When a part does need work, it is decoded, resized to the computed target dimensions, and **re-encoded in its source format** — the encoder is chosen by mapping the source MIME type, defaulting to a lossless format for unknown inputs (`:11-21`, `:67`). If the re-encoded result still exceeds the byte cap, the reference shrinks it repeatedly by a recorded 0.8x factor on both axes and re-encodes each round, stopping when the result fits or when either axis would drop below 1 px (`:48-53`, `:68-73`).

The format-specific path is genuinely distinct, not a parameterization: that format has its own dimension cap (1280 px), its own dimension reader, and its own decode/encode codec imported from a dedicated module (`:2`, `:38-55`). It still falls back into the same 0.8x shrink loop.

The most important part is how failures are handled. If processing throws, the middleware branches on size:

- **Over the byte cap** → the image is replaced by a plain text part recording the byte count and the MIME type, so the model is told an image existed and how large it was rather than receiving nothing (`:36-39` for user messages, `:84-88` for tool results).
- **Under the byte cap** → the original part is kept unchanged (`:40-43`, `:89-91`).

Messages are processed with a bounded worker pool rather than all at once — a recorded concurrency of 4, capped down to the message count, with results written back by original index so ordering is preserved (`:7`, `:101-112`).

Separately from the middleware, selected-context image bytes are content-addressed: the bytes are hashed to derive an identifier, stored in a blob store under that identifier, and the attachment is rewritten to carry the identifier instead of the inline bytes (`the reference tree's source/packages/agent/context-processing-hydration.ts:47-51`). The blob store derives and verifies those identifiers with a cryptographic hash (`the reference tree's source/host/agent-isolation/conversation-blob-store.ts:2,17`). This second mechanism is adjacent to the middleware rather than part of it, and overlaps the attachment-lifecycle ground already covered by DD-198 — noted here for completeness, not re-derived.

## What the current build does

ABSENT. There is no model-boundary image handling of any kind.

`src/adapter/content-blocks.ts` is the whole of the build's structural content-block surface. It declares a text variant (`:7`), a catch-all variant for every other block kind, explicitly documented as opaque (`:14`, `:16-18`), and a text extractor whose loop admits only blocks whose type is text (`:34-46`). Image parts therefore never reach a model call from this path: they are not recognized, not rewritten, and not reported — they are silently dropped, and a dropped part leaves no trace in the extracted text.

A grep across `src/` and `client/` for base64, MIME, resize, and data-URL handling returns zero implementation hits. There is no resize utility, no image budget constant, no codec dependency, and no placeholder path anywhere in the build.

## The deviation

The reference and the build are not two answers to the same question; they are answers to different questions.

The reference's middleware exists **because images do reach its model call** and must be made affordable — its job is to shrink, re-encode, and bound the concurrency of content that is already in flight. The build never forwards image parts at all, so the middleware has no subject: there is nothing to resize, and porting the resize policy would produce a utility with no caller.

The genuinely transferable idea is narrower and is not the resize policy. It is the **failure branch**: when the reference cannot process an image, it degrades the part to an explicit text placeholder carrying the size and type, so the model and the transcript both retain the fact that an image was attached. It only passes a failure through unchanged when the part was small enough that passing it through is safe. Nothing is ever silently deleted. That is a pattern of degrading honestly: a system that cannot do the full job says so in the payload rather than emitting a shorter payload and saying nothing.

That pattern echoes the build's own recorded stance on saying plainly when something fails, but the resemblance is only by analogy and should not be overstated. ADR-0010 (`docs/adr/0010-dispatcher-presence-is-a-projection-of-core-state-draft-nonhuman-approved.md`, draft, rank 4 in the authority stack) records a fail-closed rule for presence projections: a malformed or wrong-version snapshot parses to nothing and the surface degrades to explicit "unavailable" copy — "never a half-roster" — so that adding surfaces "cannot create a half-truth renderer" (lines 13, 27). ADR-0010's wording does support a reading that no state is shown half-true, and the build's silent drop of image parts is a half-truth of exactly that shape. But ADR-0010 rules on the roster snapshot and presence surfaces; its subject matter is not media, and its principle is not written as a general content rule. It is cited here as an adjacent, same-family instinct, not as a controlling authority.

## Verdict: ASK-HUMAN

No recorded ruling names image handling at the model boundary — not in the PRD, not in any ADR, and not in any ticket ruling reachable from this area — so nothing in the authority stack settles it.

The mechanism itself is not worth asking about: the middleware is **do-not-incorporate** on the merits, because the build forwards no image parts and a resize pipeline with no caller is dead code. The question worth a human ruling is the *deviation underneath it*. The build silently discards a user's attached image, and the PRD does not appear to have considered that behavior. Whether an image attachment that vanishes without a trace is acceptable, or whether it must at minimum leave a placeholder behind as the reference does, is a product-scope decision, not an implementation one — the human owns it. ADR-0017 and ADR-0018 set the standard for how closely the build must imitate the reference, and they send every deviation from the reference through human approval, which points the same way. If the ruling is that images must reach the model, this file becomes an ordinary implementation ticket; if the ruling is that they must not, the transferable requirement is the placeholder, not the resize policy.

## Incorporation notes

- **Where it would live:** For the ruling only, no code today. If the ruling is "images may reach the model," the rewrite belongs in the adapter layer beside `src/adapter/content-blocks.ts`, at the point where outgoing messages are assembled for the dsh-llm call — the same point in the flow that the reference wraps (`image-resizing-middleware.ts:123-144`). If the ruling is "images stay out but must not vanish silently," the placeholder is a change to the text extraction at `src/adapter/content-blocks.ts:34-46`, which today cannot distinguish "no image" from "image discarded."
- **Constraints:** The byte cap must be enforced by a caller that actually inspects part payloads; the build's current opaque catch-all variant (`content-blocks.ts:16-18`) carries no payload fields the adapter reads, so any placeholder logic needs a typed view of image parts first. Any codec added for the format-specific path must be re-derived or sourced independently — it is a real third-party dependency, not a small helper. Bounded concurrency matters only if the rewrite becomes async and blocking; the reference's worker pool exists because its resize is awaitable.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S for the ruling itself (a one-line scope decision); M/L if the ruling is "forward images," since it implies typed image parts, a resize utility, a codec dependency, and a placeholder path. Risk is low today precisely because nothing is implemented — the risk is entirely in the decision being made by default rather than on purpose.
- **Key reference anchors:**
  - the reference tree's `source/packages/chat-inference/middleware/image-resizing-middleware.ts:123-144` — executor wrapper; rewrite happens before the model stream.
  - the reference tree's `source/packages/chat-inference/middleware/image-resizing-middleware.ts:36-43`, `:84-91` — the failure branch: over-cap → text placeholder with byte count and MIME; under-cap → pass through unchanged.
  - the reference tree's `source/packages/chat-inference/middleware/image-resizing-middleware.ts:7`, `:101-112` — bounded concurrency, order-preserving write-back.
  - the reference tree's `source/packages/utils/image-resize.ts:4-6` — the three recorded caps (1024 px, 1280 px for the specific format, 1 MB).
  - the reference tree's `source/packages/utils/image-resize.ts:23-36`, `:67` — aspect-preserving target dimensions and re-encode in source format.
  - the reference tree's `source/packages/utils/image-resize.ts:38-55`, `:48-53`, `:68-73` — the dedicated-codec path and the 0.8x iterative shrink loop.
  - the reference tree's `source/packages/agent/context-processing-hydration.ts:47-51` — content-addressed blob id replaces inline bytes (adjacent mechanism; see DD-198).

## Evidence

- Reference:
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/chat-inference/middleware/image-resizing-middleware.ts`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/utils/image-resize.ts`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/context-processing-hydration.ts`
  - `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/agent-isolation/conversation-blob-store.ts`
- Build:
  - `src/adapter/content-blocks.ts:7,14,16,34` — text variant, opaque catch-all, text-only extraction.
  - `docs/adr/0010-dispatcher-presence-is-a-projection-of-core-state-draft-nonhuman-approved.md:13,27` — fail-closed / no-half-truth wording, cited as adjacent only.
  - Grep across `src/` and `client/` for base64 / MIME / resize / data-URL: zero implementation hits.
