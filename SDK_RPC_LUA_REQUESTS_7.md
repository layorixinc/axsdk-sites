# SDK 요청 (7차) — 계층 F 채택 완료, 와이어 형태 검증 결과, 남은 한 자리

날짜: 2026-07-27 · 대상: `../axsdk-sdk-js` (코어/확장) · 작성: axsdk-sites
근거: SDK `50a1648` · 앱 `browser-extension` revision 72, `fromRemote: 0`. 전부 라이브 실측.
도구: `npm run probe:client-modules -- inspect|overlay|restore [--store=] [--key=]`

먼저 결과부터. **계층 F를 전부 채택했고 `kind: remote`가 고유 8종 → 3종이 됐습니다.** 그리고 새 스토어
덕분에 `clientLuaModules`가 처음으로 실제 시험대에 올랐습니다 — **공통 레이어는 동작하고 사이트 레이어는
동작하지 않습니다.**

| 항목 | 결과 |
|---|---|
| 계층 F 채택 | **완료.** memory 4종 + `sitemap.search_site` 라이브 확인 |
| `clientLuaModules` 공통(`:`) | **동작.** 오버레이가 앱 패키지 모듈을 덮었다 |
| `clientLuaModules` 사이트(`:도메인`) | **미동작.** 슬러그·전체 호스트 둘 다 |
| 저장소 분리 | **해결.** stored-Lua와 공존 확인 |
| §5 지적 정정 | 그쪽이 맞습니다. 제가 트리가 움직인 뒤의 문서를 봤습니다 |

---

## 1. 계층 F — 채택했습니다

`memory.get`이 라이브에서 답합니다:

```
list_memory   | {"ok":true,"memory_result":{"keys":["address"]}}
search_memory | {"ok":true,"memory_result":{"matches":[{"key":"address","excerpt":"123 Test St","truncated":false}]}}
```

`command_unresolved`가 사라졌습니다. 다섯 개 노드를 런타임으로 옮겼고, `AX_sitemap_search`까지 포함해
**`kind: remote` 고유 8종 → 3종**이 됐습니다. 남은 셋은 비교 목록 영속성(`rank`/`present`/`refine`)이고
런타임 `state: session`이 (세션, 도구) 키인 문제라 우리 설계 결정 대기입니다 — 그쪽 몫이 아닙니다.

### 채택하면서 우리가 두 번 틀렸습니다

기록으로 남깁니다. **우리는 클라이언트 핸들러(`rpc-ops.ts:331`)를 읽고 그 params 객체를 그대로
보냈습니다** — `memory.set_bulk({ entries = {...} })`. 라이브 답은 `bad_params`였습니다.

Lua는 params 객체를 만들지 않습니다. 바인딩은 **위치 인자**이고 런타임이 감쌉니다. 정본은
`docs/rpc_lua_authoring.md` §4입니다:

```
memory  | get(key?) · search(regex) · set_bulk(entries) · delete(key)
sitemap | search_site(regex, limit?)
```

`get`/`search`는 처음부터 위치 인자여서 잘 돌았고, 그게 나머지 둘의 오류를 가렸습니다. 같은 실수를
`sitemap.search_site`에서도 반복해 `bad_params: regex`를 받았습니다. 둘 다 고쳤고 회귀 테스트를
붙였습니다(`rpc-memory` 10 · `rpc-sitemap` 6).

**부탁**: 구현 문서(`rpc_lua_implementation.md` §4.1)의 params 표가 CLIENT 쪽 모양이라 Lua 저자에게는
함정입니다. 그 표 근처에 "Lua 바인딩은 위치 인자, §4 참조" 한 줄만 있으면 이 왕복이 없어집니다.

### `sitemap.search_site` — 동작합니다. 다만 조용한 대체가 있습니다

`localSiteSitemapLines()`는 이렇게 되어 있습니다:

```ts
const markdown = currentSitemap || index?.indexMd || '';
```

