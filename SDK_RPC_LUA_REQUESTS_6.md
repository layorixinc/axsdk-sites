# SDK 요청 (6차) — rev 2 회신: Q1 실행 결과, Q2 출처 규명, 그리고 계층 F

날짜: 2026-07-27 · 대상: `../axsdk-sdk-js` (코어/확장) + backend · 작성: axsdk-sites
근거: 앱 `browser-extension` revision 68, `fromRemote: 0`. 라이브 실측. 추정은 `[추정]`으로 적었다.
도구: `npm run measure:rpc` · `npm run probe:client-modules` (이 저장소에 커밋했다. 재현용이다.)

요청하신 셋을 전부 돌렸다. **Q1은 실패했고 원인을 찾았다. Q2는 세 후보가 모두 아니었고 진짜 출처는
따로 있다.** Q4를 읽다가 계층 F 문제를 발견해 §5에 적었다 — 그쪽 `check:rpc-docs` 9/9가 놓치고 있다.

| ID | 결과 |
|---|---|
| Q1 | **실패 재현 + 원인.** 저장소 키 충돌. 형식을 맞춰도 런타임에 닿지 않았다 |
| Q2 | **세 후보 전부 배제.** 출처는 응답 POST의 네트워크 경로(중앙값 461ms) |
| Q3 | 런타임 소관. 우리는 `target`을 싣지 않는다 — 참고만 |
| Q4 | 계층 E 문구 정확. **다만 계층 F가 클라이언트에 없다**(§5) |
| Q5 | 미루자는 판단에 동의 |
| §6 | S11 보장 감사. 다만 우리 패딩은 그 종류가 아니다(§6) |

---

## 1. Q1 · `clientLuaModules` — 돌렸다. 닿지 않는다

### 먼저: 우리 환경에서는 애초에 발화할 수 없었다

그쪽 로더는 `luaStore`(`axsdk:lua`)의 각 값을 JSON `{모듈명: source}`로 읽고 **깨진 JSON은 건너뛴다.**
우리 저장소를 그대로 떠 봤다:

```
$ npm run probe:client-modules -- inspect
":"            { "encoding": "raw-lua", "bytes": 197756 }
":11st"        { "encoding": "raw-lua", "bytes": 3092 }
":amazon"      { "encoding": "raw-lua", "bytes": 73381 }
...  13개 키 전부 raw-lua
```

**같은 키가 stored-Lua 기능의 저장소다.** `ax sync`가 거기에 빌드된 Lua 번들을 원문으로 쓰고
(`tools/harness/cdp.mjs`, `LUA_STATE_KEY = 'axsdk:lua'`), 확장이 그걸 `stored-lua:` 스크립트로 적용한다.
`fromStore: 11 / fromRemote: 0`이 그 증거이고, 우리 개발 루프 전체가 그 위에 있다.

즉 **하나의 키에 두 소비자, 두 인코딩**이다. 한쪽은 원문 Lua를 원하고 한쪽은 JSON을 원하며, JSON이
아니면 조용히 건너뛴다. 그쪽이 두 앱 × 두 형태로 아무 효과도 관측하지 못한 것은 와이어 형태 이전에
이것 때문일 수 있다.

### 그래서 형식을 맞춰서 다시 돌렸다

**시도 1 — `:` 키를 JSON으로.** 어시스턴트가 죽었다. 한 턴이 **파트 0개**로 끝났고 플로우가 아예 돌지
않았다. 예상된 결과다 — 그 키의 원문 Lua 소비자가 살아 있기 때문이다. 되돌렸다.

**시도 2 — 사이트 키(`:thumbtack`)에 그쪽 형식 그대로.** 런타임이 이미 로드하는 모듈을 같은 이름으로
덮고, 지오코더가 절대 만들 수 없는 값을 답하게 했다:

```js
lua[':thumbtack'] = JSON.stringify({
  '_common.71_rpc_zip': 'function AX_RPC_ZIP.resolve(args) ' +
    'return { zip_code = "00001", zip_source = "client_lua_module_overlay" } end'
})
```

`reload-ext`로 새 세션을 만들고 그 모듈을 부르는 노드를 실행했다:

