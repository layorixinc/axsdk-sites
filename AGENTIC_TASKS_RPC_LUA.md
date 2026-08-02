# 클라이언트 저작 Agentic Task — RPC Lua 작성 가이드

`axsdk-sites`처럼 **클라이언트가 flow와 Lua를 작성해 보내는** 모델에서 agentic task를 쓰는 방법.

전제: durable은 없다. 처음부터 RPC Lua로 쓴다고 가정한다. 기존 durable 구현을 옮기는 것이 아니라
**같은 목적을 다시 표현**한다 — 둘은 구조가 다르다.

**이 문서 하나로 완결된다.** op 어휘(§2), 와이어 계약(§3), 시나리오별 작성 패턴(§5), 참조 구현 전문(§12)이
모두 들어 있다. 더 깊은 배경은 `FLOWS_YAML_SPEC.md` §9.2.1 / `RPC_LUA_AUTHORING.md` /
`SDK_LUA_RPC_IMPLEMENTATION.md`에 있지만 없어도 된다.

## 1. 전달 모델

문서 전체를 세션 생성 시 보낸다. 앱에는 아무것도 없어도 된다.

```
POST /axsdk/v2/sessions
  { "clientFlows": "<flows.yaml 전문>" }
```

`clientFlows` 하나에 `router` · `flowTools` · `flows` · `planner`가 모두 들어간다. Lua는
`flowTools.<name>.execute.lua`에 인라인으로 실린다. 별도 등록 절차가 없다.

**검증된 사실**: 앱 패키지에 정의가 전혀 없는 라우트·플로우·Lua 도구를 `clientFlows`로만 보내
브라우저를 조작하고 결과를 터미널까지 받는 것이 라이브에서 동작한다
(`scripts/live-clientflows-rpc-check.ts`, 4/4).

## 2. op 어휘

런타임 prelude가 정본이고 아래 표는 거기서 생성했다. **버전이 어긋날 수 있으니 실제 값은 받아서 쓴다:**

```
GET /axsdk/v2/lua/ops
→ { ops: [{ op, args }...], composed: [{ helper, polls }...] }
```

`args`는 Lua 위치 인자에서 wire `params` 키로의 매핑이다.

| Lua 호출 | wire `params` |
|---|---|
| `nav.navigate(url, params)` | `{ url, params }` |
| `nav.reload()` | `{}` |
| `dom.get_location_href()` | `{}` |
| `dom.exists(selector)` | `{ selector }` |
| `dom.get_text(selector)` | `{ selector }` |
| `dom.get_attr(selector, attribute)` | `{ selector, attribute }` |
| `dom.get_innerHTML(selector)` | `{ selector }` |
| `dom.get_outerHTML(selector)` | `{ selector }` |
| `dom.query_all(selector, fields, limit)` | `{ selector, fields, limit }` |
| `dom.click(selector, opts)` | `{ selector, opts }` |
| `dom.set_value(selector, value)` | `{ selector, value }` |
| `dom.get_form_field_names(formName)` | `{ formName }` |
| `dom.get_form_field_value(formName, fieldName)` | `{ formName, fieldName }` |
| `dom.set_form_field_value(formName, fieldName, value)` | `{ formName, fieldName, value }` |
| `dom.submit_form(formName)` | `{ formName }` |
| `page.eval(script)` | `{ script }` |

**아래 둘은 wire op이 아니다.** prelude가 위 op을 폴링해 합성하므로 클라이언트가 구현하면 안 된다.

| 헬퍼 | 실제 동작 |
|---|---|
| `dom.wait_for_selector(...)` | `dom.exists`를 폴링 |
| `nav.wait_for_navigation(...)` | `dom.get_location_href`를 폴링 |

`opts = { timeout = 3000, interval = 150 }`. `allow`에는 **헬퍼가 아니라 폴링 대상 op**을 적는다.

호스트 프리미티브(왕복 없음, `allow` 불필요, `maxCalls` 미소모): `rpc.now()` · `rpc.sleep(ms)` ·
`rpc.delivered_to()` · `rpc.fanout()`.