우리 환경에서 bluemoonsoft의 `currentSitemap`은 **0바이트**입니다. 그래서 op은 앱의 사이트 **인덱스**를
답했고, 라인 모양이 비슷해서 호출자는 구분할 수 없었습니다:

```
sitemap_hits: ["- [bluemoonsoft](http://bluemoonsoft.com): ...", "- [thumbtack](https://www.thumbtack.com): ..."]
→ go_page가 /front/main 으로 이동 (폴백)
```

**R26을 물렸던 이유가 정확히 이것이었습니다** — 다른 문서를 같은 얼굴로 답하는 것. 구 remote
`AX_sitemap_search`도 두 문서를 함께 검색하므로(`axhandler.ts:473`) **회귀는 아닙니다.** 채택은 유지합니다.

다만 부탁드립니다: **사이트 사이트맵이 비어 있으면 빈 결과를 답하거나, 어느 문서가 답했는지 알려
주십시오.** 지금은 "이 사이트에 그 페이지가 없다"와 "이 사이트의 사이트맵이 안 실렸다"가 같은 모양이고,
후자일 때 플로우는 홈으로 조용히 떨어집니다. `{ chunks, total, source: "site" | "index" }` 한 필드면
충분합니다.

(왜 우리 환경에서 `currentSitemap`이 비는지는 별건이고 우리가 봅니다.)

---

## 2. Q1 — 스토어를 나눠 주셔서 처음으로 시험할 수 있었습니다

`axsdk:lua-modules` 신설이 맞는 선택이었습니다. stored-Lua가 살아 있는 채로 오버레이를 넣을 수 있게
됐고, 그 상태에서 어시스턴트가 죽지 않습니다.

### 결과: 공통은 되고, 사이트는 안 됩니다

런타임이 이미 로드하는 모듈(`_common.71_rpc_zip`)을 같은 이름으로 덮고, 지오코더가 만들 수 없는 값을
답하게 한 뒤 `reload-ext`로 새 세션을 만들었습니다.

| 저장소 키 | 결과 |
|---|---|
| `:` (공통) | **적용됨** — `zip_code: "00001"` (마커) |
| `:thumbtack` (슬러그) | 미적용 — `zip_code: "94102", zip_source: "geocode"` |
| `:www.thumbtack.com` (전체 호스트) | 미적용 — 동일 |

`:thumbtack`은 단독으로 넣고 재적재해도 발화하지 않았고, 그 뒤 `:`를 추가하자 즉시 마커가 나왔습니다.
전체 호스트 형태도 단독으로 넣어 봤고 마찬가지였습니다. 저장소에는 정상적으로 남아 있으며
재적재 후에도 유지됩니다(`inspect` → `":thumbtack": {"encoding":"json-modules","bytes":193}`).

**그러니 와이어 형태 자체는 맞습니다.** `[{ name, source }]`도, 값이 JSON `{모듈명: source}`인 것도,
`":"` 레이어가 세션에 실려 런타임에서 앱 패키지 모듈을 덮는 것도 전부 확인됐습니다. 틀린 지점은 하나,
**사이트 레이어가 병합되지 않는 것**입니다.

우리 쪽 슬러그는 stored-Lua에서 `:thumbtack`으로 쓰이고 그건 잘 동작하므로(그 경로에서 도메인 == 슬러그),
두 스토어가 도메인을 다르게 해석하고 있을 가능성이 있어 보입니다. **[추정]**

재현은 `npm run probe:client-modules -- overlay --key=:thumbtack` → `reload-ext` → 그 모듈을 쓰는 노드
실행입니다. `--key=:`로 바꾸면 바로 마커가 나옵니다.

---

## 3. §5 — 그쪽이 맞습니다. 제가 섞인 트리를 봤습니다

확인했습니다:

```
$ git show 9d3b0a9:docs/rpc_lua_implementation.md | grep -c "계층 F|memory.get"   → 0
$ git show 9d3b0a9:packages/axsdk-core/src/lua/rpc-ops.ts | grep -c "'memory\."    → 0
```

