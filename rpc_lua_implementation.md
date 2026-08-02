# SDK Lua RPC 적용 가이드

## 1. 목적과 대상 저장소

이 문서는 runtime에서 실행되는 Lua script가 브라우저를 조작할 수 있게 하는 **RPC 채널**의 client 측 구현을 정의한다.

- 대상 저장소: `axsdk-sdk-js`
- 대상 패키지: `packages/axsdk-core` (channel과 op dispatch), `packages/axsdk-extension` (다중 문서 검증)
- backend 계약: SSE `axsdk.rpc.request`, `POST /axsdk/v2/rpc/:rpcId`, `POST/GET/DELETE /axsdk/v2/lua`
- runtime 계약: `docs/FLOWS_YAML_SPEC.md` §9.2.1 / §9.2.2
- 비대상: agentv3 runtime, backend, app `flows.yaml`

서버 측(runtime·backend)은 구현·검증이 끝났다. Client handler만 없으므로 이 문서의 범위는 **op 실행과 응답**이다.

## 2. 왜 필요한가 — 기존 두 경로와의 R&R

> **개정 이력 — 이 절의 이전 결론은 철회되었다.**
> 이전 판은 *"RPC는 탐색을 넘기지 못한다. 탐색이 필요하면 `AX_run_lua`(durable replay)를 쓴다"* 라고 썼다.
> runtime이 `nav.navigate`를 fire-only로 바꾸고 대기를 폴링 합성으로 옮기면서 **RPC는 탐색을 넘긴다**(§2.2).
> 이 문장을 근거로 세운 판단이 있다면 다시 도출해야 한다.

같은 "브라우저에서 여러 단계를 수행한다"를 지금 세 방식으로 표현할 수 있다. 셋의 소유자가 다르므로 섞으면 안 된다.

| | remote tool (one dispatch) | client-side Lua (`AX_run_lua`) | **runtime-side Lua + RPC (신규)** |
|---|---|---|---|
| script 위치 | 없음 (runtime이 단계를 구동) | 브라우저 | agent runtime |
| 제어 흐름 소유 | runtime (노드 1개 = 단계 1개) | script | script |
| 페이지 이동 생존 | 재진입으로 생존 | durable replay로 생존 | **폴링으로 생존** (§2.2) |
| script 로컬 변수의 이동 생존 | — | **journal replay로 생존** | 생존 (runtime 메모리) |
| op 1회 비용 | 1 dispatch | in-process | dispatch ~4ms + 왕복 |
| script 출처 | — | site script / `AX_run_lua` 인자 | app `flows.yaml`, 또는 client 주입 module |
| runtime state 접근 | 있음 | 없음 | 있음 |

이 신규 경로를 쓸 이유:

1. script가 flow 설정에 있어 runtime state와 함께 버전 관리된다.
2. client가 배포 없이 module을 주입해 디버깅한다(§3.4).
3. 이동을 포함한 op 시퀀스 전체를 하나의 script로 표현한다.

반대로 **client가 스스로 시작하는 작업**, 오프라인/연결 단절 중에도 진행해야 하는 작업, 브라우저 로컬 상태에
의존하는 작업은 여전히 `AX_run_lua`다. 두 경로는 대체 관계가 아니라 **시작점이 다르다** — RPC는 runtime이
시작하고, `AX_run_lua`는 client가 시작한다.

### 2.1 이 문서가 대조한 SDK 커밋

`axsdk-sdk-js` `main` @ `ddaffb7` (= `origin/main`, clean). 이 문서의 파일·심볼 참조는 그 상태에서
확인했다. **줄 번호는 싣지 않는다** — 커밋마다 어긋나므로 심볼 이름으로만 지목한다.

client 측이 알려준 `5a38c41`(67 커밋 앞)은 **이 머신에서 조회되지 않는다**(`origin/main`도 `ddaffb7`).
미푸시 상태로 보이며, 따라서 HEAD 기준 재대조는 하지 못했다. HEAD에만 있는 대상(`src/steps/`,
`plans/durable-removal.md`)에 대한 판단은 §7 마지막 항목 그대로 client 측에 맡긴다.

### 2.2 탐색을 넘기는 방법 — runtime 측 변경 (적용 완료)

client가 대기를 구현할 수 없다는 것이 출발점이다. 대기 RPC는 **곧 unload될 문서에 발급되므로 영원히
응답되지 않는다.** 그래서 runtime을 바꿨다.

| 변경 | 내용 |
|---|---|
| `nav.navigate` 계약 | "이동 완료" → **"요청 접수, 즉시 반환"** |
| `dom.wait_for_selector` | wire op **삭제**. prelude가 `dom.exists`를 폴링 |
| `nav.wait_for_navigation` | wire op **삭제**. prelude가 `dom.get_location_href`를 폴링 |
| `rpc.now()` / `rpc.sleep(ms)` | 신규 host 프리미티브. 왕복 없음, `maxCalls` 미소모 |

폴링이 이동을 넘기는 이유: 매 시도가 독립적이고, 이동 공백에는 연결 문서가 0개라 `no_client`가 **즉시**
오며, prelude의 폴 헬퍼가 그 실패를 `pcall`로 흡수하고 계속 시도한다. 새 문서가 SSE에 붙는 순간 다음 폴이
답을 받는다.

**client 작업량이 줄어든다.** 가장 어려운 3개 op 중 2개가 사라졌다(§4.1 계층 C 참조).

## 3. Wire 계약

### 3.1 요청 — SSE event

RPC 요청은 durable replay와 분리된 **ephemeral** event다.

```json
{
  "payload": {
    "type": "axsdk.rpc.request",
    "properties": {
      "rpcId": "rpc_01K9…",
      "op": "dom.get_text",
      "params": { "selector": "h1" },
      "deadlineMs": 60000
    }
  }
}
```

- `id`(SSE cursor)가 **없다.** durable stream에 기록되지 않으므로 `Last-Event-ID`로 재생되지 않는다.
- `meta.cursor`가 없으므로 protocol-v2 client의 replay drain 대상이 아니다.
- 세션에 연결된 **모든 문서**에 전달된다. 대상 문서를 지정하는 필드는 없다.

### 3.2 응답 — `POST /axsdk/v2/rpc/:rpcId`

```jsonc
// 성공
{ "ok": true, "value": "장바구니" }     // value는 임의 JSON. 생략하면 undefined, null은 null로 구분된다
// 실패
{ "ok": false, "error": "no_element", "detail": "h1" }   // error 생략 시 "op_failed", detail은 string만 유지
```