## 3. 와이어 계약

요청은 SSE로 온다. durable replay에 남지 않는 ephemeral 이벤트이고 `id`(cursor)가 없다.

```json
{ "payload": { "type": "axsdk.rpc.request",
  "properties": { "rpcId": "rpc_...", "op": "dom.get_text",
                  "params": { "selector": "h1" }, "deadlineMs": 5000 } } }
```

응답은 REST로 보낸다.

```jsonc
POST /axsdk/v2/rpc/:rpcId          // 세션 헤더 필요
{ "ok": true,  "value": <any> }
{ "ok": false, "error": "no_element", "detail": "h1" }
{ "ok": false, "error": "not_eligible" }   // 이 문서가 실행 대상이 아닐 때
→ { "accepted": true } | { "accepted": false }
```

- **`accepted:false`는 정상이다.** 다른 문서가 먼저 답했거나 타임아웃이다. 재시도하지 않는다.
- 요청은 세션에 연결된 **모든 문서**에 간다. 읽기는 첫 답이 채택되고 **쓰기는 적격 문서 전부가 실행한다.**
- 부적격이면 **침묵하지 말고 `not_eligible`로 답한다.** 침묵하면 런타임이 응답을 기다린다.
- `nav.navigate` · `nav.reload` · `dom.submit_form`(그리고 이동을 유발하는 `dom.click`)은 **응답을 먼저
  보내고 그 다음에 실행한다.** 순서를 뒤집으면 unload에 응답이 잘려 스크립트가 `opTimeoutMs`만큼 멈춘다.

## 4. durable로 짜던 습관 세 가지를 버린다

| durable 사고 | RPC Lua 사고 |
|---|---|
| 한 명령이 여러 단계를 품고 replay로 살아남는다 | **스크립트가 단계를 소유한다.** 이동은 폴링으로 넘는다 |
| 명령이 사이트 의미를 갖는다 (`AX_add_to_cart`) | **범용 op을 조합한다.** 사이트 의미는 스크립트에 있다 |
| 실패는 journal에 남고 재개된다 | **실패는 값이다.** `pcall`로 잡거나 노드 오류로 올린다 |

세 번째가 특히 다르다. RPC는 재개하지 않는다. 문서가 죽으면 그 호출은 사라진다. 그래서 **되돌릴 수 없는
부수효과 앞에서는 상태를 먼저 읽어 두고**, 실패하면 다음 노드가 그 상태로 판단하게 만든다.

## 5. 뼈대

```yaml
version: 1
app: { id: <appId>, entryAgent: planner }
planner:
  allowedTools: [decide]
  inputSelector: [active.flow, active.node, queue]
router:
  routes:
    - intent: cart_review
      priority: 200
      entry: cart_review.read
      description: Read the shopping cart and report its total.
      examples: [장바구니 확인, 카트 총액, cart total]
flowTools:
  read_cart:
    description: Read the cart heading and total from the live page.
    execute:
      kind: runtime
      implementation: lua
      rpc:
        allow: [dom.get_location_href, dom.exists, dom.get_text]
        opTimeoutMs: 5000
      entry: run
      lua: |
        function run(args)
          if not dom.wait_for_selector("#total", { timeout = 2000, interval = 100 }) then
            return { next = "empty" }
          end
          return { next = "ok", title = dom.get_text("h1"), total = dom.get_text("#total") }
        end
    parameters:
      type: object
      properties: {}
flows:
  cart_review:
    goal: Read the cart total from the page the user is on.
    nodes:
      read:
        inputSelector: []
        id: read_cart
        kind: action_contract
        next: { ok: done, empty: missing }
      done:
        inputSelector: [total, title]
        kind: terminal
        respond: { from: [total], fallback: "cart-read-complete" }
      missing: { inputSelector: [], kind: terminal, respond: "cart-read-empty" }
```

**`action_contract` 도구의 파라미터 스키마에 `additionalProperties: false`를 쓰지 마라.** 런타임이
자체 필드를 args에 넣기 때문에 거부된다. 위 예제도 그것 때문에 한 번 죽었다.

