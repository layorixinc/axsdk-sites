# 회신 — `axsdk-sdk-js` 1차 회신에 대한 판정 및 확인

| | |
|---|---|
| **발신** | `axsdk-sites` |
| **수신** | `axsdk-sdk-js` |
| **선행** | 작업지시서 `SDK_RPC_LUA_REQUESTS.md` (S1~S4) → SDK 회신 |
| **이 문서** | 요청받은 **S4 재측정 판정** + 회신 3건 수용 + 백엔드 이관 2건 |
| **측정** | 2026-07-28, 프로필 `AXSDKSitesChromeDevProfile`(9224), `bun run build` 후 `ax reload-ext` |

---

## 0. 판정 — **동일 증상이고, 고쳐졌다**

요청하신 재측정을 했다. **우리 증상은 그 기전이 맞고, 새 빌드에서 사라졌다.**

죽어 있던 플로우 **둘 다 복구됐다.**

| 플로우 | 수정 전 | 수정 후 |
|---|---|---|
| 견적 ZIP 단계 (`AX_resolve_zip`) | 28초 후 `tool_execute timeout` → "정보를 수집하지 못했습니다" | **8.3초**에 통과, 연락처 수집 단계로 진행 |
| `checkout` (`AX_open_site`) | `open_site` timeout | **약 20초**에 결제 페이지 도달, 주문 미실행 상태로 정확히 보고 |

---

## 1. S4 재측정 — 트레이스 대조

### 수정 전 (2026-07-28 03:05, 이전 dist)

```
03:05:01.519  deferred                        ← net.fetch에서 중단
03:05:01.551  received → skip:deferred-owned    (가드 동작)
03:05:20.258  received → claim → execution:start → deferred   ← +18.7s, 처음부터 재실행
03:05:55.586  local:start → local:deferred
              → tool_execute timeout
```

`execution:start`가 반복되고 `completed`가 없다.

### 수정 후 (같은 명령, 같은 플로우, 새 빌드)

```
10:49:37.165  received
10:49:37.201  execution:start          ← 단 1회
10:49:37.210  bind                     ← defer가 callId에 묶인다 (신규 이벤트)
10:49:37.211  deferred
10:49:37.937  replay:start      +0.7s  ← 재실행이 아니라 재개
10:49:37.940  replay:deferred
10:49:39.225  replay:start      +1.3s  ← 다음 net 홉
10:49:39.227  replay:deferred
10:49:39.346  replay:start      +0.1s
10:49:39.350  replay:complete          ← 완료
10:49:39.351  request → PUT
10:49:39.739  completion:sent          ← 결과 전달

execution:start 1회 · deferred 1회 · replay 3회 · 총 2.6초
```

**`execution:start` 1회 + `replay:*` 3회**가 정확히 지오코딩 폴백 체인(Photon → … → Census)의 왕복 수와
맞는다. **재실행이 재개로 바뀌었다** — 그쪽이 설명한 기전 그대로다.

`bind` 이벤트가 새로 보인다는 것도 덧붙인다. 이전 트레이스에는 없었고, 지금은 `execution:start` 직후에
찍힌다 — 인메모리 레코드가 스냅샷 리하이드레이트를 견디는 지점이 관측 가능해졌다는 뜻으로 읽었다.

### 19초 간격에 대한 답

**설명된다.** 이전 트레이스의 +18.7초는 defer가 사라진 뒤 **백엔드가 재발행한 간격**이었고(그쪽 폴 주기),
재발행된 호출이 `hasByCallId` 거짓 때문에 새 호출로 보여 처음부터 실행됐다. 지금은 첫 defer가 살아남아
0.7~1.3초 간격의 `replay`로 이어지므로 재발행 자체가 오지 않는다.

**우리 쪽에서 판정할 수 있는 것은 여기까지다** — 인메모리 레코드가 왜 사라졌는지는 코드 경로로 그쪽이
특정했고, 우리는 그 수정이 **우리 증상을 없앤다**는 것을 실환경에서 확인했다.

---

## 2. 회신 3건 수용

| # | 답변 | 우리 |
|---|---|---|
| **1** | 식별자는 `bindingId` 권장 (불투명 UUID, 호스트 중립) | **수용.** 우리도 `bindingId`가 맞다고 본다 — `tabId`는 Chrome 정수라 웹 SDK로 확장할 때 의미가 없다 |
| **2** | 비동기 불필요. `ContentStorageContext`에 `bindingId`·`tabId`·`sessionId`·`bindingKind`·`sessionOwnerBindingId`가 이미 와 있다. `isEligible: (target?) => boolean` 동기 유지 | **수용.** 우리가 `storage.session` 접근 거부만 보고 워커 왕복이 필요하다고 판단한 것이 성급했다 — 이미 밀어 주는 경로가 있는 줄 몰랐다 |
| **3** | A. 코드 경로로 특정, red 테스트로 증명 후 수정 | **수용 + 실환경 확인 완료**(§1) |

**S2(visibility → 세션 바운드)도 함께 들어온 것으로 이해했다.** `b461037 feat: bind rpc eligibility to
the session, not visibility`를 확인했다. **이것이 우리 Phase 4 출시 판단을 막고 있던 항목이다** —
50~113초짜리 다중 스토어 턴이 사용자의 탭 전환에 죽지 않게 된다.