응답:

```jsonc
{ "accepted": true }                   // 이 응답이 채택됨
{ "accepted": false }                  // 다른 문서가 먼저 답했거나 op 타임아웃이 지남
{ "accepted": false, "declined": true } // 거부로 접수됨 (§3.5)
```

- **`accepted: false`도 HTTP 200이다.** 재시도하면 안 된다. 4xx가 아닌 이유는 client가 무한 재시도에 빠지지 않게 하기 위함이다.
- `ok` field가 boolean이 아니면 400 `rpc_result_invalid`.

### 3.3 첫 응답 승자 규칙

runtime은 **먼저 도착한 terminal 응답**을 채택하고 이후 응답을 버린다.

- 읽기 op에서는 무해하다.
- **쓰기 op은 적격 문서 전부가 실행한다.** 결과는 하나만 반환되지만 부수효과는 전부 발생한다. 목록:
  `dom.click`, `dom.set_value`, `dom.submit_form`, `page.eval`, 그리고 **`nav.navigate` / `nav.reload`** —
  뒤의 둘은 적격 문서를 전부 이동시키므로 부수효과가 가장 크다.
- 먼저 온 **실패**가 나중의 성공을 이긴다. 잘못된 페이지의 `no_element`가 올바른 페이지의 성공을 제칠 수 있다.

완화 수단은 §3.5의 거부와 §4.3의 적격성 판단이다.

### 3.4 Module 주입 (§9.2.2)

```
POST   /axsdk/v2/lua            { name, source, allow? }  → { name, exports, injectedAt }
GET    /axsdk/v2/lua                                      → { data: [{ name, exports, injectedAt }] }
DELETE /axsdk/v2/lua/:name                                → { ok, removed }
POST   /axsdk/v2/lua/:name/:fn  { args?, timeoutMs? }      → { status: "completed", value }
                                                          | { status: "error", error }
```

- 주입은 **compile만** 한다(실행하지 않음). `exports`는 정적 scan 결과이며 권위는 invoke 시점이다.
- 같은 이름 재주입은 그 module의 live state를 폐기한다.
- script 실패는 HTTP 실패가 아니라 `200` + `status: "error"`다.
- invoke는 script가 끝날 때까지 **blocking**이다. 그 사이 이 문서가 자기 RPC에 응답해야 하므로, invoke를 호출한 코드가 SSE 처리를 막으면 교착한다. §4.4 참조.

### 3.5 거부는 답이 아니다 — `not_eligible`

**이 절이 §4.2 규칙 3의 이전 판(침묵)을 대체한다.** 침묵은 교착을 만든다: 탭 2개에서 하나가 이동 중이고
하나가 부적격이면 연결 수가 1이라 dispatch는 성공하는데 아무도 답하지 않아, 폴 헬퍼가 자기 `timeout`을
써보지도 못하고 op 타임아웃까지 멈춘다.

```jsonc
{ "ok": false, "error": "not_eligible" }
```

runtime은 이것을 **settle하지 않는다.** 수신자 수(dispatch fanout)와 거부 수를 비교하다가 **모두 거부하면
즉시 `no_client`** 로 실패시킨다 — 연결이 아예 없을 때와 같은 빠른 실패다. 하나라도 아직 답하지 않았으면
계속 기다린다.

그래서 client는 적격성 축소와 폴링 대기를 **동시에** 쓸 수 있다. 별도 플래그가 필요 없다.

## 4. 변경 파일과 구현 방법

### 4.1 `packages/axsdk-core/src/lua/rpc-ops.ts` (신규): op 테이블

RPC op 이름은 `default-capabilities.ts`의 기존 capability 이름과 동일하게 맞춰져 있다. 다만 **capability를
그대로 부르면 안 된다** — 대부분 `durableCapability`로 감싸여 있고, `runLuaDurableStep`은 durable 브리지가
없으면(`getCommandContext()?.runDurableStep`이 undefined) 그냥 `execute()`를 한 번 돌리고 끝난다. RPC 문맥에는
브리지가 없다. 순수 코어를 직접 import 한다.

```ts
export interface AXRpcFrame {
  rpcId: string
  op: string
  params: Record<string, unknown>
  deadlineMs: number
}

export type AXRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; detail?: string }

export interface AXRpcOpContext {
  /** frame deadline에서 남은 예산. handler는 이보다 오래 돌지 않는다. */
  readonly remainingMs: number
  readonly signal: AbortSignal
}

export type AXRpcOpHandler = (
  params: Record<string, unknown>,
  context: AXRpcOpContext,
) => unknown | Promise<unknown>

export interface AXRpcOpTableOptions {
  allowPageEval?: boolean
  ops?: Record<string, AXRpcOpHandler>
}

export function createRpcOpTable(options?: AXRpcOpTableOptions): Record<string, AXRpcOpHandler>
export function executeRpcOp(table: Record<string, AXRpcOpHandler>, frame: AXRpcFrame): Promise<AXRpcResult>
```

`AXLuaDefaultBrowserGlobals`를 받지 않는다. 그걸 받으면 durable 래퍼를 뚫어야 하는데 불가능하다.

**계층 A — 순수 함수 그대로 (9개).** `default-capabilities.ts`에서 module-private인 것을 export 만 하면 된다.

| op | 순수 함수 | params |
|---|---|---|
| `dom.get_location_href` | `getAXSDKLocationHref` | `{}` |
| `dom.exists` | `luaElementExists` | `{ selector }` |
| `dom.get_text` | `getLuaText` | `{ selector }` |
| `dom.get_attr` | `getLuaAttribute` | `{ selector, attribute }` |
| `dom.get_innerHTML` | `getLuaInnerHTML` | `{ selector }` |
| `dom.get_outerHTML` | `getLuaOuterHTML` | `{ selector }` |
| `dom.query_all` | `queryLuaElements` | `{ selector, fields?, limit? }` |
| `dom.get_form_field_names` | `findLuaForm` + `getLuaFormFields` | `{ formName }` |
| `dom.get_form_field_value` | `findLuaForm` + `getLuaFormField` + `readLuaFormField` | `{ formName, fieldName }` |

**계층 B — durable 래퍼 안의 순수 코어만 (3개).** replay 재적용과 항해 감지는 RPC에 무의미하다.

