# RPC Lua 작성 가이드

`flows.yaml`에서 브라우저를 직접 조작하는 Lua 도구를 쓰는 방법. 계약 정의는
`FLOWS_YAML_SPEC.md` §9.2.1 / §9.2.2이고, 이 문서는 **작성 방법과 예시**다.

이 문서의 모든 예제는 `apps/browser-extension/flows.yaml`에 실재하며
`bun run test:lua-rpc-flow:live`로 검증된다.

## 1. 언제 쓰는가

| 하고 싶은 것 | 쓸 것 |
|---|---|
| 페이지를 여러 단계로 조작 (읽고 → 판단하고 → 쓰고) | **RPC Lua** |
| 원격 명령 한 번 호출하고 끝 | `kind: remote` |
| 상태 계산만, 페이지 안 건드림 | `implementation: state.transform` |
| LLM이 매 단계 도구를 고름 | `kind: action_unit` |
| 클라이언트가 시작하는 작업, 오프라인 진행 | 클라이언트측 `AX_run_lua` |

**판단 기준 하나**: 페이지 조작이 **두 번 이상**이고 그 사이에 **판단**이 있으면 RPC Lua다.
한 번이면 remote 도구가 더 싸다.

## 2. 최소 예제

```yaml
flowTools:
  page_title:
    description: Read the page heading.
    execute:
      kind: runtime
      implementation: lua
      rpc:
        allow: [dom.get_text]
      lua: |
        return { next = "ok", title = dom.get_text("h1") }
    parameters:
      type: object
      properties: {}
      additionalProperties: false
```

`entry` 없이 쓰면 청크 전체가 실행되고 마지막 `return`이 결과다. 반환 테이블의 `next`가 노드
전이를 정한다.

## 3. 선언 레퍼런스

```yaml
execute:
  kind: runtime
  implementation: lua
  rpc:                      # 이 블록이 있으면 브라우저 op을 쓸 수 있다
    allow: [dom.get_text]   # 필수는 아니지만 **항상 쓰라**. 없으면 전체 허용
    maxCalls: 12            # 선택. 1..512. 기본 무제한
    deadlineMs: 30000       # 선택. 1..120000. 기본 60000. 스크립트 전체
    opTimeoutMs: 5000       # 선택. op 하나. 기본 10000
  state: session            # 선택. "call"(기본) | "session"
  entry: run                # state: session이면 필수
  maxInstructions: 2000000  # 선택. 순수 계산 상한
  lua: |
    ...
```

`rpc` 블록에 들어가는 키는 `allow` / `maxCalls` / `deadlineMs` / `opTimeoutMs` **네 개뿐**이다.
`state`·`entry`·`lua`는 `rpc`의 형제다. `rpc` 안에 넣으면 컴파일 오류가 난다 — 조용히 무시되면
증상이 "세션 상태가 안 쌓인다" 하나뿐이라 추적이 불가능하기 때문이다.

## 4. op 어휘

클라이언트가 구현하는 **wire op**:

| 네임스페이스 | op |
|---|---|
| `nav` | `navigate(url, params?)` · `reload()` |
| `dom` | `get_location_href()` · `exists(sel)` · `get_text(sel)` · `get_attr(sel, attr)` · `get_innerHTML(sel)` · `get_outerHTML(sel)` · `query_all(sel, fields?, limit?)` · `click(sel, opts?)` · `set_value(sel, value)` · `get_form_field_names(form)` · `get_form_field_value(form, field)` · `set_form_field_value(form, field, value)` · `submit_form(form)` |
| `page` | `eval(script)` |

호스트가 제공하는 **비-op 프리미티브** (왕복 없음, `allow` 불필요, `maxCalls` 미소모):

| | |
|---|---|
| `rpc.now()` | 밀리초 시계. 샌드박스에 `os`가 없으므로 이것뿐 |
| `rpc.sleep(ms)` | 호스트 타이머로 일시정지 |
| `rpc.delivered_to()` | 직전 op의 fanout − 거부. **상한값** |
| `rpc.fanout()` | `{ executed, declined, silent }`. `silent == 0`이면 `executed`가 확정 |

prelude가 합성해 주는 **대기 헬퍼** (wire op 아님):

| | 실제로 무엇을 폴링하는가 |
|---|---|
| `dom.wait_for_selector(sel, opts?)` | `dom.exists` |
| `nav.wait_for_navigation(fromHref, opts?)` | `dom.get_location_href` |

