/**
 * Conversation pane (ticket 80, ADR-0020 slice 4): the shell main seat's
 * text-only chat surface for the SELECTED dispatcher session.
 *
 * Reads ONLY the reduced transcript from `conversation-store.ts` (the
 * verified event-window seam, Finding 7) and acts ONLY through the injected
 * actions (send through the host's plain-prompt sink, older-pages through
 * the scoped `loadOlder()`) — the pane itself never touches a service, the
 * same presentation-only discipline as the shell and roster panel.
 *
 * Scope honesty (AC + exceptions):
 * - text-only: user + assistant turns, streaming-in-place assistant text,
 *   tool activity as collapsible per-tool rows re-hosting ticket 24's
 *   toolview parsers. U-B excludes rich ergonomics; U-C excludes timeline
 *   cards; U-E keeps delivery text-only.
 * - the composer is a plain textarea + send: NO draft persistence of any
 *   kind (component state only; switching sessions remounts it and the
 *   draft is gone — recorded, never simulated: ADR-0018 U-B), no attachments
 *   UI, no special steer UI (plain text; the roster rows' `/dispatcher-steer`
 *   prefill affordance remains the power path), and NO stop/cancel
 *   affordance anywhere (area 7 conformity — the verified scoped
 *   `IConversation.cancel` verb is deliberately unused, recorded on the
 *   ticket).
 * - send outcomes are honest: a resolved send clears the draft (the host
 *   owns the journal and the durable `user/message` arrives through the
 *   window — A4: no send journal client-side); a rejection or a missing
 *   sink shows the honest error line and KEEPS the draft. There is no
 *   optimistic echo, no success copy, no retry model.
 * - states are fail-closed (ticket 79's discipline): waiting (history has
 *   not arrived yet), unavailable (no readable window), empty (ready with
 *   zero turns) — each its own copy, never a fabricated transcript.
 *
 * Styles follow the shell's contract (ticket 49): namespaced classes, every
 * colour a host `--dsw-alias-*` token, opacity-based hierarchy, no text
 * colour beyond state/label tokens, no animation. Collapse is the native
 * `<details>` element — no JS state, no animation. Rendering is covered by
 * build + typecheck (S8); the store/projection/composer logic is asserted
 * offline in the test suite.
 */
import { useState } from "react";
import { useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { TranslateFn } from "./overlay.js";
import { TOOLVIEW_DEGRADED_KEY, type ToolviewModel } from "./toolviews.js";
import { DispatchCardView } from "./dispatch-card-view.js";
import type {
  ConversationItem,
  ConversationStore,
} from "./conversation-store.js";

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const CONVERSATION_CLASS = "multitask-dispatcher-conv";

/**
 * Pane styles (ticket 80). Tokens referenced — all already evidenced by our
 * shipped surfaces (capsule/panel/settings card/shell): `bg-layer-1` (frame
 * surface, composer input), `border-l3` (hairlines), `label-tertiary` (role
 * labels, field labels), `interactive-bg-hover` (send/older buttons, the
 * capsule's own button vocabulary), `state-warn-primary` (interrupted),
 * `state-error-primary` (failed marker, honest error line), and
 * `state-business-primary` (the streaming busy marker, the status-dot role).
 */
export const CONVERSATION_CSS = `
.${CONVERSATION_CLASS}{display:flex;flex-direction:column;flex:1;min-height:0}
.${CONVERSATION_CLASS}__scroll{flex:1;min-height:0;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:12px}
.${CONVERSATION_CLASS}__notice{opacity:.6;padding:14px}
.${CONVERSATION_CLASS}__more{align-self:flex-start;padding:3px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.${CONVERSATION_CLASS}__item{display:flex;flex-direction:column;gap:2px;min-width:0}
.${CONVERSATION_CLASS}__role{font-size:11px;opacity:.75;color:var(--dsw-alias-label-tertiary)}
.${CONVERSATION_CLASS}__text{white-space:pre-wrap;overflow-wrap:anywhere}
.${CONVERSATION_CLASS}__marker{font-size:11px;color:var(--dsw-alias-state-warn-primary)}
.${CONVERSATION_CLASS}__marker[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.${CONVERSATION_CLASS}__marker[data-tone="busy"]{color:var(--dsw-alias-state-business-primary)}
.${CONVERSATION_CLASS}__tool{font-size:12px;min-width:0}
.${CONVERSATION_CLASS}__tool-head{display:flex;gap:6px;align-items:baseline;min-width:0}
.${CONVERSATION_CLASS}__tool-name{font-weight:600;opacity:.85;overflow-wrap:anywhere}
.${CONVERSATION_CLASS}__tool-body{display:flex;flex-direction:column;gap:3px;padding:4px 0 2px 12px;opacity:.85}
.${CONVERSATION_CLASS}__field{display:flex;gap:6px;min-width:0}
.${CONVERSATION_CLASS}__field-label{flex:none;color:var(--dsw-alias-label-tertiary)}
.${CONVERSATION_CLASS}__field-value{overflow-wrap:anywhere}
.${CONVERSATION_CLASS}__rows{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}
.${CONVERSATION_CLASS}__row{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
.${CONVERSATION_CLASS}__composer{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l3)}
.${CONVERSATION_CLASS}__input{width:100%;box-sizing:border-box;min-height:60px;resize:vertical;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}
.${CONVERSATION_CLASS}__bar{display:flex;gap:8px;align-items:center;min-height:26px}
.${CONVERSATION_CLASS}__send{margin-left:auto;padding:4px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover);color:inherit;font:inherit;cursor:pointer}
.${CONVERSATION_CLASS}__send:disabled{opacity:.5;cursor:default}
.${CONVERSATION_CLASS}__status{font-size:11px;color:var(--dsw-alias-state-error-primary)}
`;

/** Honest send outcomes the composer distinguishes (module comment). */
export type ConversationSendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "no-channel" }
  | { readonly kind: "failed" };