| op | 순수 코어 | params |
|---|---|---|
| `dom.click` | `clickLuaElement` | `{ selector, opts? }` |
| `dom.set_value` | `setLuaElementValue` | `{ selector, value }` |
| `dom.set_form_field_value` | `findLuaForm` + `getLuaFormField` + `writeLuaFormField` | `{ formName, fieldName, value }` |

**계층 C — 문서를 파괴한다. 선응답 후 실행 (3개).** §4.1.1이 이 계층의 규칙이다.

| op | 구현 | params |
|---|---|---|
| `nav.navigate` | 선응답 후 `location.assign` | `{ url, params? }` |
| `nav.reload` | 선응답 후 `location.reload()` | `{}` |
| `dom.submit_form` | 선응답 후 `findLuaForm` + `submitLuaForm` | `{ formName }` |

`dom.click`이 이동을 유발하는 경우에도 계층 C 규칙을 따른다. 순수 코어를 쓰는 것과 **응답을 먼저 보내는
것은 별개**다 — 계층 B/C의 구분은 durable 래퍼를 벗기느냐가 아니라 실행이 문서를 없애느냐다.

**계층 D — opt-in (1개).** `page.eval` — `{ script }`.

합계 **16개**. 이 목록은 런타임 prelude가 정본이며 `bun run check:rpc-docs`가 대조한다.

**대기 op은 목록에 없다.** `dom.wait_for_selector`와 `nav.wait_for_navigation`은 runtime prelude가 `dom.exists`
/ `dom.get_location_href` 폴링으로 합성한다(§2.2). client는 구현하지 않는다. 이전 판에는 이 둘이 계층 C로
있었고, `waitForLuaSelector`를 재사용하면 **요소가 아직 없을 때 기다리지 않고 즉시 `false`를 반환**하는
결함이 있었다 — 그 결함째로 사라졌다.

**결과 판정 규칙**

| 상황 | 결과 |
|---|---|
| 미등록 op | `{ ok:false, error:'command_unresolved', detail:op }` |
| handler throw | `{ ok:false, error:'op_threw', detail:message }` |
| `page.eval` 비허용 | `{ ok:false, error:'op_not_permitted', detail:'page.eval' }` |
| 요소 부재(읽기) | `{ ok:false, error:'no_element', detail:selector }` — script가 `pcall`로 잡는다 |
| `remainingMs` 소진 | `{ ok:false, error:'op_deadline' }` |
| 인자가 없거나 빈 문자열 | `{ ok:false, error:'bad_params', detail:<field> }` — **DOM을 건드리기 전에** 거부 |

`no_element`가 `ok:false`인 것이 핵심이다. runtime의 폴 헬퍼가 이 실패를 `pcall`로 흡수하고 재시도하므로,
**"없음"을 정상값으로 위장하면 안 된다.**

#### 4.1.1 문서를 파괴하는 op — 응답을 먼저 보낸다

`nav.navigate` · `nav.reload` · `dom.submit_form`, 그리고 이동을 유발하는 `dom.click`이 여기 해당한다.
실제 폼 제출은 문서를 교체하므로 탐색과 같은 부류다.

계약이 "완료"가 아니라 **"요청 접수"** 다. 결과 확인은 script가 `nav.wait_for_navigation` 등으로 한다.

```
1. { ok: true, value: null } 을 keepalive: true 로 POST
2. 응답을 (짧은 상한과 함께) 기다린 뒤
3. location.assign(url)
```

`keepalive`만 믿고 기다리지 않는 것보다 **응답을 확인하고 이동하는 편**을 택한다. 응답이 유실되면 script가
deadline(기본 60초)까지 멈추는데, 왕복 몇 ms로 그 위험을 없앨 수 있다. 다만 POST가 매달리면 이동 자체가
막히므로 상한(권장 1500ms)을 두고 초과 시 그냥 이동한다 — 그 경우 runtime은 `rpc_timeout`을 보고 script가
판단한다.

`settleRpc`에 `keepalive?: boolean`를 둔다.

**구현 규칙**

1. **durable journal을 오염시키지 않는다.** 계층 B가 순수 코어를 부르는 이유다. 수용 기준은 §5.1.
2. **`deadlineMs`를 읽는다.** handler 타임아웃은 `min(op 자체 상한, remainingMs)`. 무시하면 이미 만료된 op을
   끝까지 돌리고 버려질 응답을 보낸다.
3. **`page.eval`은 opt-in** (§4.5).
4. handler throw는 결과로 변환한다. 예외가 channel을 죽이면 안 된다.

### 4.2 `packages/axsdk-core/src/rpc-channel.ts` (신규, **최상위**): 구독과 응답

`src/lua/**`는 `axapi`를 한 번도 import 하지 않는다. 채널을 `src/lua/`에 두면 그 첫 사례가 되어 계층이
뒤집힌다. `axapi`를 쓰는 것은 `axcall`·`axchat`·`axhandler`·`axsdk`·`deferred` 뿐이고 전부 최상위다.

```
src/lua/rpc-ops.ts    op 테이블. 순수. axapi·EventBus 모름
src/rpc-channel.ts    EventBus 구독 + settle 전송. axcall.ts 옆
```

`sse.ts`의 `handleMessage`가 이미 `EventBus.emit(payload.type, payload.properties)`를 호출한다. 새 transport는
필요 없고 `axsdk.rpc.request`를 구독하면 된다.

```ts
export interface AXRpcChannelOptions {
  ops: Record<string, AXRpcOpHandler>
  /** 기본값은 axapi의 settleRpc. test 대체점은 이것 하나다. */
  settle?: (rpcId: string, result: AXRpcResult, options?: { keepalive?: boolean })
    => Promise<{ accepted: boolean }>
  isEligible?: () => boolean   // 기본 () => true
  onSettled?: (info: { rpcId: string; op: string; accepted: boolean; durationMs: number }) => void
}

export function start(options: AXRpcChannelOptions): () => void
```

`axcall`은 `start()`/`stop()` 쌍이지만 여기서는 **의도적으로 disposer 반환**을 택한다 — 구독 해지가 등록과
한 곳에 묶여 테스트에서 누수가 나지 않는다.

동작:

1. `Config.apiVersion !== 'v2'`면 **구독하지 않고** no-op disposer를 반환한다. v1에서 `apiPrefix()`는 `''`를
   반환하므로 `rpcPath()`가 `/rpc`가 되어 없는 라우트를 친다.
2. `EventBus.on('axsdk.rpc.request', handler)`로 구독하고, disposer가 해지한다.
3. `isEligible() === false`면 **`{ ok:false, error:"not_eligible" }`를 보낸다.** 침묵하면 안 된다 —
   runtime이 그 문서를 "아직 답하지 않은 수신자"로 세고 op 타임아웃까지 기다린다(§3.5).