`opts = { timeout = 3000, interval = 150 }`. **`allow`에는 폴링 대상 op을 적는다** — 헬퍼 이름을
적으면 안 된다.

```yaml
rpc:
  allow: [dom.exists]        # ✅ wait_for_selector가 쓰는 op
# allow: [dom.wait_for_selector]  ❌ 그런 op은 없다
```

## 5. 제어 흐름 — 이 기능의 존재 이유

### 분기

```lua
function run(args)
  local form = args.form or "demo-checkout"
  local names = dom.get_form_field_names(form)
  local fields, missing = {}, {}
  for _, name in ipairs(names) do
    local value = dom.get_form_field_value(form, name)
    fields[name] = value
    if value == nil or value == "" then missing[#missing + 1] = name end
  end
  return { next = "ok", form = form, fields = fields, missing = missing }
end
```

`missing` 계산이 **앱 설정 안에** 있다. 예전에는 이걸 하려고 클라이언트에 `AX_get_form`이라는
앱 전용 명령이 필요했다.

### 반복

```lua
function run(args)
  local form = args.form or "demo-checkout"
  local fields = {}
  for name, value in pairs(args.values or {}) do
    dom.set_form_field_value(form, name, value)
    fields[name] = dom.get_form_field_value(form, name)   -- 쓴 값을 되읽어 확인
  end
  return { next = "ok", form = form, fields = fields }
end
```

### 페이지 이동 가로지르기

```lua
function run(args)
  local from = dom.get_location_href()
  nav.navigate(args.link)
  local moved = nav.wait_for_navigation(from, { timeout = 8000, interval = 200 })
  return { next = "ok", link = args.link, moved = moved, href = dom.get_location_href() }
end
```

**문서를 파괴하는 op은 fire-only다** — `nav.navigate` · `nav.reload` · `dom.submit_form`, 그리고 이동을
유발하는 `dom.click`. 클라이언트가 요청을 접수하면 즉시 반환하고 결과는 알려주지 않는다. 알려줄 수 없다.
그 문서는 unload 중이다.

따라서 **필요한 값은 그 op보다 먼저 읽는다.**

```lua
local fields = {}
for _, name in ipairs(dom.get_form_field_names(form)) do
  fields[name] = dom.get_form_field_value(form, name)   -- 제출 전에 읽는다
end
dom.submit_form(form)
return { next = "ok", submitted = true, fields = fields }
```

이동 확인을 `dom.exists`로만 하면 **거짓 양성**에 걸린다. 옛 문서가 아직 살아서 옛 페이지 기준으로
답할 수 있다. **href가 바뀌는 것을 먼저 확인**한 뒤 요소를 기다린다.

```lua
nav.navigate(url)
nav.wait_for_navigation(from, { timeout = 5000 })   -- 먼저
dom.wait_for_selector("#address", { timeout = 3000 })  -- 그 다음
```

## 6. 실패 처리

op 실패는 **Lua error**로 올라온다. 안 잡으면 노드 오류가 되고(§9.13), `pcall`로 잡으면 값이 된다.

```lua
local ok, err = pcall(function() return dom.get_text("#maybe") end)
if not ok then
  return { next = "degraded", reason = tostring(err) }
end
```

| 상황 | 스크립트가 보는 것 |
|---|---|
| op이 실패를 보고 | `rpc <op> failed: <code>: <detail>` |
| 연결된 문서 없음 | `… failed: no_client` — **즉시** |
| 전원이 부적격 거부 | `… failed: no_client` — 즉시 |
| op 하나가 무응답 | `… failed: rpc_timeout` (`opTimeoutMs` 후) |
| 클라이언트가 인자 거부 | `… failed: bad_params: <field>` |
| 스크립트 전체 예산 초과 | 노드 오류 |

대기 헬퍼는 예외다 — 못 찾으면 `error`가 아니라 **`false`를 반환**한다. 그래서 평범한 분기가 된다.

## 7. 상태

```yaml
state: session
entry: run
```

`(세션, 도구 이름)`별로 Lua 상태가 살아남고 **청크를 다시 실행하지 않는다.** 그래서 청크 레벨
지역변수가 호출 간에 누적된다.

```lua
local seen = 0            -- 재사용 시 이 줄은 다시 안 돈다
function run(args)
  seen = seen + 1
  return { next = "ok", seen = seen }
end
```

- 청크를 다시 안 돌리므로 **`entry`가 필수**다. 없으면 아무것도 실행되지 않는다.
- 같은 키의 호출은 **직렬화**된다. RPC가 코루틴을 중단시키는 동안 두 번째 호출이 끼어들면
  지역변수가 깨지기 때문이다.