## 6. 시나리오

### 6.1 읽기 — 페이지에서 구조화된 데이터 뽑기

목록을 읽을 때 셀렉터를 하나씩 부르지 말고 `query_all`로 한 번에 가져온다. 왕복이 곧 비용이다.

```lua
function run(args)
  if not dom.wait_for_selector(".product", { timeout = 5000 }) then
    return { next = "empty" }
  end
  local rows = dom.query_all(".product", {
    id    = { attr = "data-id" },
    name  = { selector = "h3" },
    price = { selector = ".price" },
    link  = { selector = "a", attr = "href" },
  }, 20)
  local items = array({})
  for _, row in ipairs(rows) do
    if row.price ~= nil and row.price ~= "" then items[#items + 1] = row end
  end
  return { next = (#items > 0) and "ok" or "empty", items = items, count = #items }
end
```

`query_all(selector, fields, limit)` — `fields`는 필드명 → `{ selector?, attr? }`. `limit`을 꼭 준다.
페이지에 1000개가 있으면 1000개가 온다.

**목록은 `array()`로 감싼다.** Lua는 빈 테이블과 빈 배열이 같은 값이라, 그냥 `{}`로 두면 결과가 `[]`가
아니라 `{}`로 나간다. 소비하는 노드가 배열을 기대하면 그때 깨진다.

```lua
local items = array({})        -- ❌ local items = {}
items[#items + 1] = row
return { items = items }       -- 비어 있어도 []
```

### 6.2 폼 채우기 — 있는 값은 두고 없는 값만

```lua
function run(args)
  local form = args.form or "checkout"
  local names = dom.get_form_field_names(form)
  local missing, filled = array({}), array({})
  for _, name in ipairs(names) do
    local current = dom.get_form_field_value(form, name)
    local wanted = (args.values or {})[name]
    if current == nil or current == "" then
      if wanted ~= nil and wanted ~= "" then
        dom.set_form_field_value(form, name, wanted)
        filled[#filled + 1] = name
      else
        missing[#missing + 1] = name
      end
    end
  end
  return { next = (#missing == 0) and "ready" or "incomplete", filled = filled, missing = missing }
end
```

`missing`을 돌려주면 다음 `action_unit` 노드가 그것만 사용자에게 묻는다. **무엇을 물을지 판단하는 로직이
스크립트에 있고 LLM은 문장만 만든다.**

### 6.3 이동 — fire-only와 도착 확인

`nav.navigate`는 요청 접수만 답한다. 문서가 unload 중이라 완료를 보고할 수 없다.

```lua
function run(args)
  local from = dom.get_location_href()
  nav.navigate(args.url)
  if not nav.wait_for_navigation(from, { timeout = 8000, interval = 200 }) then
    return { next = "stuck", href = dom.get_location_href() }
  end
  if not dom.wait_for_selector(args.ready or "body", { timeout = 5000, interval = 200 }) then
    return { next = "slow", href = dom.get_location_href() }
  end
  return { next = "ok", href = dom.get_location_href() }
end
```

**`dom.exists`만으로 도착을 판정하지 마라.** 옛 문서가 아직 살아서 옛 페이지 기준으로 답한다. 두 페이지에
같은 셀렉터가 있으면 조용히 통과한다. **href가 바뀐 것을 먼저 확인한다.**

이동 공백에는 연결 문서가 0개라 폴이 `no_client`를 즉시 받는다. 폴 헬퍼가 흡수하므로 신경 쓰지 않아도 된다.

### 6.4 제출 — 문서가 사라지기 전에 읽는다

`dom.submit_form`도 `nav.navigate`와 같은 부류다. 실제 폼 제출은 문서를 교체한다.