4. `rpcId`가 seen에 있으면 무시한다. seen은 **LRU 상한 256** — 세션 수명 동안 무한히 자라면 안 된다.
5. op을 실행하고 결과를 전송한다. `nav.navigate`/`nav.reload`는 `keepalive`로 보내고 이동은 그 다음이다(§4.1.1).
6. `accepted`를 `onSettled`로 알린다. `accepted: false`는 **정상**이며 재시도하지 않는다.
7. 전송이 network 오류면 최대 1회 재시도한다. **안전한 근거**: 첫 POST가 도달했는데 응답만 유실된 경우
   재시도가 같은 `rpcId`에 두 번째 응답을 보내지만, 첫 응답 승자 규칙(§3.3)이 그것을 버린다.
8. **frame 처리를 직렬화하지 않는다.** 핸들러는 즉시 반환하고 op은 띄워 보낸다 — 느린 op이 다음 frame
   수신을 막으면 안 된다.

**durable/outbox/pending에 넣지 않는다.** `axcall.ts`의 pending call 복구, replay marker, outbox 어디에도 RPC를
등록하지 않는다.

### 4.3 문서 적격성 — `isEligible`

`axsdk.rpc.request`에는 대상 문서 필드가 없다. 쓰기 op이 모든 문서에서 실행되는 것을 줄이려면 client가 스스로
판단해야 한다.

**기본값은 `() => true`다.** `document.visibilityState === 'visible'`를 기본으로 삼으면 사용자가 다른 탭을
보는 순간 단일 문서 embed의 RPC가 전부 죽는다. 좁히는 것은 다중 문서를 아는 host(확장)의 몫이다.

**부적격 문서는 침묵하지 않고 거부한다(§3.5).** `declineWhenIneligible` 같은 플래그는 필요 없다 — runtime이
거부를 답이 아닌 것으로 세므로 항상 켜고 쓰면 된다.

확장에서 권장하는 기준(우선순위 순):

1. 문서가 활성 탭이다 (`chrome.tabs.query({ active: true, currentWindow: true })`)
2. 문서가 이 세션의 app domain에 있다
3. `document.visibilityState === 'visible'`

**조용한 오답 위험 — 거부로 해결된다.** 요소가 없는 문서의 빠른 `false`가 요소가 있는 문서의 느린 `true`를
이기는 문제는, 그 문서가 부적격이면 `not_eligible`로 거부하므로 애초에 경쟁에 끼지 않는다. **적격 문서가
둘 이상일 때만** 남고, 그때는 둘 다 같은 페이지를 보고 있을 가능성이 높다.

쓰기 fanout도 같다. `nav.navigate`/`nav.reload`는 적격 문서를 **전부** 이동시키므로, 확장은 쓰기 op에서
활성 탭 하나만 적격으로 판정해야 한다. 거부한 나머지는 이동하지 않고, 모두 거부하면 즉시 `no_client`다.

script 측 `rpc.delivered_to()`는 fanout − 거부를 반환한다. **상한값이다** — 끝내 답하지 않은 수신자는
실행한 것으로 세므로, `2`는 "둘이 실행했다"일 수도 "하나가 실행하고 다른 하나의 거부가 늦었다"일 수도 있다.

승자가 거부를 앞지를 수 있으므로 fanout이 2 이상이면 런타임이 나머지 응답을 기다린다(최대 500ms, 문서가
하나면 대기 없음). 그래도 늦으면 상한으로 남는다.

**`rpc.fanout()`이 그 둘을 가른다** — `{ executed, declined, silent }`. `silent == 0`이면 `executed`가
확정이고, `silent > 0`이면 참값은 `[executed - silent, executed]` 사이다.

client가 지켜야 할 것은 하나다: **부적격이면 침묵하지 말고 즉시 `not_eligible`로 답한다.** 늦거나 침묵하면
그만큼 `silent`가 늘어 스크립트가 판단할 수 없게 된다. 평문 오리진에서 연결이 고갈되면 이 POST가 가장 먼저
밀리므로, 거부는 어떤 작업보다 먼저 보내야 한다.

### 4.4 `packages/axsdk-core/src/axapi.ts` + `config.ts`: module 주입과 invoke

먼저 `config.ts`에 경로 헬퍼를 기존 `sessionsPath()`/`callsPath()`와 같은 형태로 추가한다. RPC 라우트는
**v2 전용**이므로 v1에서는 호출하지 않는다.

```ts
export function luaPath(): string { return `${apiPrefix()}/lua` }
export function rpcPath(): string { return `${apiPrefix()}/rpc` }
```

`axapi.ts`에 모듈 레벨 함수를 추가한다. 세션 헤더는 기존 `callSessionRequestOptions(sessionId)`를 재사용한다
— 서버가 `x-app-user-session-id`로 루트 세션 소유권을 검사하기 때문이다.

```ts
injectLuaModule(input: { name: string; source: string; allow?: string[] }, options?: { sessionId?: string }): Promise<AXLuaModuleInfo>
listLuaModules(options?: { sessionId?: string }): Promise<{ data: AXLuaModuleInfo[] }>
removeLuaModule(name: string, options?: { sessionId?: string }): Promise<{ ok: boolean; removed: boolean }>
invokeLuaModule(name: string, fn: string, body?: { args?: unknown; timeoutMs?: number }, options?: { sessionId?: string }): Promise<
  | { status: 'completed'; value: unknown }
  | { status: 'error'; error: string }
>
settleRpc(rpcId: string, result: AXRpcResult, options?: { sessionId?: string }): Promise<{ accepted: boolean }>
```

`invokeLuaModule`은 script 종료까지 blocking이며, 그 사이 이 문서가 자기 RPC에 응답해야 한다. 따라서:

- `invokeLuaModule`을 **await하는 코드가 SSE 처리를 막으면 교착한다.** channel은 별도 구독으로 동작해야 하며, invoke 호출을 동기 루프나 blocking 대기 안에 두어서는 안 된다.
- 이 제약을 `axsdk-core` test로 고정한다(§5.3).

### 4.5 설정 노출

`types/axsdk.ts`에 **`AXSDKLuaConfigSchema`가 이미 있다**(`enabled`/`allowRemoteScripts`/`scripts`/…), 그리고
`lua: z.union([z.boolean(), AXSDKLuaConfigSchema])`로 물려 있다. 새 최상위 키를 만들지 말고 **그 스키마 안에**
넣는다.