/**
 * The composer's pure disable/enable view (the offline-testable half of the
 * ticket's "composer disable/enable states"): send is enabled exactly when
 * there is non-blank text AND no send is in flight. Everything else about
 * the composer is host-owned behavior (the sink decides admission).
 */
export interface ComposerInput {
  readonly text: string;
  readonly sending: boolean;
}

export interface ComposerView {
  readonly canSend: boolean;
  /** The button copy: "Send" when idle, "Sending…" while in flight. */
  readonly labelKey: string;
}

export function describeComposer(input: ComposerInput): ComposerView {
  const canSend = input.text.trim().length > 0 && !input.sending;
  return {
    canSend,
    labelKey:
      input.sending === true
        ? CONVERSATION_KEYS.sending
        : CONVERSATION_KEYS.send,
  };
}

/**
 * Map a send outcome to its honest status copy key, or `null` for silence —
 * a resolved send is silent (the window will show the turn; no optimistic
 * echo, no success copy, A4: the host owns the journal); failure and
 * no-channel get their honest lines and the draft is KEPT (same rule as the
 * capsule's restore-on-failure).
 */
export function sendOutcomeCopyKey(
  outcome: ConversationSendOutcome,
): string | null {
  switch (outcome.kind) {
    case "sent":
      return null;
    case "no-channel":
      return CONVERSATION_KEYS.noChannel;
    case "failed":
      return CONVERSATION_KEYS.sendFailed;
  }
}

/** The actions the pane may take (the host seats; nothing else exists). */
export interface ConversationActions {
  /** Send one plain-text prompt as the user's own queued turn. */
  readonly onSend: (
    sessionId: string,
    text: string,
  ) => Promise<ConversationSendOutcome>;
  /** Request one older history page (fire-and-forget; window is truth). */
  readonly onLoadOlder: (sessionId: string) => void;
}

/** Locale keys used by the pane (reusing toolview copy where it exists). */
export const CONVERSATION_KEYS = {
  waiting: "shell.conv.waiting",
  unavailable: "shell.conv.unavailable",
  empty: "shell.conv.empty",
  more: "shell.conv.more",
  roleUser: "shell.conv.role-user",
  roleAssistant: "shell.conv.role-assistant",
  working: "shell.conv.working",
  interrupted: "shell.conv.interrupted",
  attachmentOnly: "shell.conv.attachment-only",
  toolRunning: "shell.conv.tool-running",
  toolFailed: "shell.conv.tool-failed",
  send: "shell.conv.send",
  sending: "shell.conv.sending",
  noChannel: "shell.conv.no-channel",
  sendFailed: "shell.conv.send-failed",
} as const;

