# 작업지시서 — `axsdk-sdk-js` (확장 클라이언트) RPC Lua 대응

| | |
|---|---|
| **발신** | `axsdk-sites` |
| **수신** | `axsdk-sdk-js` (AXSDK 확장 / `axsdk-core`) |
| **배경** | runtime/backend와 RPC Lua 이행 설계를 확정하는 과정에서 **클라이언트 몫으로 남은 항목**이 나왔다 |
| **개정** | 2026-07-28 — runtime이 `bind: session_root`를 기본값으로 채택해 **S1이 크게 줄었다**(§1) |
| **근거** | 모든 판정은 `axsdk-sdk-js` 코드 경로 또는 라이브 확장(포트 9224, 프로필 `AXSDKSitesChromeDevProfile`) 실측이다. 추정은 `[추정]` |
| **관련 문서** | `axsdk-sites`: `RPC_LUA_MIGRATION.md` · `RPC_LUA_RUNTIME_REQUESTS_{1,2,3}.md` / runtime 회신 2건 |
| **측정 시점** | 2026-07-28 |

---

## 0. 요약

RPC 채널 구현은 **대체로 이미 정확하다**(§3). 요청은 네 건이고, 그중 둘이 P0다.

| ID | 항목 | 우선 | 성격 |
|---|---|:---:|---|
| **S1** | 프레임의 `target.bind`를 읽어 **자기가 세션 루트 탭인지 판정** | **P0** | 판정 로직 (식별자 전송 불필요) |
| **S2** | `isEligible`을 **visibility 기반 → 세션 바운드 탭 기반**으로 | **P0** | S1과 같은 판정. 사실상 한 건 |
| **S3** | `dom.query_all`의 `fields` 동작을 **테스트로 고정** | P1 | 회귀 방어 |
| **S4** | defer된 durable 호출이 완료되지 못하는 증상 (원인 미특정) | P1 | 현행 프로덕션 3기능이 죽어 있다 |

S1·S2는 **사실상 한 건**이다 — 둘 다 "이 탭이 이 세션의 작업 대상인가"를 답하는 문제다.

> **2026-07-28 개정**: 초판은 "탭 식별자를 SSE 구독과 RPC 응답에 실어 달라"였다. runtime이
> `bind: session_root`를 **기본값으로 채택**하면서 서버 측 5단계 중 4단계(구독자 `Map<tabId>`,
> `publishRpc` target 필터, 응답자 tabId, 실행별 바인딩 표)가 **전부 불필요**해졌다.
> `session_root`는 클라이언트가 **로컬에서 답할 수 있는 질문**이기 때문이다.
> 남는 클라이언트 의무는 **판정 하나**이고, 식별자를 서버로 보낼 필요가 없다.

---

## 1. S1 · 프레임의 `target.bind`를 읽어 **자기가 세션 루트 탭인지 판정** — P0

### 배경

RPC 요청은 세션에 연결된 **모든 문서로 브로드캐스트**되고 대상을 지정하는 필드가 없다. 읽기는 무해하지만
쓰기(`dom.click`·`set_value`·`submit_form`·`page.eval`·**`nav.navigate`**)는 **적격 문서 전부가 실행**한다.

우리 스크립트의 첫 op은 `dom.get_location_href()`라 **모든 탭이 답할 수 있다.** 사용자의 메일 탭이 먼저
답하면 스크립트가 **그 탭을 쇼핑몰로 이동시킨다.** 읽기 경합은 무해하지만 **바인딩은 이동 권한을 주는
행위**라 성질이 다르다 — runtime도 이 구분을 받아들여 기본값을 바꿨다.

### 확정된 계약 (runtime 3차 회신)

```yaml
rpc:
  target:
    bind: session_root     # 기본값. 세션을 소유한 탭만 실행
    # bind: script         # 첫 응답 탭. 명시적으로만 (계약에만 존재, 구현 유예)
    urlPattern: "..."      # script 모드에서만 의미
```

- 런타임은 프레임에 `target`을 실어 **계속 브로드캐스트**한다. 서버는 탭을 모른다.
- **각 문서가 스스로 판정한다** — 자기 `bindingId`가 이 세션의 소유자인지 보고, 아니면 `not_eligible`.
- `bind: script`는 `concurrency`가 1로 고정된 동안 필요 없어 구현이 유예됐다.

