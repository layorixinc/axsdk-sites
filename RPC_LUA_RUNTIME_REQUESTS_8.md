# RPC Lua — 8차: 인수 검증 결과

날짜: 2026-07-27 · 대상: runtime / backend · 작성: axsdk-sites
방식: 배포된 서버에 직접 요청. 문서가 아니라 응답을 근거로 씀. 재현 절차를 항목마다 붙임.

로컬 `../axsdk-backend` 체크아웃에는 `lua_module_invalid`가 없다(`grep -c` → 0). 배포본이 로컬보다
최신이라 소스를 읽어 확인할 수 없었고, 따라서 아래는 전부 **실측**이다.

---

## 1. 통과 — 요청대로 도착한 것

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| **R16** CORS | `OPTIONS /axsdk/v2/event`, `access-control-request-headers: x-axsdk-client-id` | allow 목록 끝에 `x-axsdk-client-id` ✅ |
| **R3-R** gzip | `POST /axsdk/v2/sessions`, `content-encoding: gzip`, 본문 53.4 KiB → 11.5 KiB | `200` ✅ (이전 `500`) |
| **R5** op 어휘 | `GET /axsdk/v2/lua/ops` | `version: "sha256:0bb4bf33418e"`, op 16개 + composed 2개, `types["query_all.fields"]`에 4가지 규칙 설명 ✅ |
| **R15** 모듈 이름 | `POST /axsdk/v2/lua` name=`amazon.00_common` / `amazon/00_common` | `200` / `400 lua_module_invalid` + 패턴 명시 ✅ |
| **R14** 모듈 크기 | 같은 엔드포인트에 48 KiB / 70 KiB 소스 | `200` / `400 exceeds 65536 bytes` ✅ 합의한 64 KiB와 일치 |
| **R12** push | `POST /axsdk/v2/apps/:appId/package` | 존재. `flowDocument`(문자열) 필수. `GET`은 `{revision, flowDocument}` ✅ |

`composed`가 `dom.wait_for_selector → dom.exists`, `nav.wait_for_navigation → dom.get_location_href`로
명시된 것을 확인했다. 우리 스텁이 이 두 헬퍼를 폴링으로 구현한 근거가 서버 응답으로 확정됐다.

---

## 2. 막힘 — Phase 2·3이 열리지 않는다

### 2.1 `execute.modules`가 flow 문서에서 동작하지 않는다 (R2 1단계)

우리 playground 문서(51.5 KiB)로 세션을 만들며 `flowTools.rpc_storefront_search.execute`만 바꿨다.

| 변형 | 응답 |
|---|---|
| 원본 (`lua:` 인라인) | `200` |
| `lua` 삭제 + `modules: [probe.base2, probe.site2]` | `400 client adapter rpc_storefront_search.execute.lua is required for the lua implementation` |
| `lua` + `modules` 병기 | `200` |
| `lua` 삭제 + `modules: [no.such.module]` | `400` (위와 같은 메시지) |

병기가 통과한 것을 "인식됨"으로 읽으면 안 된다. **미지 키도 통과한다** — `execute.zzz_nonsense_key: ["a"]`를
넣어도 `200`이다. 즉 `modules`는 인식되지 않고 무시된다.

**영향**: 이행의 목적 자체가 막혀 있다. Lua를 문서 밖으로 못 내보내면 프로덕션 문서는 190.5 KiB(74%)에서
줄지 않는다. `60_storefront.lua`(33.0 KiB)와 CONFIG 8개(23.0 KiB)를 인라인하면 **246.5 KiB = 96%**로,
프롬프트 한 줄만 늘어도 상한을 넘는다. Phase 2·3은 이 키 하나에 걸려 있다.

**요청**: `execute.modules`를 flow 문서에서 해석해 달라. 이름 해석원(세션 레지스트리인지 app package
`luaModules`인지)도 함께 명시해 달라 — 우리 빌더는 그 지점만 바꾸면 되도록 짜 놨다.

### 2.2 모듈 사이에 `_ENV`가 공유되지 않는다 — **이행 계획의 최대 전제**

2차 회신에서 "`_ENV`는 공유된다 → 전역 기반 상호 참조가 그대로 동작한다"를 받았고, 우리는 그 위에
이행 범위를 산정했다. 오늘 다시 센 실측치는 **40개 파일에서 116곳**이다 — `AX_BASE` / `AX_COMMERCE` /
`AX_STOREFRONT` 세 개만 세도 **23개 파일 53곳**이고, 여기에 `AX_WIZARD` / `AX_PAGINATION` /
`AX_OFFER_VIEW` / `AX_THUMBTACK`이 더해진다. (이전 회차에 적은 "37파일 78곳"은 옛 측정이다.)

