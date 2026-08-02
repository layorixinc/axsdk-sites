# 작업지시서 (6차) — SDK에서 이관된 2건

| | |
|---|---|
| **발신** | `axsdk-sites` |
| **수신** | backend / runtime |
| **선행** | 1~5차 (설계 논의 종료) |
| **이 문서** | `axsdk-sdk-js`가 클라이언트 구현을 마치며 **backend/runtime 소관으로 넘긴 2건** |
| **성격** | 둘 다 작다. 하나는 allow-list 한 줄, 하나는 동작 확인 |
| **측정** | 2026-07-28 |

---

## 0. 배경

`axsdk-sdk-js`가 S1(세션 루트 탭 판정)·S2(적격성)·S4(defer 재실행)를 구현했다.
**S4는 우리가 실환경에서 재측정해 해소를 확인했다** — 죽어 있던 `checkout`과 견적 ZIP 단계가 복구됐다
(`SDK_RPC_LUA_REQUESTS_2.md` §1).

그 과정에서 **클라이언트가 완성했는데 서버 쪽이 막고 있는 것 2건**이 남았다.

---

## R16 · SSE 헤더 `x-axsdk-client-id` allow-list 추가 — P0, S1 차단

### 요청

CORS 프리플라이트의 `access-control-allow-headers`에 **`x-axsdk-client-id`** 를 추가하고,
헤더 이름을 그 값으로 확정해 달라.

### 근거 — 직접 측정했다

```
$ curl -X OPTIONS https://local.axsdk.ai/axsdk/v2/event \
    -H "Origin: https://www.thumbtack.com" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: x-axsdk-client-id"

HTTP/1.1 204 No Content
access-control-allow-headers: Accept,Content-Type,Authorization,Cache-Control,Content-Encoding,
  Connection,Upgrade,Last-Event-ID,Idempotency-Key,x-app-id,x-api-key,x-app-user-id,
  x-app-user-session-id,x-app-authorization,x-axsdk-debug,x-axsdk-sse-version
access-control-allow-origin: https://www.thumbtack.com
```

목록이 `x-axsdk-sse-version`에서 끝난다. **`x-axsdk-client-id`가 없어 브라우저가 요청 자체를 거부한다.**

### 무엇을 막고 있나

R13(`bind: session_root`)의 **클라이언트 절반은 완성됐다.** 확장이 SSE 구독에 `bindingId`를 실어
보내려 하는데 프리플라이트에서 막힌다. 이 한 줄이 S1 전체를 붙잡고 있다.

### 수용 기준

- 위 curl에서 `access-control-allow-headers`에 `x-axsdk-client-id`가 포함된다.
- 확장이 그 헤더를 실은 SSE 구독이 성립한다.

### 부수 확인 — `target` 필드명

3차 회신에서 확정한 프레임 필드가 **`target`**, 값이 `{ bind: "session_root" | "script", urlPattern? }`
이라고 이해했다. 클라이언트는 **이미 그 이름으로 읽고 있다.** 다르면 알려 달라 — 다르지 않으면
런타임이 필드를 싣는 순간 클라이언트 변경 없이 동작한다.

---

## R17 · `query_all` 매치 없음 — **철회. 우리가 재서 확인했다**

요청하려던 것: "클라이언트가 내는 `null`이 Lua `nil`이 되는지 확인해 달라."

**물어보기 전에 실측했다.** 라이브 RPC Lua 툴에서 매치 없는 필드를 두 형태로 조회했다.

```lua
local rows = dom.query_all("a", {
  text       = true,
  href       = { attr = "href" },
  ghost      = { selector = ".definitely-not-here-9z" },   -- selector 미매치
  ghost_attr = { attr = "data-not-here-9z" },              -- attr 미존재
}, 3)
```

```
결과: rows=3  text=string  ghost=nil/nil  ghost_attr=nil/nil
```

`type(v)`가 `"nil"`이다 — 센티널이 아니다. **`{selector}` 형태와 `{attr}` 형태 모두 Lua `nil`로 도착한다.**

따라서 계약 문구 **"매치 없으면 에러가 아니라 키 없음"이 정확하다.** 그대로 `types` 에 실으면 된다.
우리 리더의 폴백 체인(`value ~= nil`)도 그대로 동작한다.

**이 요청은 철회한다.**

---
## 1. 우선순위

| ID | 항목 | 우선 | 크기 |
|---|---|:---:|---|
| **R16** | `x-axsdk-client-id` allow-list | **P0** | allow-list 한 줄 |
| ~~R17~~ | `null` → `nil` | — | **철회** — 우리가 실측으로 확인 |

R16은 **클라이언트가 이미 완성한 기능을 서버 한 줄이 막고 있는** 상태다. R13/S1의 마지막 조각이고,
**이 문서에서 유일하게 남은 요청이다.**

## 2. 이 건으로 달라진 것 — 이행 일정

S4 해소로 **durable 경로가 다시 동작한다.** 이행 전까지 `checkout`·`bluemoonsoft`·견적 플로우를
죽은 채로 둘 필요가 없어졌다(5차까지의 전제였다).

**RPC 이행의 긴급도가 내려가고 품질 기준이 올라간다** — 지금 동작하는 것을 대체하는 작업이 되므로,
Phase별 수용 기준("이행 전과 같은 행 수", "같은 창")이 더 엄격한 의미를 갖는다.

## 3. 우리가 하는 일

1. 다중 탭 시나리오(탭 3개 · 실행 중 전환 · 창 2개)를 라이브로 검증한다. **R16이 오면 전체**,
   그 전에는 세션 바운드 적격성 단독으로 먼저 돌린다.
2. Phase 0~1(기반 · Playground)은 계속 진행한다.
3. RPC 채널 스모크 테스트를 Playground에 상주시켰다(`rpc_probe` 인텐트) — 읽기 op 3종 + 폴 헬퍼 +
   `rpc.fanout()`을 한 번에 태운다. 회귀가 나면 여기서 먼저 걸린다.