/** The composer: plain textarea + send; state dies with the mount (U-B). */
function Composer(props: {
  t: TranslateFn;
  sessionId: string;
  onSend: ConversationActions["onSend"];
}): JSX.Element {
  const { t, sessionId, onSend } = props;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const view = describeComposer({ text, sending });

  const submit = (): void => {
    if (!view.canSend) return;
    setSending(true);
    setErrorKey(null);
    void onSend(sessionId, text).then((outcome) => {
      setSending(false);
      setErrorKey(sendOutcomeCopyKey(outcome));
      if (outcome.kind === "sent") setText("");
    });
  };

  return (
    <div className={`${CONVERSATION_CLASS}__composer`}>
      <textarea
        className={`${CONVERSATION_CLASS}__input`}
        aria-label={t(CONVERSATION_KEYS.send)}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // The shipped composer's own gesture map (ticket 92): plain Enter
          // submits, Shift+Enter keeps the line break, and the accelerated
          // Ctrl/Meta+Enter chord submits too — `resolveSubmitMode(…, "enter",
          // …)` is the composer's plain-Enter submission path
          // (dsh-client-ui-conversation lib/client.js:15995, :16023) while
          // the modified chord is its accelerated gesture (:15990-15996).
          // An IME composition's Enter confirms the candidate, never sends.
          if (event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          submit();
        }}
      />
      <div className={`${CONVERSATION_CLASS}__bar`}>
        {errorKey !== null ? (
          <span className={`${CONVERSATION_CLASS}__status`}>{t(errorKey)}</span>
        ) : null}
        <button
          type="button"
          className={`${CONVERSATION_CLASS}__send`}
          disabled={!view.canSend}
          onClick={submit}
        >
          {t(view.labelKey)}
        </button>
      </div>
    </div>
  );
}

