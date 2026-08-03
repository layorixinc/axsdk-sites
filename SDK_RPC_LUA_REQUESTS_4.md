# SDK 요청 (4차) — 플랫폼이 넣은 두 op의 클라이언트 구현

날짜: 2026-07-27 · 대상: `../axsdk-sdk-js` (코어/확장) · 작성: axsdk-sites
근거: Thumbtack 견적 폼 라이브 실측(앱 `browser-extension` revision 43, `fromRemote: 0`). 수치는 라이브.

백엔드/런타임은 12차 회신으로 두 op을 넣었고, **클라이언트가 구현해야 한다고 명시했다**
(그쪽 §3: "두 op 모두 SDK가 구현해야 한다"). 우리 쪽은 **폴백과 함께 이미 채택**해 뒀다
(`_common/rpc/65_rpc_quote.lua`) — SDK가 켜는 순간 별도 변경 없이 그 경로를 탄다.

지금 상태를 한 줄로: **Thumbtack 견적 폼은 실제로 전진하는데(라이브 5스텝), 왕복 예산이 모자라 완주하지
못한다.** 그 예산을 푸는 것이 아래 S8이다.

---

## S8 — `dom.read_many` (P0, 기능 차단)

### 왜 P0인가 — 측정

Thumbtack 견적 다이얼로그를 런타임에서 구동한 결과:

```
quote_steps: 5        advance_reason: "advanced"
quote_error: quote_budget_spent
현재 스텝: options[Bathroom … Garage … Closet](체크박스 9개) buttons[Next disabled=false; Back]
```

폼은 **정상 전진한다.** 멈춘 이유는 고장이 아니라 왕복이다.

| | |
|---|---|
| 스텝당 왕복 | **약 15회** (연락처 채우기 1회 통합 + 스텝 단위 메모이즈 후. 그 전엔 32회) |
| op당 실측 | **약 1초** (백엔드 로그 평균 879ms. 그쪽 §2는 이 1초가 전송이 아니라 **클라이언트가 프레임을 알아채고 답하는 시간**이라고 확인했다) |
| `deadlineMs` 상한 | **120000** — 플랫폼 하드 상한. 넘기면 문서 전체가 배포에서 거부된다 |

15회 × 1초 × 스텝 = **6스텝 남짓이 기능 한계**다. 견적 폼은 그보다 길다.

우리가 보내는 15회는 대부분 **같은 순간의 서로 다른 셀렉터 읽기**다 — 옵션 목록, 자유 입력 컨트롤,
버튼 집합. 한 번에 보낼 수 있으면 **2~3회**가 된다. 그게 이 op의 전부다.

### 구현

`packages/axsdk-core/src/lua/rpc-ops.ts`의 `createRpcOpTable`에 항목 하나. 백엔드가 지침을 줬다 —
`requests.map(r => handlers[r.op](r.params))`, **이미 있는 핸들러 표를 순서대로**.

```lua
local answers = dom.read_many({
  { op = "dom.query_all", params = { selector = …, fields = …, limit = 160 } },
  { op = "dom.query_all", params = { selector = …, fields = …, limit = 160 } },
  { op = "dom.exists",    params = { selector = … } },
})
-- answers[i] = { value = … } | { error = "…" }
```

계약(백엔드 §2, 우리가 스텁으로 미러링한 것 — `tools/lua/rpc-stub.mjs`, `tools/rpc-allow.mjs`의
`BATCHABLE`):

- 결과는 **요청 순서 그대로**, 각 항목은 그 op의 결과 형태.
- **`maxCalls`를 1회만 소모한다.** 그게 목적이다.
- **읽기만 담긴다.** `dom.click`·`dom.set_value`·`nav.navigate`·`dom.submit_form`·`page.eval`은 거부.
  한 왕복에 부수효과를 숨기면 순서와 원자성을 말할 수 없다.