지금 떠 있는 유일한 모듈 시스템(세션 레지스트리)은 **격리**한다. 3단계로 측정했다.

```
probe.base2:  AX_PROBE2 = { tag = "base2-loaded" }
              function touch() return { ok = true, tag = AX_PROBE2.tag } end
probe.site2:  function read_base()
                if AX_PROBE2 == nil then return { seen = false } end
                return { seen = true, tag = AX_PROBE2.tag }
              end
```

| 순서 | 호출 | 결과 |
|---|---|---|
| 1 | `probe.site2/read_base` | `{ seen: false }` |
| 2 | `probe.base2/touch` | `{ ok: true, tag: "base2-loaded" }` — 청크가 invoke 시점에 실행됨을 증명 |
| 3 | `probe.site2/read_base` **다시** | `{ seen: false }` |

2번이 성공했으므로 "주입은 compile만 한다"는 문서(§4 registry)대로 청크는 첫 invoke에 실행된다. 그런데
3번이 여전히 `false`다 — **A 모듈이 만든 전역을 B 모듈이 볼 수 없다.**

이것이 결함이라고 주장하지 않는다. 레지스트리는 agents 경로이고 모듈 하나가 독립 스크립트인 편이 맞을 수
있다. 다만 flow 경로의 `execute.modules`가 **이 구현 위에 올라간다면 우리 이행은 성립하지 않는다.**

**요청 (P0, 구현 전 확답)**: `execute.modules: [a, b]`로 선언된 모듈들이 하나의 `_ENV`를 공유하는가?

- **공유한다면** — 추가 작업 없음. 계획대로 간다.
- **격리한다면** — 78곳을 명시적 의존성으로 바꿔야 한다. 이행 범위가 달라지므로 착수 전에 알아야 한다.
  이 경우 모듈이 다른 모듈의 반환값을 받는 방법(선언적 의존성? `require`?)을 정의해 달라. 지금 레지스트리에는
  그런 통로가 없다.

### 2.3 스칼라 반환이 `{}`로 사라진다

| 반환 | `value` |
|---|---|
| `return { a = { b = { c = 1 } }, list = { "x", "y" } }` | `{"a":{"b":{"c":1}},"list":["x","y"]}` ✅ 중첩·배열 정상 |
| `return "plain-string"` | `{}` |
| `return 42` | `{}` |

빈 테이블 반환과 구별되지 않는다. 우리 명령은 테이블을 반환하므로 당장 피해는 없지만, **조용히 사라지는
값**은 진단이 불가능한 종류의 손실이다(우리는 같은 계열의 함정을 이미 두 번 겪었다 — 빈 테이블→객체,
`session_state`의 무성 실패).

**요청 (P2)**: 스칼라를 그대로 싣거나, 최소한 `status: "error"`로 거부해 달라.

### 2.4 R13 `target` 프레임 필드 — 아직 없음

`GET /lua/ops`의 op 16개 중 `target`을 받는 것은 **0개**다. 다중 탭(Phase 4·5)은 그대로 막혀 있다.

### 2.5 `configHash` — 세션 응답에 없음

세션 생성 응답 키: `appUserId, configVersion, appId, id, rootId, userId, runtimeId, config, title,
createdAt, status, updatedAt, provisionState, defaultAgent`. `config` 안에는 `resolvedAt`,
`source: "preloaded"`가 있으나 해시는 없다. 다른 곳에 실린다면 위치를 알려 달라 —
`/session/:id/state`, `/axsdk/v2/sessions/:id/state`, `/axsdk/v2/session/:id/state` 모두 `404`였다.

---

## 3. 미검증

- **R11 모듈 개수 상한(64)** — 65개를 주입해야 확인되는데 남의 세션 자원을 그만큼 쓰지 않았다. 크기 상한이
  합의대로 나왔으니 개수도 그러리라 본다.
- **app package `luaModules`** — `POST .../package`는 우리 **프로덕션 문서**를 덮어쓴다(`GET`으로 확인).
  실험용 앱 없이는 시험할 수 없다. 시험용 `appId`를 하나 주면 여기서 검증하겠다.

---

## 4. 우리 쪽 상태

- Phase 0·1 완료·커밋됨(`0fab827`, `789b175`, `3570012`, `53f4af8`). 라이브: 실제 11번가에서 브라우저에
  사이트 레이어 없이 24카드 중 19건, 29.7s.
- 2.1과 2.2가 풀리기 전까지 Phase 2·3은 착수하지 않는다. 그동안 플랫폼 의존이 없는 것만 진행한다 —
  `50_commerce.lua`(75.5 KiB, 유일하게 64 KiB 초과) 6분할, playground 10개 사이트 이식, `allow` 최소권한 검사.