```ts
// AXSDKLuaConfigSchema 안에
rpc: z.union([
  z.boolean(),
  z.object({
    allowPageEval: z.boolean().optional(),                          // 기본 false
    ops: z.record(z.string(), z.custom<AXRpcOpHandler>()).optional(),
  }),
]).optional(),
```

기본 `enabled: true`, `allowPageEval: false`. `lua: true`(boolean) 형태도 유효하므로 **정규화 시 `rpc` 기본값
적용 경로를 타야 한다.**

`allowPageEval` 기본값이 `false`인 이유: `page.eval`은 임의 JS 실행이다. client가 자기 페이지에서 이미 JS를
실행하므로 권한 상승은 아니지만, 명시적 opt-in이 감사에 필요하다.

## 5. TDD 적용 순서

`packages/axsdk-core`의 기존 test convention에 맞춘다.

| # | 작업 | 테스트 |
|---|---|---|
| 1 | `default-capabilities.ts` 순수 함수 10개 export | 기존 스위트 초록 |
| 2 | `rpc-ops.ts` 계층 A·B + 판정 규칙 | `lua/rpc-ops.test.ts` |
| 3 | `rpc-ops.ts` 계층 C (`nav.navigate`/`nav.reload` 선응답) + D | 같은 파일 |
| 4 | `config.ts` 경로 + `axapi.ts` 5함수 | `axapi.test.ts` |
| 5 | `rpc-channel.ts` | `rpc-channel.test.ts` |
| 6 | `axsdk.ts` 기동 배선 + 설정 정규화 | `axsdk.test.ts` |
| 7 | 확장 `isEligible` (활성 탭) | `content/*.test.ts` |

### 5.1 `src/lua/rpc-ops.test.ts`

```
✓ 각 wire op이 대응 순수 함수를 호출하고 인자를 그대로 전달한다
✓ 미등록 op → { ok:false, error:"command_unresolved", detail:op }
✓ handler throw → { ok:false, error:"op_threw", detail:message }
✓ 요소 부재(읽기) → { ok:false, error:"no_element" }   (ok:true 위장 금지)
✓ page.eval이 opt-in 꺼짐 → { ok:false, error:"op_not_permitted" }
✓ remainingMs 소진 → { ok:false, error:"op_deadline" }
✓ RPC op 실행이 durable journal에 항목을 추가하지 않는다
✓ nav.navigate가 응답을 보낸 뒤에 이동한다 (순서 검증)
```

durable 항목은 **혼자서는 약하다.** 브리지가 없으면 journal이 비는 것이 당연해서 무조건 통과한다. 계층 B가
순수 코어를 부르는지는 순수 함수 호출 여부로 직접 검증한다.

### 5.2 `src/rpc-channel.test.ts`

```
✓ axsdk.rpc.request 수신 → op 실행 → POST /axsdk/v2/rpc/:rpcId 전송
✓ accepted:false를 재시도하지 않는다
✓ isEligible false → 전송하지 않는다 (거부 응답도 보내지 않는다)
✓ 같은 rpcId 중복 수신 → 1회만 실행
✓ seen 집합이 상한(256)을 넘지 않는다
✓ 전송 network 실패 → 최대 1회 재시도, 그 후 포기
✓ op 예외가 channel을 죽이지 않는다 (다음 frame 정상 처리)
✓ RPC가 pending call/outbox/replay marker에 등록되지 않는다
✓ apiVersion v1 → 구독하지 않는다
✓ 느린 op이 다음 frame 처리를 막지 않는다
✓ nav.navigate가 keepalive로 전송된다
```

### 5.3 `src/axapi.test.ts`

```
✓ 주입/목록/삭제/invoke가 정의된 endpoint와 body를 사용한다
✓ status:"error"를 throw가 아닌 값으로 반환한다
✓ invoke 대기 중 도착한 axsdk.rpc.request가 처리된다 (교착 없음)
```

### 5.4 `packages/axsdk-extension`

```
✓ 비활성 탭이 isEligible false로 응답을 보내지 않는다
✓ 활성 탭 1개만 쓰기 op을 실행한다
```

### 5.5 폴 간격과 전송 프로토콜

h2 오리진에서는 SSE와 POST가 한 연결에 다중화되므로 오리진당 6 연결 한도가 걸리지 않는다. 20ms 폴링도
문제없다.

**평문 HTTP 오리진은 다르다.** 한도 6이 프로필 전체에서 탭끼리 공유되고 SSE가 탭마다 하나를 영구 점유한다
(가용 POST 연결 = 6 − 탭 수). **그런 배포가 남아 있다** — `axsdk-distributed/terraform/staging-poc`의
`nlb_url = "http://193.122.116.94:80"`. 해당 오리진에서는 폴 간격 기본값을 **≥100ms**로 둔다.

폴 간격은 runtime 측 `opts.interval`(기본 150ms)이므로 client 설정 항목은 아니다. 평문 오리진을 쓰는 app의
script가 그보다 짧게 잡지 않도록 하는 것이 실제 대응이다.

## 6. 검증

`axsdk-sdk-js/packages/axsdk-core`에서 실행한다.

```sh
bun test src/lua/rpc-ops.test.ts src/rpc-channel.test.ts src/axapi.test.ts
bunx tsc --noEmit
```

전 구간 왕복은 `axsdk-agents`의 참조 하네스와 대조한다.

```sh
cd ../axsdk-agents
bun run test:lua-rpc:live        # wire 계약 (19 checks)
bun run test:lua-rpc-flow:live   # Path A: planner -> flow 노드 -> lua 어댑터 (6 checks)
```

이 하네스(`scripts/live-lua-rpc-check.ts`)가 **client 측 참조 구현**이다. SSE 구독, op 실행, 응답 전송, `accepted` 처리, 다중 문서 경쟁, `no_client`를 모두 포함하며 서버 계약이 살아있는 프로세스에서 검증된다. 구현 중 계약이 모호하면 이 파일을 정답으로 본다 — **전문과 항목 대응은 §9**.

수용 기준: 하네스의 checks에 대응하는 SDK 동작이 실제 브라우저에서 재현되고, 여기에 **하네스가 덮지 않는
한 가지**가 추가로 증명된다 — `nav.navigate` 후 `nav.wait_for_navigation` + `dom.wait_for_selector`가 실제
페이지 이동을 가로질러 성공하는 것. 하네스는 가짜 DOM이라 이동이 없다.