- **안쪽 op도 `allow`를 지킨다.** 배치가 최소권한을 우회하는 문이 되면 안 된다.
- **클라이언트가 검증할 것은 없다** — 런타임이 보내기 전에 읽기 전용과 `allow`를 모두 검사한다.
  모르는 op이 오면 **그 항목만** 실패로 답하고 나머지는 계속 처리하라(배치 하나가 통째로 죽는 것보다 낫다).

우리 쪽은 `nil`을 "지원 안 함"으로 읽고 하나씩 읽는 경로로 떨어진다. 즉 **부분 구현이나 지연 배포가
우리를 깨뜨리지 않는다.**

---

## S9 — `dom.click_text` (P1, 유지보수 비용)

### 왜 필요한가 — 실측한 태그

Thumbtack 프로 페이지의 "Request estimate" 버튼:

```html
<button class="M3hCMB_hZSmJXO6ZtJzz BSqWnGqzeqKnZ3eMPcVj lq0zu5HwZe3k0FgYQbEB …" type="button">
```

- `id` 없음 · `aria-label` 없음 · `data-test` 없음 · `title` 없음
- 클래스는 전부 **빌드 해시** — 배포마다 바뀌고 A/B 변형마다 다르다(`AGENTS.md` §10이 금지)
- 부모는 `<div class="">`, aside 안 버튼 4개 중 마지막

`dom`은 표준 CSS만 해석하고 텍스트 매칭이 없다. 즉 **"보이는 라벨이 X인 버튼"은 이 어휘로 표현할 수
없다.** 지금 우리가 하는 우회는 구조 후보 목록을 넓히고 **클릭 전에 후보 자신의 라벨을 읽어 확인**하는
것인데, 이건 이 페이지의 **현재 구조**에 기댄 것이고 다음 배포에 또 서베이가 필요하다.

라이브에서 실제로 겪은 비용: 후보의 첫 매치만 읽어서 평점 배지를 눌러 놓고 "CTA 없음"을 보고했다.
"Request estimate"는 같은 목록 안에 있었다.

### 구현

```lua
dom.click_text("aside button", "Request estimate", { exact = true })
```

- 셀렉터로 후보를 좁히고, **정규화한 `textContent`**로 그 안에서 고른 뒤 클릭.
  정규화는 trim + lowercase + 연속 공백 1칸(우리 스텁이 그렇게 가정하고 있다).
- `exact`를 빼면 부분 일치. 못 찾으면 `no_element`.
- 클라이언트가 비교하므로 **스크립트가 라벨을 다시 확인할 필요가 없다** — 우리 후보 래더와 라벨 재확인이
  통째로 사라진다.

부수 효과: `page.eval` 요청은 **철회한다.** 그 거부(`op_not_permitted`)가 클라이언트 opt-in 때문이라는
것을 백엔드가 확인해 줬고, 우리에게 필요한 건 임의 실행이 아니라 "읽은 그 요소를 누른다"뿐이다.
해당 경로는 코드에서 **삭제했다**.

---

## S10 — RPC 프레임을 폴링이 아니라 푸시로 처리하는지 확인 (P0, S8보다 근본일 수 있음)

백엔드가 자기 로그를 열어 보고 **스스로 지목한 것**이다. SSE 발행 경로에 고정 지연은 없고(하트비트 30s가
유일한 타이머), op당 1초는 **클라이언트가 프레임을 알아채고 답하기까지의 시간**이다:

| 하네스 | op당 | 클라이언트 동작 |
|---|---:|---|
| 백엔드 배치 실증 | **~37ms** | SSE 프레임을 받자마자 즉답 |
| 우리 플로우 경로 | **620~880ms** | 답하기 전에 무언가를 더 한다 |

**20배 이상 차이다.** 확인 요청: 확장이 RPC 프레임을 **푸시로 즉시 처리하는가, 큐를 폴링하는가.** 폴링이면
그 간격이 그대로 op 비용이고, **배치보다 큰 승리**다(S8이 15→3회로 줄이는 것과, 왕복 자체가 1초→40ms가
되는 것은 곱셈이다).

