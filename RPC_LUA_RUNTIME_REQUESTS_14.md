# RPC Lua 런타임 요청 14 — 13차 회신 처리 결과

날짜: 2026-07-27 · 대상: 백엔드/런타임 · 작성: axsdk-sites
근거: 배포된 앱(`browser-extension` revision 58)에 대한 라이브 측정. 문서가 아니라 실행 결과.

셋 중 **하나는 채택했고, 둘은 채택하지 못했습니다.** 못 한 이유가 둘 다 "메커니즘"이 아니라 **데이터가
다른 것**이라 그대로 적습니다.

---

## R25 — 채택. 그리고 우리 전제가 틀렸던 것 맞습니다

`parseWidgetEnvelope`(`widgets.ts:148`)를 직접 읽고 확인했습니다. 템플릿의 zod 스키마로 재검증하고
`withDefaults`를 다시 적용하며 `version`은 없어도 템플릿 기본값으로 채워집니다. **생산자가 누구든 스키마
검사는 반드시 일어납니다.** "검증 없는 두 번째 인코더"라는 우리 표현은 틀렸고, 그 전제 위에 세운 요청도
틀렸습니다.

`json.encode`로 봉투를 Lua에서 만들고 렌더 툴 2개를 런타임으로 옮겼습니다. **왕복 0.**

그리고 제안하신 대로 검증을 CI로 당겼습니다 — `tools/lua/rpc-widget.test.mjs`가 SDK 빌드에서
`parseWidgetEnvelope`를 **직접 import해서** Lua가 만든 봉투를 통과시킵니다. 규칙을 우리 쪽에 복제하지
않았습니다(복제본은 첫 변경까지만 일치합니다).

```
✔ the SDK's own validator accepts what Lua rendered
✔ quotes, markup, tabs, backslashes and Korean all survive
✔ a shape the template refuses is refused by the SDK too, so nothing was weakened
✔ rows and columns encode as ARRAYS
```

라이브: Thumbtack 결과 표가 런타임에서 렌더돼 사용자에게 그대로 도달했습니다.

**한 가지는 못 했습니다 — 빈 리스트.** 위치 항목이 없는 Lua 테이블은 `{}`(객체)로 인코딩되고, 런타임에
그것을 배열로 표시할 수단이 우리에게 없습니다(`ax.array`는 브라우저 capability 쪽입니다). 그래서 빈
`rows`는 **렌더하지 않고 거부**합니다 — 객체를 보내면 템플릿이 거부하고, 그 거부는 조용해서 사용자에게는
아무 설명 없이 아무것도 안 보입니다. 행이 없는 표는 위젯이 아니라 "결과 없음" 문장이라고 보고 그렇게
처리했습니다. 런타임에 빈 배열을 표현할 방법이 있다면 알려주십시오.

---

## R26 — 채택 못 했습니다. **검색하는 사이트맵이 다릅니다**

메커니즘은 말씀하신 그대로 동작했습니다. `implementation: sitemap.search`, 왕복 0, `{ next, regex,
chunks, total }`. 붙였고 라이브에서 돌았습니다.

문제는 **어떤 사이트맵을 검색하느냐**입니다.

| | 읽는 것 |
|---|---|
| `implementation: sitemap.search` | **앱 패키지의 `sitemap`** |
| `AX_sitemap_search` (durable) | `sitesStore.currentSitemap` — **브라우저가 지금 있는 사이트의** 사이트맵 (`axhandler.ts:473` `localSitemapMarkdowns`) |

프로덕션 앱 패키지의 사이트맵을 실제로 읽어봤습니다:

```
- **홈**: /            Browser extension main page.
- **확장 설정**: /settings
- **도움말**: /help
```

**확장 자신의 페이지 3개**입니다. bluemoonsoft 사이트맵이 아닙니다.

증상은 조용했습니다. 붙인 채로 "블루문소프트 제품 페이지 보여줘"를 돌리면 `sitemap_hits: []`가 나오고
플로우는 폴백인 `/front/main`으로 갑니다 — **매번 성공한 것처럼 보이면서 매번 아무것도 찾지 않습니다.**
잘못된 답이 취할 수 있는 가장 나쁜 모양이라 되돌렸습니다.

**요청.** 런타임에서 **사이트별 사이트맵**에 닿게 해 주십시오. 우리가 GitHub로 게시하고 확장이 도메인마다
로드하는 그 데이터입니다(`bluemoonsoft/sitemap.md`). 형태는 편하신 대로 —
`sitemap.search({ scope = "site" })`든, 사이트 사이트맵을 세션에 실어 주시든.

부수 확인: 경고하신 함정은 우리에게 없었습니다. 호출자가 `action_unit`(모델 턴)이라 regex를 모델이
만듭니다. 다만 `action_contract`로 바뀌지 않도록 컨포먼스로 고정해 뒀습니다.

**그리고 우리가 하나 배웠습니다.** 플랫폼 구현은 **자기 어휘**로 `next`를 답합니다. `next: result.next`로
그대로 통과시켰더니 라이브에서 `final tool result next must be one of: go, error`로 죽었습니다. 우리 Lua
스크립트는 반대로 스크립트가 분기를 고르므로 여기서 파생하면 안 됩니다 — 두 규칙이 반대라 컨포먼스에
적어 뒀습니다.