## 7. 의도적으로 제외한 범위

- **RPC의 durable 복구.** 문서가 죽으면 그 invocation은 소실된다. outbox·replay·pending 어디에도 넣지 않는다.
  이동은 폴링으로 넘기지만(§2.2), 그것은 복구가 아니라 재시도다 — 이동 중 발급된 개별 op은 잃는다.
- **대상 문서 지정.** broadcast + 첫 응답 승자로 확정했다. `target` field를 추가하지 않는다. 완화는
  `isEligible`과 `rpc.delivered_to()`뿐이다.
- **적격성의 사전 등록.** 지금 런타임은 문서의 적격 여부를 op마다 거부 응답으로 알아낸다. 적격성은 사실
  탭의 속성이고 op 이전에 이미 정해져 있으므로, 문서가 SSE 연결 시(그리고 변할 때) 등록하면 `delivered_to()`
  가 dispatch 시점에 대기 없이 확정된다. **이것이 근본 해결이고 `rpc.fanout()`은 그때까지의 임시방편이다.**
  프로토콜 표면(연결 시 적격성 전달 + 변경 통지 + 백엔드 구독자 레지스트리 + dispatch 필터)이 늘어나므로
  client와 함께 결정한다. 부수 효과로 쓰기 op이 애초에 부적격 문서에 가지 않게 되어 §3.3의 fanout 문제도
  같이 사라진다.
- **성공 우선 판정.** 먼저 온 실패가 나중 성공을 이기고, 폴 대상에서는 빠른 `false`가 느린 `true`를 이긴다
  (§4.3). 바꾸려면 runtime `settleRpcRequest` 한 곳을 고쳐야 하며 SDK 작업이 아니다.
