# RPC Lua 런타임 요청 13 — 플랫폼 소유 명령의 런타임 등가물

날짜: 2026-07-27 · 대상: 백엔드/런타임 · 작성: axsdk-sites
근거: `_common/flows.yaml`의 실제 사용처 + `../axsdk-sdk-js`의 현재 구현을 읽고 확인. 추측 없음.

`kind: remote` 선언이 38 → **21개**(고유 명령 15종)로 줄었다. 그중 **10개 선언(고유 7종)** 을
"플랫폼 소유라 런타임 등가물이 없다"고 우리가 분류해 왔다. 요청서를 쓰기 전에 **7종을 하나씩 실제로
확인했고, 분류가 틀렸다** — 하나는 우리가 이미 가진 op으로 된다.

| 명령 | 우리 판정 | 근거 |
|---|---|---|
| `AX_navigate` | **우리 몫. 요청 아님** | `nav.navigate` op이 이미 있다 |
| `AX_render_widget` | 요청 (R25) | 순수 계산인데 런타임에 없다 |
| `AX_sitemap_search` | 요청 (R26) | 백엔드에 이미 `searchSitemap`이 있다 |
| `AX_get_memory` · `AX_set_memory_bulk` · `AX_search_memory` · `AX_delete_memory` | 요청 (R27) | 저장소 자체가 없다 |

즉 **요청은 3건이고, 하나는 우리가 가져간다.** 아래 각 항목은 "무엇이 없어서 못 하는가"만 적었다.

---

## 0. 요청이 아닌 것 — `AX_navigate`는 우리가 이식한다

`navigate_page` 툴은 같은 사이트 경로로 이동하는 것뿐이다(bluemoonsoft 사이트맵 페이지).

```yaml
navigate_page:
  execute: { kind: remote, tool: AX_navigate, timeoutMs: 60000 }
  input: { link: tool.args.link }
```

구현을 확인했다(`axhandler.ts:566`): `link`에 `params`를 쿼리로 붙여 URL을 만들고
`window.location.href`에 넣은 뒤, `expectedUrl` 힌트로 **도착을 확인**하며 defer한다. 런타임에서 이건
`nav.navigate` + `nav.wait_for_navigation` + `dom.get_location_href`이고, **우리가 검색·견적 경로에서
이미 라이브로 쓰는 조합** 그대로다(쿼리 조립도 우리 `url_encode`가 한다). **플랫폼에 요청할 것이 없고**,
이건 우리 이식 백로그로 옮긴다. 여기 적는 이유는 하나다 — 앞선 회신들에서 우리가 이 명령을
"플랫폼 소유"로 분류해 왔고, 그 분류가 틀렸다는 것을 남겨 두는 게 맞다.

---

## R25 — `widget.render`를 런타임에 노출해 달라 (P1)

### 무엇이 막히는가

Thumbtack 결과 표와 정제된 숏리스트 표, 두 노드가 `AX_render_widget`을 부른다:

```yaml
render_service_results:
  execute: { kind: remote, tool: AX_render_widget }
  input: { template_id: table, data: tool.args.service_results_table }
  output: { service_results_widget: result.value }
```