```
collect_request | {"zip_code":"94102","zip_source":"geocode"}
```

**앱 패키지의 원래 모듈이 실행됐다.** 오버레이는 적용되지 않았다.

### 우리가 틀렸을 수 있는 지점

정직하게 적는다. 우리는 `_common.*` 이름의 모듈을 **사이트 키**에 넣었다. 로더가 `_common.*`을 `:`
키에서만 받는다면 이 시도는 애초에 발화하지 않는다. 그런데 **`:`는 쓸 수 없다** — 시도 1이 보여준 대로
그 키를 JSON으로 바꾸는 순간 어시스턴트가 멈춘다.

그래서 우리 결론은 와이어 형태에 대한 것이 아니다:

> **`axsdk:lua`를 두 기능이 서로 다른 인코딩으로 공유하는 한, `clientLuaModules`는 stored-Lua를
> 끄지 않고서는 우리 환경에서 검증될 수 없다.**

### 부탁

1. **키를 분리해 달라.** `axsdk:lua-modules` 같은 별도 키면 두 기능이 공존한다. 이건 클라이언트 결정으로
   보인다.
2. 분리가 어렵다면, **한 값 안에서 두 형식을 구분할 규칙**을 정해 달라(예: `{ "__modules": {...} }`
   래퍼). 우리가 `ax sync`를 그 규칙에 맞춰 고치겠다.
3. 어느 쪽이든 정해지면 **같은 실험을 다시 돌려서** 와이어 형태 자체를 검증해 드리겠다. 도구는
   `npm run probe:client-modules -- overlay|inspect|restore`로 커밋해 뒀다.

---

## 2. Q2 · 620~880ms의 출처 — 세 후보 모두 아니다

세 가지를 순서대로 쟀다.

### 후보 1 (h2) — 배제

```
ALPN negotiated: h2
```

원점은 h2로 협상한다. 평문 HTTP 연결 고갈은 우리 환경의 원인이 아니다.

### 후보 2 (op 자체의 작업량) — 배제

`durationMs`를 op별로 뽑았다. `dom.get_location_href`는 `location.href` 한 번 읽는 op이라 연산이 사실상
0인데도:

```
dom.get_location_href:400ms   nav.navigate:508ms      dom.get_location_href:698ms
dom.get_location_href:718ms   dom.get_location_href:485ms
dom.query_all:504ms           dom.query_all:427ms     dom.exists:505ms
```

**작업량이 0인 op과 `query_all`이 같은 값이다.** 작업량은 설명이 되지 않는다.

### 후보 3 (debug + devtools) — 지배적이지 않다

이 측정 자체가 debug ON 상태였는데, 그 턴의 견적 구간은 **54초**였다. debug OFF로 돌린 직전 두 번은
**96초 / 104초**였다. 켜고 잰 쪽이 더 빨랐으니 로깅이 지배 요인일 수는 없다.

### 진짜 출처 — 응답 POST의 네트워크 경로

`durationMs`가 무엇을 감싸는지 코드로 확인했다(`rpc-channel.ts:120–151`): `executeRpcOp` **더하기
응답 `send()`**, 즉 결과를 백엔드로 올리는 POST까지다. 연산이 0인 op에서 남는 것은 그 POST뿐이다.

라이브 한 턴, 프레임 77개:

```
durationMs   n=77  median=461  min=233  max=910     (op 실행 + 응답 POST)
gapMs        n=76  median=512  min=218  max=13003   (응답 → 다음 프레임)
```

같은 기기에서 같은 원점으로 **맨 HTTP**를 재면:

```
h2 GET /axsdk/v2/lua/ops   n=9  median=230ms  min=92  max=401
TCP+TLS handshake          100ms
local.axsdk.ai → 104.21.70.187 / 172.67.138.198   (Cloudflare)
```

이름은 `local`이지만 **Cloudflare를 통과하는 원격 경로**다. 이 기기에서 그 원점까지 편도 왕복이
230ms이고, op 하나의 461ms는 대체로 그것이다.

### 그래서 3ms와 461ms는 모순이 아니다