```lua
function run(args)
  local form = args.form or "checkout"
  -- 제출 뒤에는 아무것도 읽을 수 없다. 증거를 먼저 확보한다.
  local snapshot = {}
  for _, name in ipairs(dom.get_form_field_names(form)) do
    snapshot[name] = dom.get_form_field_value(form, name)
  end
  local from = dom.get_location_href()
  dom.submit_form(form)
  local left = nav.wait_for_navigation(from, { timeout = 8000, interval = 200 })
  return { next = "ok", submitted = snapshot, left = left }
end
```

`left = false`는 실패가 아니다 — AJAX 제출이면 페이지가 그대로다. 사이트가 어느 쪽인지 알면 분기하고,
모르면 다음 노드가 결과 페이지를 확인하게 둔다.

### 6.5 되돌릴 수 없는 조작 — 확인 후 실행

장바구니 담기·결제 같은 것은 **노드를 나눈다.** 스크립트가 확인까지 하려 들면 사용자 동의가 스크립트
안으로 들어가 버린다.

```yaml
flows:
  cart_add:
    nodes:
      inspect:
        inputSelector: [productId]
        id: read_product
        kind: action_contract
        next: { ok: confirm, missing: failed }
      confirm:
        inputSelector: [product, price]
        id: ask_confirm          # passthrough. LLM이 확인 문장을 만든다
        kind: action_unit
        next: { yes: commit, no: cancelled }
      commit:
        inputSelector: [productId]
        id: add_to_cart
        kind: action_contract
        next: { ok: done, error: failed }
```

`commit` 노드의 스크립트만 쓰기 op을 갖는다. `allow`에도 그 노드에만 쓰기 op을 넣는다 —
`inspect`의 `allow`에 `dom.click`이 없으면 실수로도 못 누른다.

### 6.6 여러 사이트를 도는 작업

한 스크립트에서 루프 돌지 말고 **`flow.map`으로 사이트당 서브플로우**를 돌린다. 스크립트 하나가
여러 사이트를 순회하면 중간 실패 시 어디까지 갔는지 상태에 남지 않는다.

```yaml
  search_all_sites:
    execute:
      kind: runtime
      implementation: flow.map
      flow: search_one_site
      itemsArg: sites
      resultFrom: result
      maxItems: 8
```

서브플로우 안에서만 RPC를 쓴다. 각 사이트 결과가 항목별로 모이고, 하나가 실패해도 나머지가 남는다.

### 6.7 판단이 필요한 지점 — LLM에게 넘긴다

스크립트는 **결정론**을 담당하고, 애매한 선택은 노드를 나눠 LLM에게 준다.

```
read_candidates (action_contract, RPC)  →  후보 20개를 state에 적재
      ↓
choose (action_unit, passthrough)       →  LLM이 하나 고름
      ↓
open_chosen (action_contract, RPC)      →  고른 것을 연다
```

스크립트 안에서 `if name:match("사과")` 같은 걸 하지 마라. 사이트가 바뀌면 깨지고, 왜 그걸 골랐는지
로그에 남지 않는다.

## 7. 실패 설계

| 상황 | 스크립트가 보는 것 | 권장 처리 |
|---|---|---|
| 요소 없음(읽기) | `no_element` 오류 | `pcall`로 잡아 `next = "empty"` |
| 대기 시간 초과 | `false` (오류 아님) | 분기 |
| 연결 문서 없음 | `no_client` 오류 | 이동 중이면 폴이 흡수. 아니면 노드 오류로 |
| 인자 거부 | `bad_params` 오류 | 스크립트 버그다. 잡지 말고 터뜨린다 |
| op 하나 무응답 | `rpc_timeout` (`opTimeoutMs` 후) | 노드 오류 |
| 스크립트 예산 초과 | 노드 오류 | `deadlineMs` 상향 또는 노드 분할 |

```lua
local ok, value = pcall(function() return dom.get_text("#optional") end)
local note = ok and value or nil
```

**모든 것을 `pcall`로 감싸지 마라.** 잡아서 분기할 것만 잡는다. 나머지는 노드 오류로 올려 flow의
`next.error`가 받게 하는 편이 디버깅이 쉽다.

## 8. 다중 문서