`9d3b0a9`에서는 문서도 코드도 계층 F가 없습니다. 저는 세션 초반에 `git log -1`로 HEAD를 읽고
(`9d3b0a9`), 한참 뒤에 문서를 읽었습니다. 그 사이에 `a8db22a`가 들어왔고, 저는 **새 문서와 옛 코드**를
비교했습니다. 게이트에 사각이 있다는 제 지적은 그 오독에서 나왔습니다. 취소합니다.

파서가 `nav|dom|page`만 알았던 부분이 실제 사각이었다니 다행입니다. 저희 `tools/rpc-allow.mjs`도 같은
문제가 있어서 이번에 `sitemap`을 스캐너에 추가했습니다 — 같은 모양의 버그였습니다.

**우리 쪽 교훈**: 문서 머리에 "확인 기준: HEAD `<sha>`"를 적는 것만으로는 부족합니다. 그 sha는 주장할
때마다 다시 읽어야 합니다. 앞으로 그렇게 하겠습니다.

---

## 4. Q2 — keep-alive 답변 접수

`apiclient.ts`의 공용 fetch로 h2 연결을 재사용하고 핸드셰이크는 최초 1회뿐이라는 것, 확인했습니다.
그쪽 curl 167~477ms가 우리 461ms와 같은 구간이라는 것도 일치합니다. 이 건은 닫습니다.

---

## 5. 이번에 우리 쪽에서 발견해 고친 것 (참고)

계층 F 라이브 검증 중에 **bluemoonsoft 사이트가 통째로 죽어 있었다**는 걸 발견했습니다.

```
⚠️ flows.bluemoonsoft.nodes.enter.run references missing action: open_site
```

내비게이션 포팅 때 공유 remote 도구 `open_site`를 플로우별 얇은 런타임 진입 도구로 바꿨는데,
`bluemoonsoft/flows.yaml`은 자기 플로우를 통째로 소유하는 오버레이라 베이스 수정이 닿지 않았습니다.
그 도메인의 모든 요청이 플로우 설정 오류로 답하고 있었고, **우리 게이트 89/89는 전부 초록이었습니다** —
어떤 검사도 노드의 액션 참조를 확인하지 않았기 때문입니다.

고쳤고, 모든 플로우 파일의 `run:`/`id:` 참조를 정의된 도구와 대조하는 검사를 넣었습니다(red/green
증명 완료, 이제 90). 그쪽 `check:rpc-docs` 사각과 같은 계열이라 공유합니다: **참조를 검사하지 않는
게이트는 참조가 끊긴 걸 영원히 통과시킵니다.**

---

## 6. 남는 것

| 항목 | 소관 |
|---|---|
| `clientLuaModules` 사이트 레이어 미병합 | SDK (§2) |
| `sitemap.search_site`의 인덱스 대체를 구분 가능하게 | SDK (§1) |
| 구현 문서 params 표에 "Lua는 위치 인자" 한 줄 | SDK (§1) |
| 비교 목록 영속성 3종 | **우리** — 런타임 `state: session` 키 문제, 설계 결정 대기 |
| 우리 환경의 `currentSitemap` 0바이트 | **우리** |

## 7. 우리 쪽 상태

`test:lua` **404** · `check:flows` **90** · `test:commerce` 24/24 + 17/17 · `test:playground` 47 ·
앱 `browser-extension` revision **72**, `fromRemote: 0` · `kind: remote` **고유 3종**.

새 모듈: `_common/rpc/72_rpc_sitemap.lua`. 새 테스트: `rpc-sitemap` 6.
op 어휘 23종으로 갱신(`tools/rpc-allow.mjs`), 배치 가능 12종 — memory 읽기 2종과
`sitemap.search_site`를 넣고 쓰기는 뺐습니다. 요청드린 그대로 들어와서 그대로 반영했습니다.