### 근거 — 판정에 필요한 값은 이미 있다

라이브 확장 서비스워커에서 읽은 실제 값이다.

```jsonc
// chrome.storage.session["axsdk:tab-bindings:v2"]
{
  "bindings": {
    "365472117": {
      "tabId": 365472117,
      "bindingId": "c4bc44a5-65f9-44e0-a74f-1ff3c73fcfef",
      "currentAttachmentId": "71ed131f-…",        // 문서 단위, 이동하면 바뀐다
      "kind": "root",                              // ← 이 탭이 루트다
      "sessionOwnerBindingId": "c4bc44a5-…"        // ← 세션 소유자
    }
  },
  "owners": { "c4bc44a5-…": { "sessionId": "ses_fa6b4d966001T9kitD2vtnj65v" } }
}
```

**`kind: "root"` 와 `sessionOwnerBindingId` 가 곧 답이다.** 새 식별자를 만들 필요도, 서버로 보낼 필요도 없다.

### 요청

1. RPC 프레임의 `target.bind`(runtime이 추가할 필드)를 읽는다. 없으면 기존 동작(전원 적격).
2. `bind: "session_root"`이면 **이 문서가 세션 소유 탭에 속하는지**로 적격을 판정한다.
3. 부적격이면 지금처럼 **`not_eligible`로 답한다**(침묵 금지). 이 부분은 이미 정확하다.
4. `bind: "script"`는 아직 오지 않는다 — 지금은 무시하거나 `session_root`와 동일 취급해도 된다.

### 수용 기준

- 탭 3개(루트 = 작업 탭, 그 외 2개)에서 쓰기 op이 **루트 탭에서만** 실행된다.
- 루트 탭이 다른 origin으로 이동해도 계속 그 탭이 적격이다(문서가 바뀌어도 탭은 같다).
- 루트 탭이 닫히면 다음 op은 즉시 `no_client`이고, 무관한 탭이 대신 실행하지 않는다.

### 미제공 시

다중 탭에서 **쓰기 op이 사용자의 다른 탭에서도 실행**되고 `nav.navigate`가 그 탭들을 전부 이동시킨다.
우리는 그 상태로 장바구니 담기 기능을 출시할 수 없다.
## 2. S2 · `isEligible`을 visibility가 아니라 **세션 바운드 탭**으로 — **P0**

### 결함

```ts
// packages/axsdk-extension/src/content/build-axsdk-config.ts:26
const rpc = { isEligible: () => document.visibilityState === 'visible' };
```

**이 판정은 장시간 스크립트에서 깨진다.**

| 상황 | 지금 벌어지는 일 |
|---|---|
| 사용자가 실행 중 **다른 탭으로 전환** | 바운드 탭이 `hidden` → `not_eligible` → **전원 거부 → 즉시 `no_client`** → 스크립트 사망 |
| 창을 **나란히 두 개** 열어 둠 | 두 창의 활성 탭이 모두 `visible` → **쓰기 op이 양쪽에서 실행** |
| 사용자가 창을 **최소화** | 전부 `hidden` → 같은 사망 |

우리 다중 스토어 비교는 **한 턴이 50~113초**(실측)이고 10개 사이트를 순차로 돈다. 그 사이 사용자가
탭을 한 번도 전환하지 않는다는 가정은 성립하지 않는다. 견적 플로우도 마찬가지다.

**이것이 실수가 아니라 의도적 절충이라는 것을 안다.** 코드의 주석이 그렇게 말한다.

> Several tabs can share one session here, and an RPC request names no target: every eligible
> document runs a write. `visibilityState` is the one signal a content script has **without a
> worker round trip**, and a background tab is always `hidden`. Declining is safe now that the
> runtime counts declines without settling on them.

절충의 두 전제에 동의한다 — 쓰기가 모든 문서에서 실행된다는 것, content script가 워커 왕복 없이 가진
신호가 visibility뿐이라는 것. **문제는 세 번째 전제다: "background tab is always hidden"이 여기서는
"작업 대상이 아니다"를 뜻하지 않는다.** 우리 스크립트가 모는 탭은 작업 중에 얼마든지 배경으로 간다.

