# SDK 요청 (5차) — 메모리 op, 왕복 지연, 그리고 철회 한 건

날짜: 2026-07-27 · 대상: `../axsdk-sdk-js` (코어/확장) · 작성: axsdk-sites
근거: 앱 `browser-extension` revision 68, `fromRemote: 0`, `ax sync` 스토어 경로. 수치는 전부 라이브 실측.
확인 기준: `axsdk-sdk-js` HEAD `9d3b0a9`.

이 문서는 세 가지다.

1. **S12 — `memory.*` 클라이언트 op** (P1). 런타임에서 메모리에 닿을 방법이 없다. 작업량은 작고,
   놓을 자리가 이미 열려 있다.
2. **S10 재제출 — RPC 왕복이 초 단위다** (P0). 4차에서 물었고 답을 못 받았다. 그사이 `dom.read_many`가
   들어왔는데도 견적 폼이 완주하지 못한다. 새 측정치를 붙였다.
3. **철회 — `net.fetch` 클라이언트 op은 필요 없다.** 우리가 요청 직전까지 갔던 건이다. 우리 오류였다.

4차의 S8/S9는 들어왔다. 확인했고 아래 §4에 적었다. S11도 답신 없이 들어와 있다.

---

## S12 — `memory.*` 클라이언트 op (P1)

### 무엇이 없나

런타임에서 `memory.get`을 부르면 이렇게 답한다:

```
rpc memory.get failed: command_unresolved: memory.get
```

`executeRpcOp`는 핸들러를 찾지 못하면 **권한 검사 이전에** 즉시 `command_unresolved`를 돌려준다
(`rpc-ops.ts:345`). 즉 우리 쪽 선언으로 닿을 수 있는 자리가 아니다. 실제로 op 표
(`createRpcOpTable`, `rpc-ops.ts:184`)는 지금 **15개 — dom 13 + nav 2**뿐이고 `memory.*`는 없다.

이건 우리가 한 번 틀렸던 종류인지 먼저 의심하고 다시 쟀다(§3 참조). 아니었다. 선언 문제가 아니다.

### 왜 작은 작업인가

op 표를 세우는 그 자리가 이미 메모리를 들고 있다.

| 사실 | 위치 |
|---|---|
| op 표 생성 | `axsdk.ts:586` (`#startRpcChannel`) |
| **같은 파일이 이미 import 중** | `axsdk.ts:50` — `GLOBAL_MEMORY_SCOPE`, `readMemoryScope`, `setMemoryScopeEntry` |
| 같은 인스턴스가 스토어 보유 | `axsdk.ts:182`, `:762` — `memoryStore` |
| 오늘 `AX_get_memory`의 몸통 | `axhandler.ts:105` — `readMemoryScope(GLOBAL_MEMORY_SCOPE)` |
| 그 스토어의 정체 | `memoryscope.ts:42` — `memoryStore.getState().memory` 동기 읽기 |

네트워크도 DOM도 비동기도 없는 **순수 로컬 읽기**다. 새 배선도, 컨텍스트 브리지도, 새 의존성도 필요
없다. 오늘 remote 도구가 답하는 그 함수가 그대로 op의 몸통이 된다.

### 요청하는 4종

| op | 대응 | 비고 |
|---|---|---|
| `memory.get` | `AX_get_memory` | 인자 없으면 키 목록, `key` 주면 값 |
| `memory.search` | `AX_search_memory` | `regex` → markdown |
| `memory.set_bulk` | `AX_set_memory_bulk` | 쓰기 |
| `memory.delete` | `AX_delete_memory` | 쓰기 |

### 두 가지 착지 방법, 두 번째를 권한다

**(a) 코어 표에 추가** — `createRpcOpTable`의 리터럴에 4개 엔트리. 모든 호스트에 나간다.

**(b) 설정으로 주입** — 이미 있는 확장 지점이다. `createRpcOpTable`은
`return { ...table, ...options.ops }`로 끝나고(`rpc-ops.ts:323`), `axsdk.ts:588`이 `lua.rpc.ops`를
그대로 넘긴다. **코어를 건드리지 않고** 확장 설정에서 등록할 수 있다.