- 프로세스 메모리에만 있다. 런타임 재시작하면 초기화된다.

기본값(`state` 미선언)은 매 호출 새 상태 — 도구가 순수 함수로 남는다. 기존 `lua` 도구는 영향 없다.

## 8. 예산

| | 기본 | 상한 |
|---|---|---|
| `maxCalls` | 무제한 | 512 |
| `deadlineMs` | 60,000 | 120,000 |
| `opTimeoutMs` | 10,000 | — |

**대기 헬퍼는 폴링이므로 매 시도가 `maxCalls`에 잡힌다.** 3초 대기를 기본 간격으로 하면 최대 20회다.
**대기하는 스크립트에는 `maxCalls`를 걸지 마라.** 진짜 상한은 `deadlineMs`다.

`rpc.sleep`은 호출 수를 소모하지 않지만 `deadlineMs`는 소모한다.

평문 HTTP 오리진에서는 탭당 SSE가 연결 한도(6)를 잠식한다. 그런 배포를 대상으로 하는 앱은
`interval`을 **100 미만으로 두지 마라**. 기본 150은 안전하다.

## 9. 다중 문서

요청은 세션에 연결된 **모든 문서**로 나가고 **먼저 온 답**이 채택된다.

읽기는 무해하다. **쓰기는 적격 문서 전부가 실행한다** — `dom.click` · `dom.set_value` ·
`dom.set_form_field_value` · `dom.submit_form` · `page.eval`, 그리고 특히 `nav.navigate` ·
`nav.reload`(전부 이동한다).

중복 쓰기를 허용할 수 없으면 확인하고 중단한다. **`delivered_to()`만 보면 안 된다** — 늦게 도착한 거부가
실행자로 잡혀 있을 수 있다.

```lua
dom.click("#submit")
local f = rpc.fanout()
if f.silent > 0 then
  return { next = "unsure", atMost = f.executed }      -- 모른다는 것을 안다
end
if f.executed > 1 then
  return { next = "ambiguous", documents = f.executed } -- 확정된 중복
end
```

`silent > 0`은 인위적 상황이 아니다. 평문 오리진에서 탭이 많으면 거부 POST가 가장 먼저 밀리고, 밀린 만큼
`delivered_to()`가 과다 계상한다.

`delivered_to()`는 **직전 op**의 값이다. op보다 먼저 부르면 이전 값(첫 호출이면 0)을 본다.

```lua
local n = rpc.delivered_to()      -- ❌ 아직 아무 op도 안 했다
local t = dom.get_text("h1")

local t = dom.get_text("h1")      -- ✅
local n = rpc.delivered_to()
```

## 10. 자주 나오는 실수

**`action_contract` 노드에 필수 파라미터를 두는 것.** 이 노드는 인자를 **flow state**에서 만든다
(LLM 호출 없음). `inputSelector`에 채울 것이 없으면 스키마 검증에서 죽는다. 선택 파라미터로 두고
스크립트에서 기본값을 준다.

```yaml
parameters:
  properties: { selector: { type: string } }
  additionalProperties: false     # required 없음
```
```lua
local selector = args.selector or "h1"
```

**`allow`를 비워두는 것.** 없으면 전 op 허용이다. 도구가 실제로 쓰는 것만 적어라.

**스크립트가 만든 coroutine 안에서 op 호출.** 런타임이 거부한다 — 그 yield는 드라이버가 아니라
스크립트 자신에게 돌아가 교착한다.

**`page.eval`을 습관적으로 쓰는 것.** 클라이언트에서 opt-in이라 꺼져 있으면 `op_not_permitted`다.
탈출구이지 기본 도구가 아니다.

## 11. 검증

```sh
bun run scripts/validate-v3dev-intent-contract.ts <appId>   # 컴파일·계약
bun run scripts/agentv2_push.ts <appId>
bun run test:lua-rpc-flow:live                              # 실제 turn (planner → 노드 → 어댑터)
bun run test:lua-rpc:live                                   # 와이어 계약
```

`test:lua-rpc-flow:live`가 SSE를 구독해 op에 답하는 가짜 문서 역할을 한다. 새 op을 쓰는 도구를
추가했으면 `scripts/live-lua-rpc-flow-check.ts`의 `answer()`에 그 op의 응답을 넣어야 한다.

실제 브라우저 검증은 SDK가 RPC 핸들러를 낸 뒤에 가능하다 —
`docs/rpc_lua_implementation.md` 참조.