visibility는 "사용자가 지금 보고 있는가"를 답한다. 필요한 답은 **"이 탭이 이 세션의 작업 대상인가"** 다.
그리고 그 답은 확장이 이미 갖고 있다 — 다만 §7-2처럼 **워커 왕복 없이는 못 읽는다.** 그 왕복을 피하려던
것이 원래 선택이었으므로, 이 요청은 사실상 **"왕복을 감수하거나, 왕복 없이 읽을 수 있도록 바인딩 상태를
content script에 미리 밀어 두자"** 는 제안이다.

### 요청

판정 기준을 **세션 바운드 탭**으로 바꾼다 — **S1과 같은 판정이다.** 확장은 이미 답을 갖고 있다:
§1의 바인딩 맵에 `kind: "root"`, `sessionOwnerBindingId`, `owners[bindingId].sessionId`가 있다.

```ts
// 의도
const rpc = { isEligible: () => isSessionBoundTab() };   // 이 탭이 이 세션의 대상인가
```

- **기본값은 "세션이 소유한 탭"** 이다. visibility는 판정에서 뺀다.
- 여러 탭이 한 세션에 바인딩된 경우에만 부가 기준이 필요하다. 그때도 visibility가 아니라
  runtime이 지정한 대상(S1의 식별자)과의 일치로 판정하는 편이 맞다.
- 세션에 바인딩되지 않은 탭은 **계속 `not_eligible`로 답해야 한다**(침묵 금지). 현재 구현이 이미 그렇다.

### 수용 기준

- 세션 바운드 탭에서 시작한 스크립트가 **사용자가 다른 탭으로 전환해도 계속 실행**된다.
- 창을 나란히 두 개 열어도 쓰기 op은 **한 탭에서만** 실행된다.
- 바인딩되지 않은 탭은 즉시 `not_eligible`로 답한다(지연·침묵 없음).

### 미제공 시

RPC 이행 후 **모든 장시간 작업이 사용자의 탭 전환에 죽는다.** 지금 durable 경로에서는 이 문제가 없어
(브라우저 명령 실행에 visibility 조건이 없다) 이행이 기능 후퇴가 된다.

---

## 3. 이미 정확한 것 — **다시 만들지 말 것**

읽어 본 결과 아래는 이미 맞게 되어 있다. 재작업 대상이 아니다.

| 항목 | 위치 | 확인 |
|---|---|---|
| **거부는 답이다** — 부적격 문서가 `not_eligible`을 POST | `rpc-channel.ts:149-156` | 침묵 금지 주석까지 정확하다 |
| **파괴적 op은 답을 먼저 보낸다** | `rpc-channel.ts:110-125` | `keepalive` + 상한 경합 후 effect 실행. 이동/제출로 응답이 잘리는 문제를 정확히 다룬다 |
| **effect 지연 메커니즘** | `lua/rpc-ops.ts` `deferEffect`/`effectToken` | 클릭·제출·이동이 전부 이 경로 |
| **중복 프레임 가드** | `rpc-channel.ts:70-77` (`seen`, `SEEN_CAP`) | |
| **전송 1회 재시도** | `rpc-channel.ts:84-96` | 중복 응답이 무해하다는 판단 근거도 맞다 |
| **v1에서 미구독** | `rpc-channel.ts:65` | v2 전용 라우트라 정확 |
| **op 테이블이 순수 코어를 직접 호출** | `lua/rpc-ops.ts` | durable 래퍼를 우회한 것이 맞다 |

특히 `handle()`의 **answer-first** 처리는 우리 시나리오(이동·폼 제출)의 핵심인데 이미 정확하다.

---

## 4. S3 · `dom.query_all`의 `fields` 동작을 테스트로 고정 — P1

### 배경

runtime이 `GET /axsdk/v2/lua/ops`의 `types["query_all.fields"]`로 이 형식을 **정본 계약으로 공표**하기로 했다.
지금까지는 계약이 아니라 **우연히 맞는 상태**였다 — runtime은 `fields`를 그대로 전달만 하고 해석은 전적으로
클라이언트(`queryLuaElements`) 몫인데, 그 형태를 규정하는 문서가 없었다.

우리 10개 사이트 리더가 전부 이 형식에 걸려 있다.

### 고정할 계약