그쪽 3ms는 **스텁 백엔드를 서버에서** 잰 값이다. 우리 461ms를 지배하는 구간, 즉 브라우저에서 백엔드
원점까지의 네트워크가 그 측정에는 들어 있지 않다. 두 수치는 서로 다른 구간을 잰 것이고 **둘 다 맞다.**

**클라이언트 책임이 아니다.** 폴링도 아니고 op 구현도 아니다. 그러니 이 건은 SDK 작업 항목에서 빼도
된다. 남는 질문은 백엔드/인프라 쪽이다:

- 이 원점이 개발용으로 Cloudflare를 경유하는 것이 의도인가? 지역 근접 엔드포인트가 있나?
- 응답 POST가 keep-alive 연결을 재사용하는가, 매번 새 연결인가? (핸드셰이크가 100ms다)

### 우리에게 남은 유일한 레버는 프레임 수다

턴당 77프레임 × ~460ms ≈ 35초. 그래서 배치(S8)는 **정확히 옳은 방향이었고**, 지금 우리가 더 줄일 수
있는 것도 프레임 수뿐이다. 이미: 스텝 읽기 배치 1회, dom 접근마다 1회 재시도, 미등록 op은 호출당 1회만
시도하고 기억, 라벨 확인은 `click_text`. 남은 프레임은 대부분 **쓰기와 클릭**이라 배치 대상이 아니다.

**4차 S10을 P0으로 올린 것은 우리 판단 착오였다.** 원인을 클라이언트에 둔 채로 올렸다. 내린다.

---

## 3. Q3 · 프레임 대상 지정 — 참고만

런타임 소관이라 우리가 답할 자리는 아니다. 다만 관련 사실 하나: **우리 플로우는 `target`을 싣지
않는다.** 단일 탭에서만 돌리고 있어서, `not_eligible` 경로는 우리 쪽에서 관측된 적이 없다.

---

## 4. Q4 · 편집하신 문구 — 계층 E는 정확하다

| 파일 | 확인 |
|---|---|
| `docs/rpc_lua_authoring.md` §4 `dom` 행 | `read_many(requests)` · `click_text(sel, text, opts?)` — 등록된 표와 일치 |
| `docs/rpc_lua_implementation.md` §4.1 계층 E | `read_many` 읽기 전용 + 항목별 `op_not_batchable`, `click_text` 정규화(trim/공백1/소문자)와 계층 C 선응답 — 구현과 일치 |

문구 이견 없다. 편집해 주셔서 고맙다.

---

## 5. 계층 F — 명세에는 있는데 클라이언트에 없다 (새 항목)

Q4를 읽다 발견했다. `rpc_lua_implementation.md` §4.1은 **계층 F(로컬 스토어, 5개)** 를 싣고 합계를
**23개**로 적는다.

| 명세된 op | 클라이언트 `createRpcOpTable` |
|---|---|
| `memory.get` · `memory.search` · `memory.set_bulk` · `memory.delete` | **없음** |
| `sitemap.search_site` | **없음** |

라이브 확인:

```
rpc memory.get failed: command_unresolved: memory.get
```

그리고 같은 §4.1이 이렇게 적는다 — *"`memory.get` / `memory.search` / `sitemap.search_site`는 읽기이므로
`dom.read_many` 배치에 담기고"*. 클라이언트의 `BATCHABLE`은 dom 읽기 9종 하드코딩이라
(`rpc-ops.ts:122`) 그 문장도 아직 사실이 아니다.

### 묻는 것

**`check:rpc-docs`가 9/9인데 계층 F 전체가 클라이언트에 없다.** 4자 대조(authoring ↔ implementation ↔
등록된 표 ↔ `GET /lua/ops`)가 왜 이걸 잡지 못하나? 셋 중 하나일 텐데 어느 쪽인지 알려 달라:

1. 계층 F가 대조 범위에서 제외돼 있다 → 게이트의 사각이다. 넓혀 달라.
2. `GET /lua/ops`가 계층 F를 공표하지 않는다 → 문서가 앞서 있다. 문서를 표시해 달라.
3. 우리가 문서를 잘못 읽었다 → 알려 달라.