- **script가 만든 coroutine 안에서의 RPC.** runtime이 구조적으로 거부한다.
- **module state의 영속화.** runtime 프로세스 메모리에만 있다. 재시작하면 초기화된다.
- **`src/steps/` 삭제와 `durable-removal.md` 처리.** HEAD(`5a38c41`)에는 있고 이 문서가 대조 가능한
  커밋(`ddaffb7`)에는 없다. 조회할 수 없으므로 판단하지 않는다. 다만 그 결정이 이 문서의 옛 문장(*"RPC는
  탐색을 넘지 못하므로 durable이 그 구멍을 메운다"*)에 기대고 있었다면 **그 전제는 §2에서 철회되었다** —
  client 측이 회신에서 밝힌 대체 근거(`callAXSDKLuaCommand`가 `DurableRunner`를 만들고 `axsdk-sites`의
  도메인별 스크립트가 그 위에 있음)는 배포 모델 문제라 이 문서의 범위 밖이다.
- **사이트 스크립트의 runtime 이전.** 계획된 바 없다. 계획이 생기면 별도 프로그램으로 다룬다.

## 8. 서버 측 현재 상태

client 구현 전 서버 계약은 확정·검증되었다.

| 구간 | 위치 | 테스트 파일 | 수 |
|---|---|---|---|
| coroutine 드라이버 + 시계/sleep + 폴 합성 | `runtime/src/lua-rpc.ts` | `test/lua-rpc.test.ts` | 21 |
| `execute.rpc` 선언·검증 | `runtime/src/adapters.ts` | `test/adapters.test.ts` (`lua rpc *`) | 19 |
| module 상태 저장소 | `runtime/src/lua-module-store.ts` | `test/lua-module-store.test.ts` | 6 |
| Path A 디스패처 배선 | `runtime/src/config-runtime-dispatcher.ts` | `test/config-runtime-dispatcher.test.ts` | 4 |
| RPC 채널 + backend dispatch | `runtime/src/lua-rpc-bridge.ts` | `test/lua-rpc-bridge.test.ts` | 22 |
| Path B 레지스트리 | `runtime/src/lua-module-registry.ts` | `test/lua-module-registry.test.ts` | 12 |
| 세션 배선 | `runtime/src/session.ts`, `pool.ts` | `test/session-lua.test.ts` | 4 |
| runtime 라우트 | `api/src/app.ts` | `api/test/lua-routes.test.ts` | 12 |
| ephemeral 채널 (backend) | `axsdk-backend/src/sse/rpc-channel.ts` | `src/sse/rpc-channel.test.ts` | 7 |
| backend 라우트 | `axsdk-backend/src/routes/internal-rpc.ts`, `routes/axsdk/v2/lua.ts` | `src/routes/internal-rpc.test.ts` | 9 |
| **합계** | | | **116** |
| wire 계약 라이브 | — | `axsdk-agents/scripts/live-lua-rpc-check.ts` | 19 checks |
| Path A 라이브 (실제 turn) | `apps/browser-extension` `rpc_demo` | `axsdk-agents/scripts/live-lua-rpc-flow-check.ts` | 6 checks |

## 9. 참조 구현 전문

`axsdk-agents/scripts/live-lua-rpc-check.ts`. 이 파일은 살아있는 backend·runtime에 붙어 12개 check를 통과하는
상태로 유지된다(`bun run test:lua-rpc:live`). 계약이 모호할 때의 정답은 문장이 아니라 이 코드다.

### 9.1 구현 항목과의 대응

| 하네스 위치 | 하는 일 | 대응 작업 항목 |
|---|---|---|
| `headers()` | `x-api-key`/`x-app-id`/`x-app-user-id` + `x-app-user-session-id` | §4.4 (`callSessionRequestOptions` 재사용) |
| `openClient()` SSE 루프 | `axsdk.rpc.request` 수신 | §4.2 (SDK는 `EventBus.on`으로 대체) |
| `answer()` | op → 값/실패 판정 | §4.1 op 테이블 |
| `POST /axsdk/v2/rpc/:rpcId` + `accepted` 기록 | 응답 전송과 승패 확인 | §4.2 + §4.4 `settleRpc` |
| `inject()` / `invoke()` | module 주입·실행 | §4.4 |
| `loser` client | 두 번째 문서로 경쟁 재현 | §4.3 `isEligible`, §5.4 |

### 9.2 하네스가 의도적으로 단순화한 것

계약을 보이는 데 필요 없는 부분은 생략되어 있다. **그대로 옮기면 프로덕션에서 깨진다.**

| 하네스 | SDK가 해야 하는 것 |
|---|---|
| `buffer.split("\n\n")`로 SSE 파싱 | 기존 `SSEFrameParser` 사용 (CRLF/CR, 잘린 frame, comment line) |
| 가짜 `DOM` 객체 | `default-capabilities.ts`의 실제 구현 재사용 (§4.1) — 단 durable journal 우회 |
| 모든 문서가 항상 응답 | `isEligible`로 부적격 문서는 **무응답** (§4.3) |
| `rpcId` 중복 방어 없음 | 같은 `rpcId` 재수신 시 1회만 실행 (§4.2) |
| frame을 순차 처리 (`await` 직렬) | op 실행이 SSE 수신을 막지 않게 한다 |
| 전송 실패 재시도 없음 | network 실패 시 최대 1회 재시도 (§4.2) |
| `page.eval` 미지원 | opt-in 게이트 (§4.5) |

`answer()`의 `dom.get_text` 처리가 판정 규칙을 그대로 보여준다: 요소가 없으면
`{ ok: false, error: "no_element" }`로 답해 script에서 Lua error가 되게 하고, script는 `pcall`로 잡는다
(`guarded` 함수).

대기는 **wire op이 아니다.** 하네스의 `crossing` script가 `nav.wait_for_navigation`/`dom.wait_for_selector`를
쓰지만 클라이언트가 보는 것은 `dom.exists`와 `dom.get_location_href` 폴링뿐이다. `settleAt`으로 이동 직후
120ms 동안 옛 페이지를 답하게 해 **폴 루프가 실제로 돌게** 만든다 — client가 구현할 것이 없다는 뜻이다.

### 9.3 전문

```ts
/**
 * Live proof of the Lua RPC round trip against running backend + runtime processes.
 *
 * Stands in for the browser SDK: subscribes to the v2 SSE stream, answers `axsdk.rpc.request`
 * frames from a fake DOM, and asserts the invocation observes those answers.
 */
import { loadApiKey } from "./lib/live-scenario"

const backendUrl = process.env.BACKEND_URL ?? "http://localhost:4800"
const appId = "browser-extension"
const key = loadApiKey(appId)

const DOM: Record<string, string> = {
  "h1": "장바구니",
  "#zip": "94102",
}

let href = "https://shop.test/cart"
/** Mimics a navigation: the client answers immediately, the page settles a moment later. */
let settleAt = 0

interface RpcFrame {
  rpcId: string
  op: string
  params: { selector?: string; value?: string; url?: string }
}

function headers(uid: string, sid?: string): Record<string, string> {
  return {
    "x-api-key": key,
    "x-app-id": appId,
    "x-app-user-id": uid,
    "x-app-user-name": "Lua RPC Check",
    "x-forwarded-for": "127.0.0.1",
    origin: "http://localhost:3334",
    "Content-Type": "application/json",
    ...(sid ? { "x-app-user-session-id": sid } : {}),
  }
}

async function createSession(uid: string): Promise<string> {
  const res = await fetch(`${backendUrl}/axsdk/v2/sessions`, { method: "POST", headers: headers(uid), body: "{}" })
  if (!res.ok) throw new Error(`session creation failed: ${res.status} ${await res.text()}`)
  const body = await res.json() as { sessionID?: string }
  if (!body.sessionID) throw new Error("session creation returned no sessionID")
  return body.sessionID
}

interface Client {
  frames: RpcFrame[]
  answered: Array<{ rpcId: string; accepted: boolean }>
  close: () => void
  connected: Promise<void>
}

function openClient(uid: string, sid: string, opts: { answer?: (frame: RpcFrame) => unknown; label?: string } = {}): Client {
  const controller = new AbortController()
  const frames: RpcFrame[] = []
  const answered: Array<{ rpcId: string; accepted: boolean }> = []
  let resolveConnected: () => void = () => {}
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve })

  // A real eligible document does DOM work before answering; an ineligible one refuses immediately.
  // The delay keeps that ordering so a refusal is counted before the winner settles.
  const workMs = opts.answer ? 0 : 15
  const answer = opts.answer ?? ((frame: RpcFrame) => {
    if (frame.op === "dom.get_text") {
      const text = DOM[frame.params.selector ?? ""]
      return text === undefined ? { ok: false, error: "no_element", detail: frame.params.selector } : { ok: true, value: text }
    }
    if (frame.op === "dom.set_value") {
      DOM[frame.params.selector ?? ""] = frame.params.value ?? ""
      return { ok: true, value: null }
    }
    if (frame.op === "dom.exists") return { ok: true, value: Date.now() >= settleAt && DOM[frame.params.selector ?? ""] !== undefined }
    if (frame.op === "dom.get_location_href") return { ok: true, value: Date.now() >= settleAt ? href : "https://shop.test/cart" }
    if (frame.op === "nav.navigate") {
      href = String(frame.params.url ?? "")
      settleAt = Date.now() + 120
      DOM["#pay"] = "ready"
      return { ok: true, value: null }
    }
    return { ok: false, error: "op_unsupported", detail: frame.op }
  })

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
        const parsed = JSON.parse(line.slice(5).trim()) as { payload?: { type?: string; properties?: RpcFrame } }
        const type = parsed.payload?.type
        if (type === "server.connected") resolveConnected()
        if (type !== "axsdk.rpc.request" || !parsed.payload?.properties) continue
        const frame = parsed.payload.properties
        frames.push(frame)
        if (workMs > 0) await new Promise(resolve => setTimeout(resolve, workMs))
        const reply = await fetch(`${backendUrl}/axsdk/v2/rpc/${frame.rpcId}`, {
          method: "POST",
          headers: headers(uid, sid),
          body: JSON.stringify(answer(frame)),
        })
        const replyBody = await reply.json().catch(() => ({})) as { accepted?: boolean }
        answered.push({ rpcId: frame.rpcId, accepted: replyBody.accepted === true })
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) console.error(`[client${opts.label ? ` ${opts.label}` : ""}] ${String(error)}`)
  })

  return { frames, answered, close: () => controller.abort(), connected }
}

async function inject(uid: string, sid: string, module: { name: string; source: string; allow?: string[] }): Promise<Record<string, unknown>> {
  const res = await fetch(`${backendUrl}/axsdk/v2/lua`, { method: "POST", headers: headers(uid, sid), body: JSON.stringify(module) })
  return { httpStatus: res.status, ...(await res.json() as Record<string, unknown>) }
}

async function invoke(uid: string, sid: string, name: string, fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${backendUrl}/axsdk/v2/lua/${name}/${fn}`, {
    method: "POST",
    headers: headers(uid, sid),
    body: JSON.stringify({ args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
  })
  return { httpStatus: res.status, ...(await res.json() as Record<string, unknown>) }
}

const CHECKOUT = `
local visited = 0

local function field(sel, value)
  dom.set_value(sel, value)
  return dom.get_text(sel)
end

function probe(args)
  nav.navigate(args.url)
  visited = visited + 1
  return { title = dom.get_text("h1"), visited = visited }
end

function fill(args)
  return { zip = field("#zip", args.zip), visited = visited }
end

function fanout()
  local title = dom.get_text("h1")
  local f = rpc.fanout()
  return { seen = rpc.delivered_to(), executed = f.executed, declined = f.declined, silent = f.silent, title = title }
end

function missing()
  return { text = dom.get_text("#nope") }
end

function guarded()
  local ok, err = pcall(function() return dom.get_text("#nope") end)
  return { caught = not ok, message = tostring(err) }
end
`

const CROSSING = `
function go(args)
  local from = dom.get_location_href()
  nav.navigate(args.url)
  local moved = nav.wait_for_navigation(from, { timeout = 3000, interval = 20 })
  local ready = dom.wait_for_selector("#pay", { timeout = 3000, interval = 20 })
  return { moved = moved, ready = ready, href = dom.get_location_href() }
end
`

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: unknown = ""): void {
  results.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) })
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${ok || detail === "" ? "" : ` — ${JSON.stringify(detail)}`}`)
}

async function main(): Promise<void> {
  const uid = `lua_rpc_${Date.now()}`
  const sid = await createSession(uid)
  console.log(`session ${sid}`)

  const client = openClient(uid, sid)
  await client.connected

  const injected = await inject(uid, sid, { name: "checkout", source: CHECKOUT })
  check("inject reports exports", Array.isArray(injected.exports) && (injected.exports as string[]).includes("probe"), injected)

  const first = await invoke(uid, sid, "checkout", "probe", { url: "https://shop.test/cart" })
  check("rpc round trip returns dom text", first.status === "completed" && (first.value as Record<string, unknown>)?.title === "장바구니", first)
  check("frames reached the client", client.frames.length === 2, client.frames.map(f => f.op))
  check("client answers were accepted", client.answered.every(entry => entry.accepted), client.answered)

  const second = await invoke(uid, sid, "checkout", "probe", { url: "https://shop.test/cart" })
  check("module state survives across invocations", (second.value as Record<string, unknown>)?.visited === 2, second)

  const filled = await invoke(uid, sid, "checkout", "fill", { zip: "07030" })
  check("write op mutates the client dom", (filled.value as Record<string, unknown>)?.zip === "07030", filled)

  const failed = await invoke(uid, sid, "checkout", "missing")
  check("reported op failure becomes a script error", failed.httpStatus === 200 && failed.status === "error" && String(failed.error ?? "").includes("no_element"), failed)

  const guarded = await invoke(uid, sid, "checkout", "guarded")
  check("script can catch an op failure with pcall", (guarded.value as Record<string, unknown>)?.caught === true, guarded)

  const loser = openClient(uid, sid, { answer: () => ({ ok: true, value: "second document" }), label: "loser" })
  await loser.connected
  const raced = await invoke(uid, sid, "checkout", "probe", { url: "https://shop.test/cart" })
  const racedTitle = (raced.value as Record<string, unknown>)?.title
  check("broadcast fans out to both documents", loser.frames.length > 0, loser.frames.map(f => f.op))
  check("one answer wins the race", racedTitle === "장바구니" || racedTitle === "second document", raced)
  const rejected = [...client.answered, ...loser.answered].filter(entry => !entry.accepted)
  check("the loser is told its answer was not accepted", rejected.length > 0, rejected)
  loser.close()

  const silent = openClient(uid, sid, { answer: () => ({ ok: false, error: "not_eligible" }), label: "silent" })
  await silent.connected
  const counted = await invoke(uid, sid, "checkout", "fanout")
  check("delivered_to counts documents that could act, not refusals",
    (counted.value as Record<string, unknown>)?.seen === 1, counted)

  // The eligible document answers first here, so the refusal arrives after the winner.
  const fast = openClient(uid, sid, { answer: () => ({ ok: true, value: "장바구니" }), label: "fast" })
  await fast.connected
  const raced2 = await invoke(uid, sid, "checkout", "fanout")
  const v2 = raced2.value as Record<string, unknown>
  check("a refusal that lands after the winner is still excluded", v2?.seen === 2, raced2)
  check("fanout separates what is known from what is only bounded",
    v2?.executed === 2 && v2?.declined === 1 && v2?.silent === 0, v2)
  fast.close()
  await new Promise(resolve => setTimeout(resolve, 200))
  const declinedStart = Date.now()
  const declined = await invoke(uid, sid, "checkout", "probe", { url: "https://shop.test/cart" }, 20000)
  check("an ineligible document does not answer for the eligible one",
    (declined.value as Record<string, unknown>)?.title === "장바구니", declined)
  silent.close()
  await new Promise(resolve => setTimeout(resolve, 200))

  const onlySilent = openClient(uid, sid, { answer: () => ({ ok: false, error: "not_eligible" }), label: "only-silent" })
  await onlySilent.connected
  client.close()
  await new Promise(resolve => setTimeout(resolve, 300))
  const allDeclined = await invoke(uid, sid, "checkout", "probe", { url: "https://shop.test/cart" }, 20000)
  check("all recipients declining fails fast as no_client",
    String(allDeclined.error ?? "").includes("no_client") && Date.now() - declinedStart < 15000, allDeclined)
  onlySilent.close()
  await new Promise(resolve => setTimeout(resolve, 200))

  const client2 = openClient(uid, sid)
  await client2.connected
  await inject(uid, sid, { name: "crossing", source: CROSSING })
  const crossed = await invoke(uid, sid, "crossing", "go", { url: "https://shop.test/pay" })
  const crossedValue = crossed.value as Record<string, unknown> | undefined
  check("script crosses a navigation by polling", crossedValue?.moved === true && crossedValue?.ready === true, crossed)
  check("polling observes the settled page", crossedValue?.href === "https://shop.test/pay", crossed)

  client2.close()
  await new Promise(resolve => setTimeout(resolve, 300))
  const orphan = await invoke(uid, sid, "checkout", "probe", { url: "https://shop.test/cart" }, 3000)
  check("no connected document fails fast", String(orphan.error ?? "").includes("no_client"), orphan)

  const failures = results.filter(entry => !entry.ok)
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
  if (failures.length > 0) process.exit(1)
}

await main()
```