한 가지 후보를 함께 적어 둔다: 우리 플로우 경로의 op은 durable 시절과 달리 전부 런타임 RPC인데,
`durableCapability` 래핑이 걸린 경로와 섞여 있으면 프레임 처리 전에 DOM 시뮬레이션/폴링이 끼어들 수 있다
(백엔드 표현: "답하기 전에 DOM 시뮬레이션·폴링을 한다"). 그쪽이 원인인지 우리가 확인할 방법이 없어서
남긴다.

---

## S11 — `dom.submit_form`이 durable 밖에서도 필요하다 (확인 요청, P2)

우리가 이번에 찾은 것: **합성 클릭을 SPA가 무시한다.** Thumbtack의 `Next`는
`<form data-test="request-flow-step-form">` 안의 `type=submit`이고, 클릭이 확인돼도 스텝이 넘어가지
않았다. `findLuaForm`의 주석이 그대로 정답이었다 — `requestSubmit()`이 폼의 실제 핸들러를 실행한다.
클릭이 확인되지 않으면 폼을 제출하도록 바꾼 뒤 **폼이 전진한다**(라이브 5스텝).

요청은 기능 추가가 아니라 확인이다. `rpc-ops.ts`에서 `dom.click`(203행)과
`dom.submit_form`(231행)이 **둘 다 `deferEffect`로 감싸여 있다** — 효과가 답을 보낸 뒤에 적용된다는
뜻으로 읽힌다("a GET/POST submit cannot cut the answer on its way out").

그런데 우리는 **그 직후에 페이지 상태를 읽어 판정한다**: 옵션을 클릭하고 `checked`를 다시 읽어 선택을
확인하고, 폼을 제출하고 스텝 텍스트가 바뀌었는지로 전진을 판정한다. 효과가 나중에 적용되면 그 읽기는
이른 것이 된다.

지금은 쓰기 뒤에 왕복 2회를 두고 읽으며, 라이브에서는 동작한다(선택 확인·5스텝 전진 모두). 하지만
**왜 2회면 충분한지 근거가 없다.** 알려 달라: 지연된 효과는 **다음 op이 도착하기 전에 반드시 적용되는가?**
보장된다면 우리는 그 왕복 2회를 지울 수 있고(스텝당 비용이 또 줄어든다), 보장되지 않는다면 확인 읽기를
재시도 루프로 바꿔야 한다. 지금은 둘 중 어느 쪽인지 모르고 **동작하는 쪽에 기대고 있다.**

---

## 참고 — 우리 쪽에서 정정한 주장 하나

12차 회신에 우리가 "미구현 op은 빠르게 실패하지 않고 `opTimeoutMs`를 통째로 태운다"고 적었는데
**사실이 아니었다.** `executeRpcOp`는 핸들러가 없으면 즉시 `command_unresolved`로 답한다
(`op_not_permitted`는 opt-in 없는 `page.eval` 전용). 실제 낭비는 평범한 왕복이었고, 원인은 **우리 감지
로직이 `command_unresolved`를 몰라 스텝마다 다시 시도한 것**이다. 고쳤고, 스텁도 클라이언트가 실제로
답하는 코드를 그대로 따라가도록 바꿨다(`unresolvedOps`).

`SDK_RPC_LUA_REQUESTS_3.md`의 **S5(`clientLuaModules`)는 여전히 열려 있다.** 백엔드는 받는데 등록되는
것이 관측되지 않아 그쪽에서 검증 방법을 요청해 둔 상태다.

---

## 우리 쪽 상태

게이트: `test:lua` **318** · `check:flows` **79** · `test:playground` 47 ·
`test:commerce` 24/24 + 17/17 · `build:lua:check` 13파일.

라이브 확인: 검색(후보 10건) · 후보 브라우징 · 승인 게이트 · 다이얼로그 열기 · **위저드 5스텝 전진** ·
제출 노드가 `quote_reached_submit` 가드로 거부(**전송 없음**). `kind: remote` 21개.

두 op은 폴백과 함께 이미 배선돼 있다. **S8이 들어오면 그날 바로 스텝당 15회가 2~3회가 된다.**