같은 세션에 탭이 여럿 붙으면 op이 **전부에게** 간다. 읽기는 첫 답이 채택되고, **쓰기는 적격 문서 전부가
실행한다.**

클라이언트가 `isEligible`로 좁히는 것이 1차 방어다. 부적격 문서는 `not_eligible`로 **답해야** 한다 —
침묵하면 런타임이 응답을 기다린다.

스크립트 측 확인:

```lua
dom.click("#submit")
local f = rpc.fanout()
if f.silent > 0 then return { next = "unsure", atMost = f.executed } end
if f.executed > 1 then return { next = "ambiguous", documents = f.executed } end
```

`silent > 0`은 "모른다"는 뜻이다. 연결이 고갈된 오리진에서는 상시가 될 수 있다. **그때 잃는 것은 아는
것뿐이고 보호는 유지된다** — 부적격 문서는 거부했으므로 애초에 실행하지 않았다.

## 9. 예산

| | 기본 | 상한 | 언제 만진다 |
|---|---|---|---|
| `maxCalls` | 무제한 | 512 | **대기하는 스크립트에는 걸지 마라.** 폴마다 1회 소모 |
| `deadlineMs` | 60,000 | 120,000 | 이동을 여러 번 하는 작업에서 상향 |
| `opTimeoutMs` | 10,000 | — | 느린 사이트에서 상향. 이동 op은 짧게(fire-only라 즉답) |
| `maxInstructions` | 2,000,000 | 10,000,000 | 큰 목록을 순회할 때 |

폴 간격 기본 150ms. **평문 HTTP 오리진에서는 100 미만으로 내리지 마라** — 탭마다 SSE가 연결 한도를
잠식해 응답이 밀린다.

## 10. 작성 순서

1. **op 목록을 받는다** — `GET /axsdk/v2/lua/ops`. 문서를 믿지 않는다.
2. **노드를 나눈다** — 결정론(스크립트)과 판단(LLM)의 경계, 되돌릴 수 없는 조작의 경계.
3. **각 노드의 `allow`를 최소로** — 그 노드가 실제로 부르는 op만.
4. **스크립트를 쓴다** — 읽기 먼저, 쓰기 마지막, 이동은 fire-only + 도착 확인.
5. **`clientFlows`로 보내고 돌린다** — 실패하면 런타임 state의 `__error.message`를 본다.

```
GET <runtime>/session/<sessionID>/state
→ configRuntimeState.stepOutputs        스크립트가 반환한 값
→ ...__error.message                    노드가 죽은 이유
```

## 11. 흔한 실수

| 증상 | 원인 |
|---|---|
| `schema rejected value: Unrecognized key` | `action_contract` 도구에 `additionalProperties: false` |
| `rpc op '...' is not allowed` | `allow`에 없다. 대기 헬퍼는 **폴링 대상 op**을 적어야 한다 |
| 노드가 opTimeoutMs만큼 멈춘다 | 클라이언트가 이동/제출 **후에** 응답했다 |
| 이동했는데 옛 페이지 데이터 | `dom.exists`만으로 도착 판정. href 변화를 먼저 봐야 한다 |
| 제출 후 읽은 값이 비어 있다 | 제출이 문서를 파괴했다. 제출 전에 읽는다 |
| `state: session`인데 상태가 안 쌓인다 | `entry`가 없거나 `rpc` 블록 안에 `state`를 넣었다 |
| 큰 목록에서 스크립트가 죽는다 | `query_all`에 `limit`이 없다 |
| 빈 목록이 `[]`가 아니라 `{}`로 온다 | 목록을 `array()`로 감싸지 않았다 |

## 12. 검증과 참조 구현

```sh
bun run test:clientflows-rpc:live   # 이 문서의 최소 예제를 그대로 실행 (4 checks)
bun run check:rpc-docs              # op 목록이 런타임과 일치하는지
```

실패하면 런타임 상태에서 이유를 본다.

```
GET <runtime>/session/<sessionID>/state
→ configRuntimeState.stepOutputs     스크립트가 반환한 값
→ ...__error.message                 노드가 죽은 이유
```