| 규칙 | 의미 |
|---|---|
| `true` | 행 루트의 `textContent` (공백 정규화) |
| `{ selector }` | 행 **내부** 첫 매치의 `textContent` |
| `{ attr }` | 행 루트의 해당 속성 |
| `{ selector, attr }` | 행 내부 첫 매치의 해당 속성 |
| **매치 없음** | **에러가 아니라 키 없음** |
| `limit` | 호출자가 지정. 초과분은 자른다 |

**마지막 줄이 핵심이다.** 우리 리더는 필드별 폴백 체인(`data-test` → 시맨틱 → 구조)을 쓰고 부분 결과를
허용한다. 한 필드가 없다고 행을 버리면 사이트 개편 때마다 결과가 0이 되고, 상위 노드는 그것을
**"매물이 없다"** 로 읽는다 — 조용한 실패다.

### 요청

위 6줄을 `queryLuaElements`에 대한 **단위 테스트로 고정**한다. 특히 "매치 없으면 키 없음" 케이스.

### 수용 기준

네 형태 각각 + 매치 없음 + `limit` 초과를 덮는 테스트가 있고, 동작을 바꾸면 실패한다.

---

## 5. S4 · defer된 durable 호출이 완료되지 못한다 — P1 (현행 프로덕션 결함, 원인 미특정)

### 증상

`net`/`nav`를 기다리며 defer된 호출이 **완료되지 못하고 무한 재실행**된다. 라이브 타임라인(포트 9224,
견적 플로우의 `AX_resolve_zip`):

```
03:05:01.469  received
03:05:01.515  execution:start
03:05:01.519  deferred                      ← net.fetch에서 중단
03:05:01.551  received → skip:deferred-owned  (가드 동작: 레코드 살아 있음)
03:05:20.258  received → claim:acquired → execution:start → deferred   ← 가드 실패, 처음부터 재실행
03:05:55.586  local:start → local:deferred
              → 플로우: tool_execute timeout
```

같은 명령을 하네스로 직접 부르면 **0.5초에 정상 반환**한다(`ax run AX_resolve_zip '{"address":"San
Francisco, CA"}'` → `94102`). `AX_open_site`도 같은 형태다 — defer +6ms, 첫 완료 **+63초**.

### 코드 상태 — 내 초기 가설은 무효다

처음에는 `handleTimeout`이 고정 10초(`DEFAULT_TIMEOUT`) 후 레코드를 지워 재전달 가드(`axcall.ts:129`
`hasByCallId`)가 뚫린다고 봤다. **그 코드는 이미 존재하지 않는다.** 현재 `deferred.ts`는

- 고정 `DEFAULT_TIMEOUT` 대신 **`call.budget.idleTimeoutMs` / `budget.deadlineAt`** 기반이고,
- 만료 시 레코드만 지우지 않고 **`deferred_expired` 결과를 실제로 전달한다**
  (`{ ok: false, error: "deferred_expired", command, timeoutMs }`).

둘 다 내가 지목했던 문제를 정확히 겨냥한 변경으로 보인다. 그리고 **우리가 측정한 dist에 그 코드가
이미 들어 있다** — `packages/axsdk-extension/dist/content.js`에서 `deferred_expired`와
`idleTimeoutMs` 문자열을 각각 확인했다.

**즉 재작성이 반영된 빌드에서도 위 증상이 재현됐다.** 그래서 원인을 우리가 특정하지 못한다 —
`hasByCallId`가 왜 재전달 시점에 거짓이었는지가 남는 질문이고, 그건 그쪽 코드다.

**배제한 것**(둘 다 실측):
- `chrome.storage.session` 쿼터 — 2.5 KB / 10 MB, defer 키 0개.
- `chrome.storage.local` 압박 — 8.7 MB(83%) → 5.6 MB(53%)로 정리 후에도 동일 실패.
### 지금 죽어 있는 기능

`checkout` 플로우 · `bluemoonsoft` 플로우 · 견적 플로우의 ZIP 해석 단계. 셋 다 사용자에게
`"요청을 처리하는 중 문제가 발생했습니다"` 또는 무의미한 실패로 나간다.

### 요청

먼저 **재현 여부를 판정해 달라.** 우리 측정은 2026-07-28, 프로필 `AXSDKSitesChromeDevProfile`,
견적 플로우의 `AX_resolve_zip`이다. 재현되면 셋 중 하나를 판단해 달라.

