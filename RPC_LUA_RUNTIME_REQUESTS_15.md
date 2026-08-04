# RPC Lua 런타임 요청 15 — `action_contract`의 `tool.args.<스칼라>`가 nil로 도착합니다

날짜: 2026-07-27 · 대상: agentv3 runtime · 작성: axsdk-sites
근거: 앱 `browser-extension` revision 98, `fromRemote: 0`. 라이브 실측 + 도구 내부 프로브.

한 건입니다. **막힌 곳이 하나이고 재현이 확정적입니다.**

멀티스토어 discovery가 한 가게에 같은 질문을 반복하다 `subflow node budget exhausted`로 끝납니다.
추적해 보니 재시도 루프가 구조적으로 전진할 수 없습니다 — 루프가 나르는 두 스칼라가 도구에 **nil**로
도착하기 때문입니다.

---

## 1. 증상

```
shopping_collect_store_page | {"next":"retry_query","query":"Logitech wireless mouse","tried_queries":"로지텍 무선 마우스"}
   ... 여섯 번, 값이 한 번도 변하지 않음 ...
shopping_discover_products  | error { stage: "budget", code: "node_budget", message: "subflow node budget exhausted" }
shopping_build_product_options | { next: "empty", product_options: {} }
```

도구는 매번 "다음엔 이 문구로 물어보라"고 답하는데, 다음 패스가 그 문구를 받지 못합니다.

## 2. 상태는 정상입니다 — 도구 인자만 비어 있습니다

`step-start`의 `localState` 스냅샷(§7.6이 안내하는 그 표면)은 값이 **있다고** 말합니다:

```
node=collect                 query=null                      tried=null
node=search_other_wording    query="Logitech wireless mouse"  tried="로지텍 무선 마우스"
node=normalize               query="Logitech wireless mouse"  tried="로지텍 무선 마우스"
node=collect                 query="Logitech wireless mouse"  tried="로지텍 무선 마우스"
```

`statePatch` 병합은 문서대로 동작합니다. 그런데 그 `collect` 노드 **안에서** 찍어 보면:

```
{"stop":"probe q=nil tried=nil", ...}
```

도구 코드에서 `tostring(args.query)` → `nil`, `tostring(args.tried_queries)` → `nil`.
(임시 프로브로 세 번 연속 확인 후 제거했습니다.)

## 3. 노드 선언

```yaml
collect:
  kind: action_contract
  id: shopping_collect_store_page
  inputSelector: [item, context, store_result, collected, page, query, tried_queries]

shopping_collect_store_page:
  execute: { kind: runtime, implementation: lua, ... }
  input:
    result: tool.args.store_result
    site:   tool.args.item.site       # ← 도착함
    page:   tool.args.page            # ← 도착함
    context: tool.args.context        # ← 도착함
    query:  tool.args.query           # ← nil
    tried_queries: tool.args.tried_queries   # ← nil
```

**같은 `input:` 블록 안에서 갈립니다.** `item` / `context` / `store_result` / `page`는 도착하고,
`query` / `tried_queries`는 nil입니다. 둘 다 `inputSelector`에 있고, 둘 다 직전 노드의 `output:`이
상태에 썼으며, `localState`가 그 값을 보여 줍니다.

관찰된 차이는 하나뿐입니다 — **도착하는 것은 플로우 진입 시점에 이미 존재했고(진입 상태 또는
`state:` 시드), nil인 것은 루프 안에서 처음 값을 얻습니다.** 진입 시 둘 다 `null`로 시드돼 있습니다.

`_common/flows.yaml`은 `defaults.mapping: legacy`입니다(오버레이가 보간 없이 점 경로를 읽어야 해서).

## 4. 묻는 것

1. `action_contract`에서 `tool.args.<필드>`가 **루프 중 갱신된** 플로우 상태를 읽는 것이 맞습니까,
   아니면 노드 진입 시점의 투영만 읽습니까?
2. `legacy` 매핑에서 스칼라와 객체가 다르게 해석됩니까? 우리 관측은 객체(`item`, `context`)는 오고
   스칼라(`query`, `tried_queries`)는 안 오는 것입니다.
3. 서브플로우 루프에서 누산기를 나르는 **권장 방식**이 따로 있습니까? 있다면 그대로 따르겠습니다.

## 5. 우리 쪽에서 이미 한 것

- 누산기가 **무엇을 실제로 검색했는지** 기록하도록 고쳤습니다. `args.query`가 없으면
  `result.query` → 중첩된 `store_result.store_result.query` → `context.query` 순으로 찾습니다.
  이 폴백 덕분에 `tried_queries`가 빈 문자열에서 실제 질의로 바뀌었고, 재시도가 **다른 문구**를
  제안하게 됐습니다. 회귀 테스트 있음(`rpc-pure-entries`).
- `global.query` / `global.tried_queries`로 읽어 보는 시도는 **틀렸고 되돌렸습니다** — 그 상태는
  서브플로우 로컬입니다.
- 그럼에도 루프는 전진하지 못합니다. 제안된 문구가 검색기에도 도착하지 않아
  (`{ if: [tool.args.query, tool.args.query, tool.args.context.query] }`가 항상 세 번째로 떨어짐)
  매 패스가 원래 질문을 다시 합니다.

## 6. 재현

```bash
node tools/ax.mjs open 11st
node tools/ax.mjs --no-build send "로지텍 무선 마우스를 11번가, 월마트에서 배송비 포함 총액으로 비교해줘"
```

`shopping_collect_store_page`의 출력 여섯 개가 모두 동일합니다. 상태 스냅샷은 AXSDK 컨텍스트에서
`getChatStore().getState()` → 마지막 메시지의 `parts[].debug.localState`로 읽었습니다.

## 7. 우리 쪽 상태

`test:lua` 431 · `check:flows` 95 · `test:commerce` 24/24 + 17/17 · `test:playground` 47 ·
앱 revision 98, `fromRemote: 0` · `kind: remote` **0** (프로덕션 플로우 기준).

`test:commerce:live:discovery`는 6/14이고, 그 실패 전부가 이 하나에 걸려 있습니다.