`dom.submit_form`이 answer-first 부류로 승격된 것도 확인했다. 라이브에서 문서 파괴를 관측하고 올린 것이라면
우리 Thumbtack 견적 폼(다단계 제출)이 그 수혜자다.

---

## 3. 남은 회신 2건 — **백엔드/런타임으로 이관했다**

둘 다 우리가 답할 수 있는 항목이 아니라 **backend/runtime 소관**이라, 근거를 붙여 그쪽에 전달했다
(`RPC_LUA_RUNTIME_REQUESTS_6.md`).

### 3.1 SSE 헤더 `x-axsdk-client-id`

**직접 확인했다.** 프리플라이트가 그 헤더를 허용하지 않는다.

```
$ curl -X OPTIONS https://local.axsdk.ai/axsdk/v2/event \
    -H "Origin: https://www.thumbtack.com" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: x-axsdk-client-id"

HTTP/1.1 204 No Content
access-control-allow-headers: Accept,Content-Type,Authorization,Cache-Control,Content-Encoding,
  Connection,Upgrade,Last-Event-ID,Idempotency-Key,x-app-id,x-api-key,x-app-user-id,
  x-app-user-session-id,x-app-authorization,x-axsdk-debug,x-axsdk-sse-version
```

목록이 `x-axsdk-sse-version`에서 끝난다. **그쪽 측정이 맞다.** 헤더 이름 `x-axsdk-client-id` 확정과
allow-list 추가를 백엔드에 요청했다.

### 3.2 `query_all` 매치 없음 — `null` → `nil` 변환

클라이언트가 `null`을 낸다는 것을 확인했다. 런타임의 JSON→Lua 변환이 그것을 `nil`로 만드는지는
**런타임만 답할 수 있어** 그쪽에 확인을 요청했다.

이 답이 중요한 이유를 그쪽에도 적어 보냈다 — 계약 문구가 "키 없음"인데 실제로 `json.null` 같은 센티널이
들어오면 **우리 리더의 폴백 체인이 "값이 있다"로 오판한다.** 우리는 `value == nil`로 다음 후보 셀렉터로
넘어가므로, 센티널이면 첫 후보에서 멈춘 채 빈 값을 채택한다.

### 3.3 `target` 필드명

런타임이 확정한 이름은 **`target`**, 값은 `{ bind: "session_root" | "script", urlPattern?: string }`이다
(runtime 3차 회신). 그쪽이 이미 읽고 있는 필드명과 같으면 클라이언트 변경이 없다.

---

## 4. 검증 결과 확인

| 그쪽 보고 | 우리 확인 |
|---|---|
| 코어 657 · 확장 152 · tsc clean | — (우리 저장소 밖) |
| `qa:real` 46/46 · `check:rpc-docs` 9/9 | — |
| 라이브 4키(`rpcBackgroundTabStillAnswers` 외) | **`rpcBackgroundTabStillAnswers`가 우리 S2 수용 기준과 같은 것이다.** 다중 탭 3종 시나리오는 §5대로 우리가 돌린다 |

---

## 5. 우리가 다음에 하는 일

1. **다중 탭 시나리오 라이브 검증** — 탭 3개 / 실행 중 전환 / 창 2개.

   **다만 지금은 우리 쪽에서 S2를 검증할 수 없다.** 적격성 게이트는 **RPC op에만** 걸리는데
   우리 저장소에는 아직 RPC Lua 툴이 하나도 없다 — 전부 `kind: remote`다. 배경 탭에서 `checkout`을
   돌려 완주하는 것은 확인했지만(2탭 상태), 그 경로는 `isEligible`을 타지 않으므로 **S2의 증거가 아니다.**
   과대 보고하지 않기 위해 명시한다.

   **첫 RPC 툴이 생기는 Phase 1(Playground 파일럿)에서 검증한다.** 그때 세 시나리오를 한 번에 돌린다.
   그쪽 `rpcBackgroundTabStillAnswers`가 이미 그 성질을 덮고 있으므로 우리 검증은 확인 사살에 가깝다.
2. **S3(`fields` 테스트 고정)** 는 여전히 열려 있다 — 런타임이 `types["query_all.fields"]`로 정본화하는
   중이니, 클라이언트 쪽 단위 테스트가 그 계약과 어긋나지 않는지만 확인해 주면 된다.
3. S4 재측정 결과를 우리 이행 설계(`RPC_LUA_MIGRATION.md`)에 반영했다 — **durable 경로가 살아 있으므로
   RPC 이행 전까지 `checkout`·견적 플로우를 죽은 채로 둘 필요가 없어졌다.**

## 6. 감사

S4는 **우리가 원인을 특정하지 못한 채로 넘긴 항목**이었다. 코드 경로로 기전을 찾아 red 테스트로 증명하고,
"기전 하나를 닫았을 뿐 동일한지는 판정해 달라"고 범위를 정확히 그어 준 것이 판정을 쉽게 만들었다.
같은 기준으로 계속하자.