입력은 **이미 우리 Lua가 결정론적으로 만든 표 데이터**이고(`prepare_service_results_table`), 출력은
UI가 렌더하는 ` ```ax-widget ` 펜스 블록이다. 즉 이 왕복 하나 때문에 두 노드가 remote로 남아 있다.

### 왜 런타임에 있을 수 있다고 보는가

`axsdk-core`의 구현을 읽었다. `default-capabilities.ts:1740`의 `widget.render`는
**`durableCapability` 래핑이 없는 평범한 동기 함수**다:

```ts
widget: {
  render(templateId, data) {
    const result = renderWidgetById(templateId, data ?? {});
    return result.ok ? result.markdown : `Error: ${result.error}`;
  },
```

`renderWidget`(`widgets.ts:129`)은 **DOM을 만지지 않는다** — 템플릿 id를 확인하고 zod로 데이터를
검증한 뒤 JSON 봉투를 펜스로 감싼다. `widget-templates.ts:54`의 주석이 이미 이렇게 말한다:
"`AX_render_widget` 핸들러와 **Lua `widget.render` capability**가 공유해서 모든 표면이 동일한 출력을
낸다."

즉 **브라우저가 필요 없는 순수 계산**이고, 지금 런타임에 없는 이유는 그것이 브라우저 글로벌
(`createAXLuaDefaultBrowserGlobals`)에만 설치되기 때문으로 보인다.

### 요청

런타임 Lua에 `widget.render(template_id, data)`를 같은 구현으로 노출해 달라. op이 아니라 **글로벌**이
맞다 — 왕복이 필요 없다.

### 우리가 직접 하지 않는 이유

Lua에서 JSON을 손으로 만들 수는 있다. 하지만 그러면 **zod 검증을 잃는다.** 우리 표에는 사용자·사이트가
준 문자열이 들어간다(프로 이름에 따옴표, 한국어, `<img>` 태그가 섞여 온 실측 사례가 있다). 이스케이프를
한 곳 틀리면 UI가 봉투를 거부하고 **답변 전체가 깨진다.** 검증된 렌더러가 이미 있는데 그 옆에 검증 없는
두 번째 인코더를 두는 것은 우리 규약(`AGENTS.md`: 기존 패턴 옆에 두 번째 관례를 만들지 않는다)에도
어긋난다.

---

## R26 — 런타임에서 사이트맵을 검색할 수 있게 해 달라 (P2)

### 무엇이 막히는가

```yaml
sitemap_search:
  execute: { kind: remote, tool: AX_sitemap_search }
  input: { regex: tool.args.regex, limit: tool.args.limit }
```

bluemoonsoft 흐름이 사이트맵에서 페이지를 찾는 데 쓴다. 런타임 Lua에는 **사이트맵에 닿는 수단이 없다** —
`dom`은 현재 문서만 보고, `net.fetch`는 R1로 아직 막혀 있다.

### 이미 있는 것

`axhandler.ts:494`를 보면 클라이언트가 `remote_sitemap === true`일 때 **서버의 `searchSitemap`을
부른다.** 그리고 사이트맵은 앱 패키지의 일부다(`package:verify`가 `flowDocument` · `sitemap` ·
`luaModules` 세 부분을 sha256으로 대조한다). 즉 **런타임 쪽에 데이터와 검색이 모두 이미 있다.**

### 요청

둘 중 편한 쪽.
1. `sitemap.search(regex, limit)` 글로벌 — 서버의 `searchSitemap`을 그대로 부른다.
2. 세션이 들고 있는 사이트맵 텍스트를 읽는 접근자(`sitemap.text()`) — 정규식 매칭은 우리가 한다.

1번을 선호한다. 클라이언트가 이미 같은 계약(`{ chunks, total, error }`)을 쓰고 있어서 우리 흐름의
`output` 매핑(`sitemap_hits: result.chunks`)이 그대로 유지된다.

R1(`net.fetch`)이 먼저 열리면 2번은 자연히 해결되지만, 사이트맵은 **우리가 이미 패키지로 올린 우리
데이터**라서 임의 네트워크 접근을 열지 않고도 줄 수 있는 것으로 보인다.

---

## R27 — 메모리 4종의 런타임 등가물 (P2)

`AX_get_memory` · `AX_set_memory_bulk` · `AX_search_memory` · `AX_delete_memory`. 흐름에서 사용자
선호(주소, 반복 주문 습관 등)를 턴 사이에 남기는 데 쓴다.

### 무엇이 막히는가

런타임에는 **저장소 자체가 없다.** 가진 것은 `session_state`뿐이고, 그것은 문자열만 담고 세션
범위다(브라우저 쪽 구현은 `default-capabilities.ts:1545`의 `setLuaSessionState` — `chatStore`의 현재
세션에 문자열로 넣는다). 그리고 런타임의 `state: session`은 **(세션, 툴)로 키가 잡힌다**고 앞선 협의에서
확인했다(런타임 내부는 우리가 읽을 수 없어 그 확인에 기대고 있다) — 쓰는 툴과 읽는 툴이 공유할 수 없다는
뜻이고, 지금 비교 스냅샷 3툴(`rank`/`present`/`refine`)이 remote로 남아 있는 이유와 같은 문제다.
그쪽은 우리가 별도로 설계 결정을 하고 있다.

### 계약 참고

클라이언트 구현이 이미 좁고 명확하다(`axhandler.ts:105~118`):

```ts
AX_get_memory    → key 있으면 { key, value } · 없으면 { keys }
AX_search_memory → searchGlobalMemory(regex)
```

요청: 같은 계약을 런타임 글로벌로 (`memory.get/set_bulk/search/delete`). 범위는 **앱 사용자**이고
세션이 아니다 — 그게 `session_state`로 대체할 수 없는 이유의 전부다.

우선순위를 P2로 둔 이유: 이 4종은 흐름의 **부수 기능**이라 remote로 남아도 사용자가 보는 동작은
멀쩡하다. R25/R26과 달리 기능이 막히지는 않는다. 다만 `kind: remote` 0에는 이것들이 필요하다.

---

## 우리 쪽 상태

게이트: `test:lua` **318** · `check:flows` **79** · `test:playground` 47 ·
`test:commerce` 24/24 + 17/17 · `build:lua:check` 13파일. 앱 패키지 `browser-extension` revision 44.

`kind: remote` **21개**의 내역:

| 갈래 | 고유 종 | 선언 수 | 상태 |
|---|---:|---:|---|
| 메모리 4종 · `render_widget` · `sitemap_search` | 6 | 9 | **이 문서** |
| 비교 스냅샷 (`rank`/`present`/`refine`) | 3 | 3 | 우리 설계 결정 대기(세션 스코프 저장) |
| `resolve_zip` | 1 | 1 | R1 `net.fetch` 차단 |
| `AX_navigate` | 1 | 1 | **우리 몫** — 이식 백로그 |
| amazon 계열 (`open_site`·`checkout`·`add_to_cart`·`add_store_product_to_cart`) | 4 | 7 | 차단 없음, 이식 미착수 |
| **합계** | **15** | **21** | |

즉 **차단은 이 문서의 6종 + R1 하나이고, 나머지는 전부 우리 일이다.**