(b)를 권하는 이유는 폭발 반경이 아니라 **R27 자신의 결정과 맞아서**다. 메모리를 기기에 남기기로 한
능력이라면 그것을 켜는 것도 호스트별 opt-in인 편이 일관된다. `page.eval`이 `allowPageEval`로 opt-in인
것과 같은 모양이다(`rpc-ops.ts:313`).

### 배치에 대한 정정

백엔드/런타임 13차 회신에 "읽기 2종은 `dom.read_many` 배치에 담깁니다"라고 적혀 있었다. **지금 코드로는
안 된다.** `BATCHABLE`은 dom 읽기 9종을 하드코딩한 집합이고(`rpc-ops.ts:122`), `dom.read_many`는 항목마다
`BATCHABLE.has(op)`를 확인해 거부한다(`:264`). 주석이 의도를 명시한다 — *"이 목록은 미래의 op이 조용히
배치 가능해지지 못하게 하는 클라이언트 자신의 가드"*.

읽기를 배치에 태우려면 `memory.get` / `memory.search`를 그 집합에 **명시적으로** 넣어야 한다. 쓰기는
넣지 말아 달라. 같은 주석이 이유를 단다(부수효과가 섞인 배치는 순서도 원자성도 정의할 수 없음). 우리도
쓰기 배치는 원하지 않는다.

### 부탁 하나 — `memory.search`의 모양을 유지해 달라

op 하나가 왕복 1회이고 그 왕복이 현재 ~1s다(§2). 키를 N개 읽는 도구가 `memory.get`을 N번 부르면 N초다.
**`memory.search`가 markdown을 한 번에 돌려주는 지금 형태를 유지해 달라** — 우리 모듈은 그쪽을 기본
경로로 쓰도록 이미 짜여 있다.

### 우리 쪽 준비 상태

`_common/rpc/70_rpc_memory.lua` + 테스트 7개가 이미 있다. op이 오는 날 flow의 `execute` 블록 한 개만
바꾼다. 거절은 원문 사유를 함께 싣도록 고쳐 뒀다(§3의 교훈).

### 받아들임 기준

`memory.get`을 런타임에서 불렀을 때 `command_unresolved`가 아니라 키 목록이 온다. 그날 우리가
`kind: remote` 4종(`AX_get_memory`, `AX_search_memory`, `AX_set_memory_bulk`, `AX_delete_memory`)을
지운다 — 현재 남은 고유 8종 중 **절반**이다.

---

## S10 재제출 — RPC 왕복이 초 단위다 (P0)

4차에서 "RPC 프레임을 폴링이 아니라 푸시로 처리하는지" 물었고 답을 받지 못했다. 그사이 S8
(`dom.read_many`)이 들어왔으므로, 그것으로 해결됐는지 다시 쟀다. **안 됐다.**

### 오늘 측정 (revision 68, 라이브)

같은 Thumbtack 견적 폼을 두 번 구동했다.

| 실행 | 스텝 | 벽시계 | 종료 상태 |
|---|---|---|---|
| A | 6 | 96s | Submit 화면 도달 (`buttons[Submit disabled=false; Back disabled=false]`) |
| B | 7 | 104s | 예산 소진, 화면은 아직 질문 중 (`buttons[Next disabled=false; Back disabled=false]`) |

우리 도구의 왕복 예산은 `Q.OP_BUDGET = 95`, 플랫폼 `deadlineMs` 상한은 120000이다. 즉
**95왕복 ≈ 100초** — 왕복당 **약 1초**다. `dom.read_many`로 스텝당 32 → ~15회까지 줄인 뒤의 숫자다.

4차에 적어 주신 그쪽 배치 하네스 수치는 **op당 ~37ms**였다. 두 자릿수 차이다.

### 왜 P0인가

Thumbtack 견적 폼은 6~8스텝이다. 실행 A는 마지막 화면에 **도달했고**, 실행 B는 같은 폼의 다른
전문가에서 **도달하지 못했다**. 즉 지금 상태는 "느리다"가 아니라 **전문가에 따라 완주 여부가 갈린다**다.
op 비용이 100ms만 돼도 95왕복이 9.5초라 이 변수는 사라진다.