### 12.1 전문

아래가 §1의 전달 모델과 §3의 와이어 계약을 코드로 한 것이다. 앱 패키지에 아무 정의 없이 `clientFlows`만으로
라우팅·플로우·Lua·RPC가 도는 것을 증명한다(4/4). 새 시나리오는 `CLIENT_FLOWS` 상수를 바꿔가며 시작하면 된다.

가짜 페이지(`PAGE`/`href`/`clicked`)를 실제 DOM으로 바꾸고 `answer()`를 실제 구현으로 채우면 그대로
프로덕션 핸들러가 된다. 다만 세 가지는 이 파일에 없다:

- SSE 파싱이 `buffer.split("\n\n")`이다. 실제로는 CRLF·잘린 프레임·comment 라인을 다루는 파서를 쓴다.
- `isEligible` 판정이 없다. 다중 탭에서는 활성 탭만 실행하고 나머지는 `not_eligible`로 답해야 한다.
- `rpcId` 중복 방어와 전송 재시도가 없다.

```ts
/**
 * Proves the premise for client-authored agentic tasks: a flow document the client sends at session
 * creation, whose tools drive the browser over RPC, with no app-side definition of any of it.
 *
 * Nothing here exists in apps/. The router, the flow, the Lua and the op vocabulary all arrive in the
 * clientFlows payload.
 */
import { loadApiKey } from "./lib/live-scenario"

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:4800"
const appId = "browser-extension"
const key = loadApiKey(appId)
const forwardedFor = `127.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 254)}`

const PAGE: Record<string, string> = { "h1": "장바구니", "#total": "42,000원" }
let href = "https://shop.test/cart"
const clicked: string[] = []

const CLIENT_FLOWS = `
version: 1
app:
  id: browser-extension
  entryAgent: planner
planner:
  allowedTools: [decide]
  inputSelector: [active.flow, active.node, queue]
router:
  routes:
    - intent: cart_review
      priority: 200
      entry: cart_review.read
      description: Read the shopping cart and report its total.
      examples:
        - 장바구니 확인
        - 카트 총액
        - cart total
flowTools:
  read_cart:
    description: Read the cart heading and total from the live page.
    execute:
      kind: runtime
      implementation: lua
      rpc:
        allow: [dom.get_location_href, dom.exists, dom.get_text, dom.click]
        opTimeoutMs: 5000
      entry: run
      lua: |
        function run(args)
          local href = dom.get_location_href()
          if not dom.wait_for_selector("#total", { timeout = 2000, interval = 100 }) then
            return { next = "empty", href = href }
          end
          dom.click("#refresh")
          return {
            next = "ok",
            href = href,
            title = dom.get_text("h1"),
            total = dom.get_text("#total"),
            documents = rpc.fanout().executed,
          }
        end
    parameters:
      type: object
      properties: {}
flows:
  cart_review:
    goal: Read the cart total from the page the user is on.
    nodes:
      read:
        inputSelector: []
        id: read_cart
        kind: action_contract
        description: Read the cart.
        next: { ok: done, empty: missing }
      done:
        inputSelector: [total, title, href, documents]
        kind: terminal
        respond: { from: [total], fallback: "cart-read-complete" }
      missing:
        inputSelector: [href]
        kind: terminal
        respond: "cart-read-empty"