---

## R27 — 채택 못 했습니다. **클라이언트에 핸들러가 없습니다**

기기 소유 유지에 동의합니다. 저장소가 둘로 갈라지는 것과 주소·주문 습관이 기기를 떠나는 것은 둘 다
우리가 원하는 바가 아닙니다. 왕복 한 번은 타당한 대가입니다.

다만 `memory.get/set_bulk/search/delete`가 **확장의 op 표에 없습니다**
(`packages/axsdk-core/src/lua/rpc-ops.ts`의 `createRpcOpTable` — `dom.*` 16개와 `page.eval`뿐입니다).
읽기 전용인 `list_memory` 하나만 먼저 붙여서 라이브로 확인했고, 결과는:

```
list_memory | {"next":"error","memory_result":{"ok":false,"error":"memory_op_unavailable"}}
```

되돌렸습니다. 붙여 두면 **지금 동작하는 메모리 기능이 사용자에게서 사라집니다.**

우리 쪽 준비는 끝났습니다 — `_common/rpc/70_rpc_memory.lua`와 테스트 7개가 있고, 핸들러가 없을 때
`memory_op_unavailable`로 보고하지 죽지 않습니다. 클라이언트에 들어오는 날 `execute` 블록만 바꾸면
됩니다.

---

## 부수 — S8/S9는 클라이언트에 들어왔고, 효과가 보입니다

`dom.read_many`와 `dom.click_text`가 `rpc-ops.ts`와 확장 `dist` 양쪽에 있습니다. 우리 견적 모듈은 이미
폴백과 함께 채택해 뒀으므로 별도 변경 없이 배치 경로를 탑니다.

Thumbtack 견적 폼 라이브 비교:

| | 결과 |
|---|---|
| 이전 | 5스텝에서 **왕복 예산 소진**(`quote_budget_spent`) |
| 지금 | 5스텝을 돌고 **다이얼로그가 사라져서** 종료(`quote_dialog_closed`, `dialog=false step_form=false surface=""`) |

같은 5스텝인데 예산으로 죽지 않았습니다 — 배치가 듣고 있다는 간접 증거입니다(왕복 수를 직접 셀 방법이
없어 간접입니다). 남은 것은 5스텝 뒤 다이얼로그가 사라지는 이유이고, 그건 사이트 서베이지 플랫폼 문제가
아닙니다.

---

## R1 — 다시 확인했습니다. 아직입니다 (측정)

문서가 아니라 호출로 확인했습니다. `_common/rpc/71_rpc_zip.lua`를 만들어 `resolve_zip`을 런타임으로
붙이고 라이브에서 도시 이름을 넣었습니다:

```
collect_request | {"zip_status":"resolve_failed","error":"zip_geocode_unavailable"}
```

`net` capability가 런타임에 없습니다. 되돌렸습니다 — durable 명령은 같은 주소를 지금도 풉니다:

```
AX_resolve_zip {"address":"San Francisco, CA"} -> {"zip_code":"94102","source":"geocode_zcta"}
```

브라우저에는 `net.fetch`가 있고(`default-capabilities.ts:1681`, `durableCapability`로 감싸인 채)
런타임에는 없습니다. 그래서 붙여 두면 "San Francisco, CA" 같은 도시-only 입력이 **퇴행합니다.**

**모듈은 준비돼 있습니다.** 사다리의 앞 두 칸(명시 ZIP, 주소에 박힌 ZIP)은 **네트워크가 필요 없어서**
지금 런타임에서도 동작하고, 테스트 8개가 있습니다. R1이 오는 날 `execute` 블록만 바꾸면 됩니다.

### 그리고 대안 소유자가 있습니다

R1을 "런타임 호스트 프리미티브"로 설계한 것은 그쪽 확정이고 우리도 동의했습니다(왕복 0). 다만 그것이
**인프라 egress 승인**에 걸려 있는 동안, 같은 능력이 **클라이언트 op**으로도 올 수 있습니다 —
`fetchFromLua`가 이미 SDK에 있고, `dom.read_many`를 노출한 것과 같은 종류의 작업입니다.

| 경로 | 소유 | 대가 | 승인 |
|---|---|---|---|
| 런타임 호스트 프리미티브 (현 R1) | 백엔드/인프라 | 왕복 0 | **egress 승인 필요** |
| 클라이언트 op `net.fetch` | SDK | 왕복 1회 | 승인 불필요 — 능력이 이미 있음 |

차이는 성능이 아니라 **누구의 IP로 나가느냐**입니다. 서버면 플랫폼 IP, 클라이언트면 사용자 IP로
지오코더에 요청이 갑니다. 메모리를 기기에 남긴 R27의 판단과 같은 결의 **제품 결정**이라 우리가 단독으로
고르지 않습니다 — 어느 쪽이든 알려주시면 그대로 붙입니다.

---

## 남는 차단

- **R1** `net.fetch` — ZIP 지오코딩 + FX
- **R26-R** 런타임에서 사이트별 사이트맵 접근 (이 문서)
- **R27-R** 메모리 op의 클라이언트 구현 (이 문서)

게이트: `test:lua` **393** · `check:flows` **89** · `test:playground` 47 ·
`test:commerce` 24/24 + 17/17. `kind: remote` **12 선언 / 고유 9종**.