우리 쪽에서 더 줄일 여지는 크지 않다. 이미: 스텝 읽기는 배치 1회, 모든 dom 접근은 관대 헬퍼로 1회
재시도, 미등록 op은 호출당 1회만 시도하고 기억, 라벨 확인은 `dom.click_text`로 대체. 남은 왕복은
대부분 **쓰기와 클릭**이라 배치 대상이 아니다.

### 묻는 것

1. RPC 프레임이 **푸시**로 전달되는가, 아니면 폴링 간격이 있는가? 있다면 그 간격은?
2. ~1s가 예상된 값인가, 아니면 우리 환경(확장 + CDP dev 프로파일)의 문제인가?
3. 왕복당 비용을 줄일 수 있는 클라이언트 쪽 여지가 있는가?

측정 방법을 공유할 수 있다. 우리 도구가 왕복 수를 직접 세고 있어서(`Q.spent`), 스텝당 op 수와 벽시계를
같이 뽑을 수 있다.

---

## 철회 — `net.fetch` 클라이언트 op은 요청하지 않는다

4차 부수 항목에서 "런타임에 `net`이 없으니 클라이언트 op으로 여는 길도 있다"고 적었고, 그쪽 답에 따라
정식 요청을 낼 참이었다. **철회한다. 우리 오류였다.**

우리는 `rpc.allow: [net.fetch]`로 선언했다. `rpc.allow`는 **op 허가**이고 `net`에는 닿지 않는다.
아무것도 부여되지 않은 채 호출됐고, 우리는 그 침묵을 "런타임에 `net`이 없다"로 읽었다. 올바른 선언은
도구 `execute`에 붙는 `net:` 블록이다:

```yaml
execute:
  kind: runtime
  implementation: lua
  net:
    allow: [photon.komoot.io, geocoding.geo.census.gov]
    maxCalls: 2
    timeoutMs: 8000
```

라이브 결과 `{"zip_code":"94102","zip_source":"geocode"}`. `AX_resolve_zip`은 `kind: remote`에서
빠졌다. **SDK가 할 일은 없다.**

이 건에서 우리가 얻은 것 하나를 공유한다. **거절이 이유 없이 오면 "클라이언트가 그 op을 등록한 적 없음"과
"우리가 잘못 선언함"을 구분할 수 없는데, 두 경우의 조치는 정반대다.** 그래서 우리 모듈은 이제 원문 사유를
함께 싣는다. S12를 그 렌즈로 다시 재서 "선언 문제 아님"을 확정할 수 있었던 것도 그 덕이다.

같은 이유로 부탁 하나: **op이 거절될 때 사유 문자열을 지금처럼 유지해 달라.** `command_unresolved`가
`op_not_permitted`와 구분돼 오는 현재 동작이 진단의 전부다.

---

## §4 — 4차 항목 현재 상태 (우리 확인)

| 항목 | 상태 | 확인 방법 |
|---|---|---|
| S8 `dom.read_many` | **들어옴** | `rpc-ops.ts:257` + 확장 `dist/content.js`; 스텝당 32 → ~15왕복 |
| S9 `dom.click_text` | **들어옴** | `rpc-ops.ts` + `dist/content.js`; CTA 라벨 클릭 경로 사용 중 |
| S10 폴링/푸시 | **미답** | 위 재제출 |
| S11 `dom.submit_form` | **답신 없이 들어옴** | op 표에 존재; Thumbtack `Next`(`type=submit`)가 `requestSubmit()`로만 전진하므로 실사용 중 |

S11은 고맙다. 합성 클릭을 무시하는 SPA에서 이것 없이는 폼이 전진하지 않는다.

---

## 우리 쪽 상태

`test:lua` 397 · `check:flows` 89 · `test:commerce` 24/24 + 17/17 · `test:playground` 47 ·
`test:commerce:live:all` 35/35. 앱 `browser-extension` revision 68, `fromRemote: 0`.

`kind: remote` **고유 8종**: 메모리 4종(S12), `AX_present_store_offers` / `AX_rank_store_offers` /
`AX_refine_store_offers`(런타임 `state: session`이 (세션, 도구) 키라 비교 목록을 넘길 수 없음 — 우리 쪽
설계 결정 대기), `AX_sitemap_search`(런타임의 sitemap이 앱 패키지 것이라 사이트 것이 아님 — 백엔드 R26).
**S12가 들어오면 이 중 절반이 사라진다.**
