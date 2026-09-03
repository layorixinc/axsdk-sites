# RPC Lua 런타임 요청 22 — `pack.*` 네임스페이스 프로젝션

날짜: 2026-09-03 · 요청자: axsdk-sites (X5, `EXTERNAL_PACK_TASK_PLAN.md`)

## 요청

런타임 Lua 환경에 `pack` 네임스페이스 테이블을 추가해 주세요. 두 op뿐입니다:

- `pack.catalog()` — 파라미터 없음
- `pack.invoke({ binding_id, arguments_json })`

두 op 모두 기존 op 프레임 그대로 **클라이언트로 전달**되면 됩니다. 클라이언트 핸들러는 이미
배포되어 있습니다 (`axsdk-extension-cdp/src/ops/packs.ts`, SDK `6a74428`): 설치된 Agent Pack
카탈로그를 읽고, 카탈로그가 발급한 `binding_id`로 서명·검증된 명령 하나를 실행합니다. 권한은
이동하지 않습니다 — 확장이 자신의 고정된 composition에서 모든 것을 재도출합니다.

## 측정 (2026-09-03, 라이브)

- 플로우 컴파일러는 `rpc.allow: [pack.catalog]`를 **수용**합니다 (M5의 "닫힌 어휘를 강제하지
  않는다" 측정 그대로). 세션 열림, 툴 실행 도달.
- 그러나 런타임 Lua 환경에 `pack` 전역 테이블이 없습니다. `type(pack) ~= "table"` — 우리 모듈
  `_common/rpc/76_rpc_pack.lua`는 이를 `pack_channel_unavailable: op table has no pack namespace`로
  정직하게 보고하고, 사용자는 한국어로 그 이유를 그대로 듣습니다 (원문 인용 규칙).
- 비교: `memory.*`/`sitemap.search_site`는 네임스페이스가 존재하고 클라이언트 미구현 시
  `command_unresolved`로 답합니다 — 우리가 원하는 것은 정확히 그 동작입니다: 네임스페이스는
  런타임이 만들고, 해석은 클라이언트가 합니다.

## 수용 기준

`_common/rpc/76_rpc_pack.lua`의 `pcall(function() return pack.catalog() end)`가:

1. Pack이 설치되지 않은 클라이언트에서 `{ pack_set_digest = null, commands = {}, routes = {} }`를
   반환하고 (extension은 이미 이렇게 답합니다),
2. 미지원 클라이언트에서 `command_unresolved`류의 명명된 거부를 반환하며,
3. 어느 쪽도 `op table has no pack namespace`가 아니게 되는 것.

차단 중: X6 (설치→라우팅→실행→제거 라이브 게이트). 라우팅·정직 거부·통제 발화 미포획은 이미
라이브로 증명되어 있습니다.