| | 방향 |
|---|---|
| **A** | 고친다 — 재전달 시 **재실행 금지**(이어받기 또는 즉시 실패). `hasByCallId`가 왜 거짓이 되는지가 출발점 |
| **B** | 이미 고쳐졌고 우리 관측이 낡았다 — 그렇다면 **어느 빌드부터인지** 알려 달라. 우리가 그 dist로 재측정한다 |
| **C** | 고치지 않는다 — RPC 이행으로 durable 경로가 사라지므로. 대신 **그때까지 해당 플로우는 죽은 채로 둔다**는 합의 |

우리는 어느 쪽이든 따른다. **다만 결정이 필요하다** — 지금은 "고장 났는데 아무도 고치기로 하지 않은" 상태다.
RPC 이행은 Phase 5까지 수 주가 걸리고, runtime은 `kind: remote`를 계속 지원한다고 확인했다.

### 참고 — 우리가 이미 우회한 것

같은 조사에서 나온 **다른** 결함(라우터 `entry`가 remote 호출이면 결과가 유실되는 문제)은 우리 저장소에서
우회했다(진입 노드를 in-engine으로, 커밋 `b8e5e8b`). 그건 runtime 몫이라 별도로 보고했다.
**S4는 우회 수단이 없다.**

---

## 6. 이 요청에 포함되지 않는 것

혼선을 막기 위해 명시한다. 아래는 **runtime/backend 몫**이고 SDK 작업이 아니다.

| 항목 | 소유 |
|---|---|
| `net.fetch` 호스트 프리미티브 (환율·지오코딩) | runtime |
| Lua 모듈 레지스트리 / `execute.modules` | runtime |
| 문서 크기 상한·gzip 수신 | backend |
| RPC op 단위 관측성(`rpc_call` 로그) | runtime |
| `GET /axsdk/v2/lua/ops`의 `version`·`types` | runtime |
| 스티키 바인딩의 **서버 측**(구독자 Map, target 필터, 바인딩 표) | runtime |

---

## 7. 회신 필요

| # | 질문 | 막는 것 |
|---|---|---|
| 1 | **S1** `target.bind` 판정을 언제부터 지원할 수 있는가 (runtime이 프레임 필드를 먼저 낸다) | Phase 4 출시 |
| 2 | **S2** 세션 바운드 판정을 content script에서 동기로 할 수 있는가 (바인딩 맵이 `storage.session`에 있고 content script는 접근 불가 — 워커 왕복이 필요하면 `isEligible`이 비동기여야 한다) | `isEligible` 시그니처 변경 여부 |
| 3 | **S4** 재현되는가. A/B/C 중 무엇인가 | 프로덕션 3기능의 복구 시점 |

**2번은 실제 제약이다.** content script에서 `chrome.storage.session` 접근이 거부되는 것을 확인했다
(`Access to storage is not allowed from this context`). 세션 바인딩 판정을 워커에 물어야 한다면
`isEligible: () => boolean`으로는 부족하고, 프레임 수신 시점에 이미 알고 있도록 **바인딩 상태를 content
script에 미리 밀어 두는 방식**이 필요하다.

## 8. 우리가 하는 일

- S1/S2가 들어오면 다중 탭 시나리오(탭 3개, 실행 중 탭 전환, 창 2개)를 라이브로 검증해 결과를 보고한다.
- runtime 측 계약(`target.bind` 프레임 필드)은 이미 확정됐다 — `RPC_LUA_RUNTIME_REQUESTS_4.md` 참조.
  **서버는 계속 브로드캐스트하고 판정은 전적으로 클라이언트 몫**이라는 것이 합의된 모델이다.
- S3 계약은 우리 10개 사이트 리더가 쓰는 형태 그대로다. 변경이 필요하면 우리가 맞춘다.
- **S4**: B(이미 수정됨)로 판정되면 지정한 dist로 즉시 재측정해 결과를 보고한다. C(고치지 않음)로
  결정되면 해당 플로우를 **사용자에게 정직하게 실패**시키도록 우리 쪽 문구를 바꾼다 — 지금처럼 일반
  오류로 나가지 않게.
- 우리 측정은 언제든 재현 가능하다. 필요하면 트레이스 수집 절차(`chrome.storage.local`의
  `axsdk:binding:*:debug-events`에서 `scope:"call"` 이벤트)를 그대로 넘기겠다.