`

interface RpcFrame { rpcId: string; op: string; params: { selector?: string } }

function headers(uid: string, sid?: string): Record<string, string> {
  return {
    "x-api-key": key,
    "x-app-id": appId,
    "x-app-user-id": uid,
    "x-app-user-name": "ClientFlows RPC Check",
    "x-forwarded-for": forwardedFor,
    origin: "http://localhost:3334",
    "Content-Type": "application/json",
    ...(sid ? { "x-app-user-session-id": sid } : {}),
  }
}

async function createSession(uid: string): Promise<string> {
  const res = await fetch(`${backendUrl}/axsdk/v2/sessions`, {
    method: "POST",
    headers: headers(uid),
    body: JSON.stringify({ clientFlows: CLIENT_FLOWS }),
  })
  if (!res.ok) throw new Error(`session creation failed: ${res.status} ${await res.text()}`)
  const body = await res.json() as { sessionID?: string }
  if (!body.sessionID) throw new Error("session creation returned no sessionID")
  return body.sessionID
}

function openClient(uid: string, sid: string) {
  const controller = new AbortController()
  const frames: RpcFrame[] = []
  let resolveConnected: () => void = () => {}
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve })
  let resolveIdle: (() => void) | undefined
  const text: string[] = []

  const answer = (frame: RpcFrame) => {
    if (frame.op === "dom.get_location_href") return { ok: true, value: href }
    if (frame.op === "dom.exists") return { ok: true, value: PAGE[frame.params.selector ?? ""] !== undefined }
    if (frame.op === "dom.get_text") {
      const value = PAGE[frame.params.selector ?? ""]
      return value === undefined ? { ok: false, error: "no_element", detail: frame.params.selector } : { ok: true, value }
    }
    if (frame.op === "dom.click") {
      clicked.push(frame.params.selector ?? "")
      return { ok: true, value: true }
    }
    return { ok: false, error: "op_unsupported", detail: frame.op }
  }

  void (async () => {
    const res = await fetch(`${backendUrl}/axsdk/v2/event`, { headers: headers(uid, sid), signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`sse connect failed: ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        const line = chunk.split("\n").find(entry => entry.startsWith("data:"))
        if (!line) continue
        const parsed = JSON.parse(line.slice(5).trim()) as { payload?: { type?: string; properties?: Record<string, unknown> } }
        const type = parsed.payload?.type
        const props = parsed.payload?.properties
        if (type === "server.connected") resolveConnected()
        if (type === "session.status" && props?.status === "idle") resolveIdle?.()
        if (type === "message.part.updated" || type === "message.updated") {
          const part = (props?.part ?? props) as { type?: string; text?: string }
          if (part?.type === "text" && typeof part.text === "string") text.push(part.text)
        }
        if (type !== "axsdk.rpc.request" || !props) continue
        const frame = props as unknown as RpcFrame
        frames.push(frame)
        await fetch(`${backendUrl}/axsdk/v2/rpc/${frame.rpcId}`, {
          method: "POST", headers: headers(uid, sid), body: JSON.stringify(answer(frame)),
        })
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) console.error(`[client] ${String(error)}`) })

  return { frames, text, connected, close: () => controller.abort(), idle: () => new Promise<void>((r) => { resolveIdle = r }) }
}

const results: Array<{ name: string; ok: boolean }> = []
function check(name: string, ok: boolean, detail: unknown = ""): void {
  results.push({ name, ok })
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${ok || detail === "" ? "" : ` — ${JSON.stringify(detail)}`}`)
}

async function main(): Promise<void> {
  const uid = `cf_rpc_${Date.now()}`
  const sid = await createSession(uid)
  console.log(`session ${sid}`)

  const client = openClient(uid, sid)
  await client.connected
  const idle = client.idle()
  await fetch(`${backendUrl}/axsdk/v2/sessions/message`, {
    method: "POST", headers: headers(uid, sid), body: JSON.stringify({ text: "장바구니 확인해줘" }),
  })
  await Promise.race([idle, new Promise(resolve => setTimeout(resolve, 90000))])
  await new Promise(resolve => setTimeout(resolve, 1500))

  const ops = client.frames.map(frame => frame.op)
  check("a client-authored route reached a client-authored flow", ops.length > 0, ops)
  check("the client-authored lua drove the page", ops.includes("dom.get_text") && ops.includes("dom.exists"), ops)
  check("a write op declared only in the client document ran", clicked.includes("#refresh"), clicked)
  check("the terminal carries what the client's script read", client.text.join(" ").includes("42,000"), client.text.join(" ").slice(0, 160))

  client.close()
  const failures = results.filter(entry => !entry.ok)
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
  if (failures.length > 0) process.exit(1)
}

await main()
```
