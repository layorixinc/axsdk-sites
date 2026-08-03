# RPC Lua 런타임 요청 12 — 텍스트로만 지정되는 요소, 그리고 op 왕복 비용

Thumbtack 견적 다이얼로그를 durable에서 런타임으로 이식하면서 라이브에서 측정한 두 가지다. 둘 다
"우리 코드로 우회 가능한가"를 먼저 확인했고, 하나는 우회했고 하나는 못 했다.

---

## R23 — `page.eval`이 `op_not_permitted`

**측정.** `GET /axsdk/v2/lua/ops`의 op 목록에 `page.eval`이 있고, `execute.rpc.allow`에 명시적으로
넣었는데도 호출은 이렇게 답한다:

```
rpc page.eval failed: op_not_permitted: page.eval
```

**왜 필요했나.** Thumbtack 프로 페이지의 "Request estimate" 버튼은 **CSS로 지정할 수 없다.** 실측한
태그는 이렇다:

```html
<button class="M3hCMB_hZSmJXO6ZtJzz BSqWnGqzeqKnZ3eMPcVj lq0zu5HwZe3k0FgYQbEB …" type="button">
```

- `id` 없음, `aria-label` 없음, `data-test` 없음, `title` 없음
- 클래스는 전부 빌드 해시 — 배포마다 바뀌고 A/B 변형마다 다르므로 `AGENTS.md` §10이 금지한다
- 부모는 `<div class="">`
- aside 안 버튼 4개 중 **마지막**

`dom` capability는 표준 CSS만 해석하고 텍스트 매칭이 없다. 즉 "보이는 라벨이 X인 버튼"은 이 어휘로
표현할 수 없다. 지금 문서화된 우회법(`query_all(sel, {text=true})`로 읽고 Lua에서 라벨을 확인한 뒤
**검증된 셀렉터**를 클릭)은 셀렉터가 존재한다는 전제에 서 있는데, 여기서는 존재하지 않는다.

**우회한 방법.** 구조 후보 목록을 넓히고, **클릭 전에 후보 자신의 라벨을 읽어 확인**하게 했다:

```lua
Q.CTA_SELECTORS = {
  'aside div[class=""] > button',   -- 실측한 부모 모양
  'aside button:last-of-type',
  'aside button:not(:last-child)',
  … }
```

라벨을 확인하고 클릭하므로 후보를 넓혀도 잘못된 버튼을 누를 일은 없다. 다만 이건 **이 페이지의 현재
구조**에 기댄 것이고, 다음 배포에 또 바뀐다. 그때는 또 서베이가 필요하다.

**요청.** 다음 중 하나.
1. `page.eval`을 앱에 허용한다(요청한 앱이 `allow`에 명시한 경우에만).
2. 텍스트로 지정하는 op을 어휘에 추가한다 — 예: `dom.click_text(selector, text, {exact})`,
   또는 `dom.query_all`이 돌려준 **행 핸들**로 클릭하는 `dom.click_row(handle)`.

2번이 더 좋다고 본다. `page.eval`은 임의 실행이라 권한 면에서 무겁고, 우리가 필요한 것은 "읽은 그 행을
누른다"뿐이다. 지금은 읽기와 쓰기 사이에 셀렉터라는 좁은 다리만 있어서, 다리가 없는 요소는 읽을 수는
있어도 누를 수 없다.

---

## R24 — op 왕복이 약 1초, 그리고 `deadlineMs` 상한이 120000

**측정.** 라이브에서 op 하나가 대략 1초다. 폼 한 스텝을 구동하는 데 왕복이 처음 32회 들었고,
3스텝 폼이 이렇게 죽었다:

```
lua rpc execution deadline exceeded before dom.query_all
```

**우리 쪽에서 줄인 것.** 스텝당 32 → **15회**.
- 연락처 5개 필드를 후보 셀렉터마다 `exists` + `set_value`로 확인하던 것(최대 10회)을, 스텝의 입력을
  **한 번** 읽고 그 행이 들고 있는 속성으로 셀렉터를 만들게 바꿨다(1회). 연락처를 묻지 않는 스텝에서는
  10회가 1회가 된다.
- 위저드 코어가 같은 옵션 목록·컨트롤 집합을 한 패스에 3~4번 요구한다. 스텝 단위로 메모이즈하고 쓰기가
  일어나면 즉시 버린다(스텝마다 ctx를 새로 만들므로 stale이 될 수 없다).
- "300ms 안정화"를 3회 읽기로 쓰던 것을 2회로 상한.

`tools/lua/rpc-quote.test.mjs`가 두 번 실행의 차이로 **한계 비용**을 재고 16회를 넘으면 실패한다.

**남은 문제.** `deadlineMs`는 120000이 천장이다. 그 위를 쓰면 문서 전체가 배포에서 거부된다:

```
adapters.adapters.open_quote.execute.rpc.deadlineMs must be an integer between 1 and 120000
```

스텝당 15초면 6스텝 폼이 한계고, Thumbtack은 질문 수를 언제든 늘린다. 즉 **op 왕복 비용이 곧 기능
한계**다. 요청은 둘 중 하나.
1. 왕복 비용을 줄인다(배치 op: 한 번의 요청에 여러 읽기 — `dom.query_many([sel1, sel2, …])`).
2. `deadlineMs` 상한을 올린다.

1번이 근본이다. 우리가 스텝마다 보내는 15회는 대부분 **같은 순간의 서로 다른 셀렉터 읽기**라서, 한
번에 보낼 수 있으면 15회가 2~3회가 된다.

---

## 3. 우리 쪽 상태

게이트: `test:lua` **310** · `check:flows` **78** · `test:commerce` 24/24 + 17/17 ·
`test:playground` 47 · `build:lua:check` 13파일. 앱 패키지 `browser-extension` revision 38,
`luaModules` 17개.

라이브에서 확인된 것: 검색·후보 브라우징·승인 게이트·다이얼로그 열기·위저드 진입·제출 노드의
`quote_reached_submit` 가드 거부(전송 없음). 남은 것: 다이얼로그 첫 스텝의 `Next`가 눌리는데도 스텝이
넘어가지 않는다(`advance_not_confirmed`). 라디오는 `id`를 갖고 있고 클릭 후 `checked`도 확인되므로,
다음 서베이 대상은 "선택은 됐는데 폼이 진행을 거부하는 이유"다.