/** Ticket 24's re-hosted body: the parsed fields + status rows (read-only). */
function ToolBody(props: {
  t: TranslateFn;
  view: ToolviewModel;
}): JSX.Element {
  const { t, view } = props;
  if (view.kind === "degraded") {
    return <span>{t(TOOLVIEW_DEGRADED_KEY)}</span>;
  }
  return (
    <>
      {view.fields.map((field) => (
        <span
          key={field.labelKey}
          className={`${CONVERSATION_CLASS}__field`}
          data-field={field.labelKey}
        >
          <span className={`${CONVERSATION_CLASS}__field-label`}>
            {t(field.labelKey)}
          </span>
          <span className={`${CONVERSATION_CLASS}__field-value`}>
            {field.value}
          </span>
        </span>
      ))}
      {view.statusRows.length > 0 ? (
        <ul className={`${CONVERSATION_CLASS}__rows`}>
          {view.statusRows.map((row, index) => (
            <li
              key={`${row.workerId}-${index}`}
              className={`${CONVERSATION_CLASS}__row`}
              data-status={row.statusLabel ?? undefined}
            >
              <span className={`${CONVERSATION_CLASS}__field-value`}>
                {row.workerId}
              </span>
              <span className={`${CONVERSATION_CLASS}__field-value`}>
                {row.title}
              </span>
              {row.statusLabel !== null ? (
                <span className={`${CONVERSATION_CLASS}__field-value`}>
                  {row.statusLabel}
                </span>
              ) : null}
              {row.activity !== null ? (
                <span className={`${CONVERSATION_CLASS}__field-value`}>
                  {row.activity}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Item(props: { t: TranslateFn; item: ConversationItem }): JSX.Element {
  const { t, item } = props;
  if (item.kind === "tool") {
    return (
      <>
        {/* Ticket 81: a settled spawn record also renders its frozen
            worker-dispatch card (ticket 69 §3.2) — presentation-time only,
            projected from this record (replay-safe; C15 holds: no new wake
            kind, the spawn card rides the ordinary transcript). */}
        {item.dispatch !== null ? (
          <DispatchCardView t={t} card={item.dispatch} />
        ) : null}
        <details
          className={`${CONVERSATION_CLASS}__item ${CONVERSATION_CLASS}__tool`}
          data-tool={item.toolName}
          data-settled={item.settled ? "true" : "false"}
          data-failed={item.failed ? "true" : "false"}
        >
        <summary className={`${CONVERSATION_CLASS}__tool-head`}>
          <span className={`${CONVERSATION_CLASS}__tool-name`}>
            {item.toolName}
          </span>
          {!item.settled ? (
            <span
              className={`${CONVERSATION_CLASS}__marker`}
              data-tone="busy"
            >
              {t(CONVERSATION_KEYS.toolRunning)}
            </span>
          ) : null}
          {item.failed ? (
            <span
              className={`${CONVERSATION_CLASS}__marker`}
              data-tone="error"
            >
              {t(CONVERSATION_KEYS.toolFailed)}
            </span>
          ) : null}
        </summary>
        <div className={`${CONVERSATION_CLASS}__tool-body`}>
          <ToolBody t={t} view={item.view} />
        </div>
        </details>
      </>
    );
  }
  const roleKey =
    item.kind === "user"
      ? CONVERSATION_KEYS.roleUser
      : CONVERSATION_KEYS.roleAssistant;
  const text = item.text;
  return (
    <div
      className={`${CONVERSATION_CLASS}__item`}
      data-role={item.kind === "user" ? "user" : "assistant"}
    >
      <span className={`${CONVERSATION_CLASS}__role`}>{t(roleKey)}</span>
      {text.length > 0 ? (
        <span className={`${CONVERSATION_CLASS}__text`}>{text}</span>
      ) : item.kind === "user" ? (
        <span className={`${CONVERSATION_CLASS}__marker`}>
          {t(CONVERSATION_KEYS.attachmentOnly)}
        </span>
      ) : null}
      {item.kind === "assistant" && item.interrupted ? (
        <span className={`${CONVERSATION_CLASS}__marker`}>
          {t(CONVERSATION_KEYS.interrupted)}
        </span>
      ) : null}
      {item.kind === "assistant-streaming" ? (
        <span className={`${CONVERSATION_CLASS}__marker`} data-tone="busy">
          {t(CONVERSATION_KEYS.working)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Create the conversation pane bound to the translate seat, the conversation
 * store, and the host actions. The component takes the session id as its prop
 * (the shell passes the selected session); the composer is keyed by session
 * so a switch starts a fresh, empty draft (U-B: no draft persistence).
 *
 * Ticket 174 / ADR-0033 removed the "Needs you" approval-cards area with the
 * worker access-ask feature; the pane no longer takes an approvals seat.
 */
export function createConversationPane(
  t: TranslateFn,
  store: ConversationStore,
  actions: ConversationActions,
): (props: { sessionId: string }) => JSX.Element {
  return (props) => {
    const sessionId = props.sessionId;
    useSyncExternalStore(store.subscribe, store.getBox);
    const state = store.stateFor(sessionId);

    return (
      <div className={CONVERSATION_CLASS} data-pane="conversation">
        <style>{CONVERSATION_CSS}</style>
        {state.kind !== "ready" ? (
          <div className={`${CONVERSATION_CLASS}__notice`} data-state={state.kind}>
            {t(
              state.kind === "waiting"
                ? CONVERSATION_KEYS.waiting
                : CONVERSATION_KEYS.unavailable,
            )}
          </div>
        ) : state.transcript.items.length === 0 ? (
          <div
            className={`${CONVERSATION_CLASS}__notice`}
            data-state="empty"
          >
            {t(CONVERSATION_KEYS.empty)}
          </div>
        ) : (
          <div className={`${CONVERSATION_CLASS}__scroll`}>
            {state.transcript.hasMore ? (
              <button
                type="button"
                className={`${CONVERSATION_CLASS}__more`}
                onClick={() => actions.onLoadOlder(sessionId)}
              >
                {t(CONVERSATION_KEYS.more)}
              </button>
            ) : null}
            {state.transcript.items.map((item) => (
              <Item
                key={`${item.kind}:${item.seq}:${
                  item.kind === "tool"
                    ? item.callId
                    : item.kind === "assistant-streaming"
                      ? item.attemptId
                      : ""
                }`}
                t={t}
                item={item}
              />
            ))}
          </div>
        )}
        <Composer
          key={sessionId}
          t={t}
          sessionId={sessionId}
          onSend={actions.onSend}
        />
      </div>
    );
  };
}