우리 5차 문서의 **S12**는 이 계층 F의 memory 4종을 요청한 것이다. 그때는 "새 기능 요청"으로 적었는데,
**그쪽 명세에 이미 있는 계층의 미구현**이라는 게 더 정확한 표현이다. 요청 내용은 그대로다:

- 놓을 자리는 이미 열려 있다 — `axsdk.ts:586`이 표를 만들고, 같은 파일이 `:50`에서
  `readMemoryScope`/`setMemoryScopeEntry`를 이미 import하며, `:182`가 `memoryStore`를 들고 있다.
  오늘 `AX_get_memory`가 하는 일은 `axhandler.ts:105`의 동기 읽기 한 줄이다.
- 코어를 안 건드리려면 `lua.rpc.ops` 주입으로도 된다(`rpc-ops.ts:323`의 `{ ...table, ...options.ops }`).
- 배치에 태우려면 `memory.get`/`memory.search`를 `BATCHABLE`에 **명시**해야 한다. 쓰기는 넣지 말아 달라.

들어오면 우리 `kind: remote` 고유 8종 중 **4종이 사라진다.**

---

## 6. §6 회신 — S11 보장은 받되, 우리 패딩은 그 종류가 아니다

> 쓰기 뒤에 처리되는 어떤 프레임도 그 쓰기를 본다.

고맙다. 특히 `deferEffect` op(클릭·내비게이션) 뒤의 읽기가 이제 경합하지 않는다는 뜻이라, 우리
`click → 재확인` 경로들이 조용히 안전해졌다.

다만 **"패딩 왕복 2회를 지워도 된다"는 우리 코드에는 적용되지 않는다.** 우리 `pace()`는 순서 보정이
아니라 **사이트의 재렌더를 기다리는 타이머 대용**이다(런타임 어휘에 대기 op이 없어서 실제 왕복으로
때운다). 코드에 순서 관련 근거를 남긴 적이 없고, 실제로 그 목적으로 넣은 적도 없다.

그리고 산수가 말린다. 한 턴 77프레임 중 `pace`는 **호출 지점 2곳 × 2왕복**이다. 지워도 2.6%다. 지금
비용은 §2의 프레임당 460ms이지 패딩이 아니다. 그래서 **그대로 둔다** — 지우면 사이트가 아직 렌더하지
않은 스텝을 읽고, 그 재시도가 아낀 2프레임보다 비싸다(스텝 하나가 ~13프레임이다).

혹시 우리가 순서 목적으로 넣은 패딩을 구체적으로 보신 자리가 있으면 지목해 달라. 그건 지우겠다.

**`page.eval` opt-in 유지에 동의한다.** 우리는 쓰지 않고, 계약에 남는 편이 낫다는 판단에 이견 없다.

---

## 7. Q5 · 스택 심볼 — 미루는 데 동의

`stage`와 `message`만으로 S6가 풀렸다는 관측에 우리도 같은 경험이 있다. 상시 비용(2.5MB 산출물 또는
확장 안의 원본)을 지금 치를 근거가 없다. **심볼이 없어서 못 푼 사례가 실제로 나오면 그때 정하자.**
그런 사례가 생기면 우리가 먼저 보고하겠다.

---

## 8. 우리 쪽 상태

`test:lua` 397 · `check:flows` 89 · `test:commerce` 24/24 + 17/17 · `test:playground` 47 ·
`test:commerce:live:all` 35/35 · 앱 `browser-extension` revision 68, `fromRemote: 0`.

`kind: remote` **고유 8종**: memory 4종(계층 F, §5) · `AX_present_store_offers` /
`AX_rank_store_offers` / `AX_refine_store_offers`(런타임 `state: session`이 (세션, 도구) 키라 비교
목록을 넘길 수 없음 — 우리 설계 결정 대기) · `AX_sitemap_search`(런타임 sitemap이 앱 패키지 것이라
사이트 것이 아님 — 백엔드 R26, 계층 F의 `sitemap.search_site`가 그 답으로 보인다).

**이번에 우리가 정정한 것**: 4차 S10의 P0 판정(원인을 클라이언트에 뒀다 — §2). 5차 S12의 "새 기능
요청" 표현(그쪽 명세의 미구현이 정확하다 — §5).
