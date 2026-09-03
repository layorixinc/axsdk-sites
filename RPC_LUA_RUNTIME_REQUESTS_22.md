# RPC Lua 런타임 요청 22 — `pack.*` 네임스페이스 프로젝션 (정정판 2)

날짜: 2026-09-03 (정정판 같은 날) · 요청자: axsdk-sites (X5, `EXTERNAL_PACK_TASK_PLAN.md`)
회신 반영: 위치 인자 · 키 부재 · mutation/batch 성격 · ops version 파급 · X6 차단 문구.

## 요청

런타임 Lua 환경에 `pack` 네임스페이스 테이블을 추가해 주세요. 두 op이며, 기존 op 프레임
그대로 클라이언트로 전달되면 됩니다 (클라이언트 핸들러는 SDK `6a74428`,
`axsdk-extension-cdp/src/ops/packs.ts`로 이미 배포됨):

- `pack.catalog()` — 인자 없음, **read**
- `pack.invoke(binding_id, arguments_json)` — **위치 인자** (params 테이블은 wire shape이며 Lua
  바인딩은 값을 받습니다 — `memory.set_bulk` 교훈 그대로). **mutation**입니다: 한 번의 dispatch가
  설치된 pack 코드를 실행하므로 `LUA_RPC_READ_OPS`에 넣지 말아 주십시오. `pack.catalog`도 이번
  범위에서는 batch 제외에 동의합니다.

우리 호출부는 정정을 이미 반영했습니다 (`_common/rpc/76_rpc_pack.lua`: 위치 인자 호출, 오프라인
스텁도 위치 인자만 수용). 플로우 쪽 책임도 이행했습니다: `pack.invoke`를 부르는 어댑터는
`effect: mutation` + `consent: required` + `idempotent: true` + `require`(결정적 검증기만 쓰는
승인 마커)를 선언하며, `check:flows`(245)와 라이브 세션 컴파일 둘 다 통과합니다.

## 반환 계약 (`LUA_RPC_TYPES` 선언 요청)

`pack.catalog()`:

- `{ commands = { { binding_id, pack_id, version, command, effect, requires_confirmation,
  input_schema } … }, routes = { { intent, description, examples } … }, pack_set_digest? }`
- **미설치 시 `commands`/`routes`는 빈 배열이고 `pack_set_digest` 키는 부재** (null이 아님 —
  Lua nil 의미 정정 반영).
- `binding_id`는 카탈로그가 발급하며 런타임은 검증하지 않습니다; 확장이 자기 composition에서
  전부 재도출합니다.

`pack.invoke` 반환: `{ ok = true, value, provenance } | { ok = false, uncertain?, effect?, code,
message }`.

## ops version 파급 (확인 완료)

`LUA_RPC_OPS_VERSION` bump에 대한 확장 측 pin은 **없습니다** — `axsdk-extension-cdp`와
`axsdk-core` 전체에서 ops version을 고정하는 코드가 0건임을 확인했습니다. 우리 쪽 미러는
`tools/rpc-allow.mjs`(D10: 어휘는 서버 사실, 라이브 체크로 재검증) 하나이며 bump 관측 시 함께
갱신하겠습니다.

## 제네릭 `rpc()` 폴백 — 채택 완료 (2026-09-03 회신 반영)

회신의 "sugar parity 미비, 제네릭 `rpc()` 폴백으로 우회 가능"을 라이브로 측정했습니다
(임시 프로브, 원복 완료):

```text
type(rpc) = table · type(rpc.call) = nil · type(rpc.now) = function
```

배포된 런타임 env에서 호출 가능한 제네릭 경로를 찾지 못했습니다 (`rpc`는 테이블이고 callable
아님, `rpc.call` 없음). 존재한다면 **정확한 시그니처**를 알려주시면 폴백을 즉시 붙이고 X6를
parity 이전에 진행하겠습니다. 없다면 X6는 parity 착륙을 기다립니다 — "차단 중" 표현은 이 문장으로
대체합니다.

## 수용 기준 (정정)

`_common/rpc/76_rpc_pack.lua` 기준:

1. Pack 미설치 클라이언트에서 `pcall(function() return pack.catalog() end)`가
   `#catalog.commands == 0`, `#catalog.routes == 0`, `pack_set_digest` **키 부재**로 답한다 (== {} 표현 정정).
2. 미지원 클라이언트에서 `command_unresolved`류의 명명된 거부로 답한다.
3. `pack.invoke("b-1", '{"x":1}')` 위치 인자 호출이 wire frame
   `{ op = "pack.invoke", params = { binding_id, arguments_json } }`로 전달된다.
4. `pack.invoke`가 `dom.read_many` batch에서 거부된다.
5. 어느 경우에도 `op table has no pack namespace`가 아니게 된다.

## 현재 라이브 상태 (참고)

`팩 카탈로그 보여줘` → `pack_task` 라우팅 → `pack_read_catalog` 실행 → 한국어 정직 거부
(`pack_channel_unavailable: op table has no pack namespace` 원문 인용). 통제 발화는 쇼핑 플로우
그대로, `pack_*` 미포획. 즉 앱/오버레이 측은 준비 완료이며, 남은 것은 네임스페이스 프로젝션
(또는 제네릭 폴백 시그니처) 하나입니다.
