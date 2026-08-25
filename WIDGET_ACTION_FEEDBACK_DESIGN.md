# A widget button that says what happened — design

A confirm button ran its command and showed nothing. Measured live: clicking `probe_forbidden`
executed it and left no trace, and clicking `remember` changed the stored note while the screen stayed
identical. An approval with no acknowledgement is not a finished approval.

> **Built 2026-08-23, and §3 below was WRONG about where the click is dispatched.** The correction is
> in §6 rather than edited over the top, because the wrong version was reached by inference and the
> right one by reading the code that states it.

---

## 1. Where it is lost, exactly

`axsdk-core/src/axchat.ts`:

```ts
if (action.type === 'lua' || action.type === 'ax') {
  if (!isWidgetCommandAllowed(action.command, AXSDK.config?.widgets?.commandActions)) return;
  const args = action.args ?? {};
  if (action.type === 'lua') void AXSDK.lua.call(action.command, args);
  else void processAXHandler(action.command, args);
  return;
}
```

Three separate losses in five lines:

| loss | consequence |
|---|---|
| `void` on the promise | success is invisible |
| `void` swallows rejection | a failure is invisible |
| `return` on a refused command | the gate is invisible — the button looks broken, not blocked |

The third is the worst, because "off by default" is the documented behaviour: a user who has not
opted in gets a button that does nothing and says nothing about why.

## 2. Why the click cannot simply return a value

The click does not call core. `axsdk-react`'s `emitWidgetAction` publishes on the event bus:

```ts
AXSDK.eventBus().emit('message.chat', { type: 'axsdk.widget.action', data: { template, action, data } });
```

Core's `handleWidgetAction` is the subscriber, and it is deliberately the ONE dispatcher so a host
that emits the same event gets the same behaviour. Making the button `await` a new core API would
give two dispatchers for one click — the command would run twice — so the outcome has to travel back
the way it came.

## 3. The shape

One id, one result event.

```
button click
  → emitWidgetAction() mints actionId, emits `axsdk.widget.action` (unchanged for hosts, plus the id)
      → core handleWidgetAction dispatches, AWAITS, and emits
          `axsdk.widget.action.result` { actionId, ok, output? , error? }
              → the button, subscribed and filtering on its own actionId, renders the outcome
```

- **Core stays the only dispatcher.** No double execution, and a host emitting the event still gets
  both the behaviour and the result.
- **The id is minted where the click happens**, so a page with three buttons has three
  conversations and no crosstalk.
- **A refusal is a result**, not a return: `ok: false, error: 'not_allowed'`.

`link`, `message` and `event` actions emit no result. They have no outcome to report — navigation and
sending are their own feedback — and inventing one would mean every host sees a result it must ignore.

## 4. What the tests pin

**Core** (`axchat`):

1. An allowed `ax` command emits `ok: true` carrying its output, after the command settles.
2. A refused command emits `ok: false, error: 'not_allowed'` — the silent `return` is gone.
3. A command that throws emits `ok: false` with the message. Today the rejection is swallowed.
4. The result carries the `actionId` it was given, and only that one.
5. An action with no `actionId` still runs, and its result still goes out — a host may be listening
   even when no button is.
6. `link` / `message` / `event` emit no result.
7. `lua` and `ax` both report, because both are gated and both can fail.

**React** (`AXLinkButtonWidget`):

8. The button is disabled while its action is in flight, so one click is one invocation.
9. It renders the output on success and the error on failure, beside itself.
10. It ignores a result whose `actionId` is not its own.
11. Without a result it returns to idle rather than staying disabled forever — a lost event must not
    leave a dead button. Bounded, and the bound is stated in the code.

## 5. Deliberately not in this change

- **No new chat message.** A click is a local act and its answer should be immediate; turning it into
  a turn costs a model call and puts the outcome behind latency. Recording it in the conversation is
  a separate decision.
- **No retry.** A button that re-fires on its own is a mutation nobody approved twice.
- **No formatting of the output.** It is rendered as text; a widget that interprets its command's
  payload would need to know every command.

---

## 6. What was built, and the correction §3 needed

**§3 assumed the click and the dispatch share a realm. They do not, and `widget.tsx` says so in its
own header:**

> This realm never calls `AXSDK.init`. … **up** — `AXSDK.attachView` hands every UI command to the
> tunnel, which relays it to the worker

and core's own comment completes it: `handleMessage` — the dispatcher — *"is only subscribed in
`start()`, reached at the END of the long async `AXSDK.init()`"*. So the widget realm has **no
dispatcher at all**: the click is replayed on the SESSION WORKER's bus (`parseDeliverCommand` →
`eventBus().emit`), the command runs there, and the result event I added was emitted there too — one
realm away from the button waiting for it.

My first diagnosis said the `await` never resolved. It resolves fine. Measured instead: the button sat
at `running` for 10s and returned to `idle` at 22s (its own 20s bound), while `recall` proved the
command had executed. Three probes before that read the wrong surface — the worker's console (silent
on success), the content script's `AXSDK.config` (a different object, with no `processAXHandler`), and
the widget's core (bundle-scoped, unreachable). **The DOM attribute was the only honest observable.**

**So the outcome comes back DOWN, the way `RUN_ACTIVITY` already reaches a tab.** Every hop was
verified to exist before anything was written: `callExtension` (worker → service worker, 6 existing
callers), `chrome.tabs.sendMessage` (service worker → tab, 3 existing callers), and the widget's
`chrome.runtime.onMessage` listener. It is a plumb of an existing shape, not a new direction.

```
worker core emits axsdk.widget.action.result
  → widgetActionResultMessage(groupId, event)   → callExtension
      → service worker: parseWidgetActionResult → deliverWidgetActionResult
          → chrome.tabs.sendMessage to EVERY tab in the group
              → widget: widgetActionResultEvent  → re-emitted on the local bus
                  → the button matches its own actionId and renders
```

Broadcast to every member rather than the primary tab: the button may be on any tab in the group, and
the `actionId` is what decides which control claims the answer — so a tab with no matching button
ignores it and no tab is guessed at.

The button needed no change for this: it was already waiting on `axsdk.widget.action.result`, so the
widget shell translating the push into that event is the whole integration.

**Tests:** 7 in core (`widget-action-result.test.ts`, 4 mutations), 18 in react
(`tests/widget-action-state.test.ts`, 5 mutations), 8 in the extension
(`widget-messages.test.ts`) — both translations pure, so the three call sites stay trivial.

**Live, on the fixture:**

| clicked | shown beside the button |
|---|---|
| `probe_forbidden` | `{"ok":true,"value":{"refused":true,"message":"AXSDK net refused: net_host_undeclared"}}` |
| `remember` | `{"ok":true,"value":{"stored":true}}`, and `recall` confirms the note |

**Known rough edge, left deliberately:** the text is the command's raw envelope. Rendering it as JSON
is §5's rule — a widget that interpreted each payload would have to know every command — but the
first thing a reader will want is a friendlier line for the common shapes. That is a separate change
with its own taste decision, recorded here rather than left as a marker in the code.
