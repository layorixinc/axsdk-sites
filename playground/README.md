# Extension Playground 운영 매뉴얼

`playground/`은 AXSDK 확장을 실제 **headed Chrome**에서 시험하되, 일상 개발용 `ax` 프로필과 분리하기 위한 로컬 소스 워크스페이스다.

- 기본 CDP 포트: `9235`
- 기본 Chrome 프로필: `%LOCALAPPDATA%/AXSDKPlaygroundChromeProfile`
- 기본 home: `https://axsdk.ai/`
- 일상 `ax` 기본 포트/프로필: `9224` / `%LOCALAPPDATA%/AXSDKSitesChromeDevProfile`

Playground는 기본값으로 일상 `ax` 프로필이나 포트 사용을 거부한다. `--allow-shared-profile`은 이 보호를 해제하므로 일반 운영에서 사용하지 않는다.

## 1. 역할과 범위

Playground는 다음을 수행한다.

1. 이 폴더의 `index.md`, `_common/`, 사이트별 Lua/flow source를 읽는다.
2. 전용 Chrome 프로필의 extension storage에 local sites index, Lua, flows를 저장한다.
3. `remote_sites:false`를 적용해 원격 sites/index/Lua/flow/widget source가 섞이지 않게 한다.
4. extension을 cold reload한 뒤, 저장된 common/site Lua layer가 실제로 활성화됐는지 검증한다.
5. REPL에서 `AX_*` command와 실제 flow engine을 실행한다.

Playground는 사이트 동작을 모의하지 않는다. indexed host로 이동하면 실제 사이트와 실제 extension runtime을 사용한다. 주문, 견적 제출, 폼 제출 같은 변경성 command는 자동 실행하지 않지만, REPL에서 직접 호출하는 command는 실제 동작일 수 있다.

## 2. 시작 전 준비

### 필요 조건

- repository root에서 Node dependencies가 설치되어 있어야 한다.
- 개발용 unpacked AXSDK extension build가 준비되어 있어야 한다.
- repository root의 gitignore된 `.env`에 개발 환경 credentials가 있어야 한다. 없으면 extension Options에 직접 입력해야 한다.
- dedicated profile을 처음 만들 때는 사용자가 Chrome UI에서 extension을 직접 설치해야 한다.

`.env`는 repository root에 두며 `playground/`에는 넣지 않는다. CLI는 값을 읽어 dedicated profile의 extension 설정에만 기록하고, 화면·로그·commit 대상 파일에는 출력하지 않는다.

### 2.1 Extension 설정 자동 복원

dedicated profile은 extension을 command line으로 올리기 때문에 Chrome을 완전히 껐다 켜면 그 extension의 `chrome.storage.local`이 사라진다. `axsdk:extension:config`가 지워지면 content script가 초기화되지 않고 `AXSDK Assistant runtime is unavailable`로 실패한다.

그래서 모든 CLI 명령은 runtime 확인에 실패하면 `.env` 값으로 extension 설정을 다시 쓰고, extension을 reload한 뒤 한 번만 재시도한다. 사용하는 key는 다음과 같다.

| key | 용도 | 기본값 |
|---|---|---|
| `AXSDK_API_KEY` | extension API key (필수) | 없음 |
| `AXSDK_APP_ID` | extension app id (필수) | 없음 |
| `AXSDK_BASE_URL` | backend base URL (필수) | 없음 |
| `AXSDK_SITES_URL` | sites source 표시값 (선택) | 기존 값 유지 |
| `AXSDK_EXTENSION_ENABLED` | `enabled` toggle | `true` |
| `AXSDK_EXTENSION_DEBUG` | `debug` toggle. harness는 debug 전용 `_AXSDK`/`_AXLUA` handle로 runtime에 접근하므로 `false`면 CLI가 붙지 못한다 | `true` |

같은 이름의 환경 변수가 있으면 파일보다 우선한다. 단 빈 값은 무시하고 파일 값을 사용한다. `.env` 탐색 순서는 현재 작업 directory, `--root` workspace, workspace 상위 directory다. 필수 key가 없으면 자동 복원을 건너뛰고 어떤 key가 비었는지 오류 메시지에 표시한다.

복원은 기존 설정 위에 병합하므로 `remote_sites`, `storedFlowsEnabled`, `luaOperations` 같은 sync가 관리하는 값은 지워지지 않는다.

### 명령 실행 위치

repository root에서는 다음처럼 실행한다.

```bash
node tools/playground.mjs <command> --root=playground
```

`playground/` 안으로 이동했다면 `--root` 없이 실행할 수 있다.

```bash
cd playground
node ../tools/playground.mjs <command>
```

명령과 사용 가능한 flag는 언제든 다음으로 확인한다.

```bash
node tools/playground.mjs help
```

## 3. 최초 extension 설치와 개발 설정

새 전용 profile에서는 먼저 `setup`을 실행한다.

```bash
node tools/playground.mjs setup --root=playground
```

`setup`의 보장 사항:

- dedicated profile directory만 생성하며 기존 내용을 삭제하지 않는다.
- headed Chrome을 연다.
- Chrome을 `--load-extension` 없이 시작한다.
- `chrome://extensions/`와 playground home을 연다.
- terminal에 표시한 unpacked extension directory를 사용자가 직접 선택하게 한다.
- 사용자가 Enter를 누른 뒤 AXSDK runtime을 확인한다. runtime이 없으면 `.env` 값으로 extension 설정을 기록하고 extension을 reload한 뒤 다시 확인한다.
- `.env`에 필수 key가 없으면 설정을 바꾸지 않고, 설정을 마칠 때까지 재시도 안내를 표시한다.
- `quit`, `exit`, `cancel`을 입력하면 extension 설정을 바꾸지 않고 중단한다.

Chrome에서 다음 순서로 진행한다.

1. `chrome://extensions/`에서 **Developer mode**를 켠다.
2. **Load unpacked**를 선택하고 terminal에 표시된 extension directory를 지정한다.
3. terminal로 돌아와 Enter를 누른다. credentials와 Debug logging은 `.env` 값으로 기록된다.
4. `.env`를 쓰지 않는 경우에만 extension Options에서 credentials를 직접 입력하고 Debug logging을 켠 뒤 Enter를 누른다.

다른 extension build를 쓸 때만 경로를 명시한다.

```bash
node tools/playground.mjs setup --root=playground --extension=C:/path/to/axsdk-extension/dist
```

## 4. 워크스페이스 구조

현재 fixture는 common durable-operation 예제, 최소 `example` site layer, 그리고 실제 storefront `AX_search_product` durable-v2 layer 10개를 포함한다. 지원 slug는 `amazon`, `walmart`, `ebay`, `aliexpress`, `etsy`, `coupang`, `naver-shopping`, `gmarket`, `11st`, `ssg`다.

```text
playground/
  README.md
  index.md
  _common/
    flows.yaml
    scripts/
      00_playground.lua
      05_durable.lua
      06_commerce_sites.lua
      10_durable_operations.lua
      15_storefront.lua
      20_open_site.lua
  example/
    flows.yaml
    scripts/
      00_ping.lua
  <commerce site>/
    scripts/
      00_search.lua       # Amazon은 기존 00_amazon.lua + 10_search.lua
```

### `index.md`

`index.md`는 host를 playground domain으로 매핑하는 canonical local sites index다.

```md
- [Example](https://example.com): [`example`](example)
- [Amazon](https://www.amazon.com): [`amazon`](amazon)
```

각 항목은 HTTP(S) host를 해당 local domain layer에 연결한다. 위 예에서는 `example.com`→`example`, `www.amazon.com`→`amazon`이다.

- 첫 HTTP(S) Markdown link가 host를 정한다.
- 첫 non-HTTP(S) link가 domain을 정한다. 없으면 link label을 사용한다.
- 여러 host가 하나의 domain을 가리킬 수 있다.
- 하나의 host가 서로 다른 domain으로 매핑되면 sync 전에 실패한다.
- `axsdk.ai` 및 하위 domain은 local index에 넣을 수 없다. 기본 home은 common layer만 검증하는 unknown-host surface다.
- index는 UTF-8 기준 256 KiB를 넘을 수 없다.

### `_common/`

`_common/flows.yaml`은 필수이며 global flow layer `":"`로 저장된다. `_common/scripts/*.lua`는 global Lua layer `":"`로 저장되어 모든 host에서 먼저 적용된다.

현재 fixture처럼 `defaults.mapping: legacy`를 유지한다. 기존 flow mapping이 bare dotted path를 사용한다면 이를 interpolation mapping으로 바꾸지 않는다.

### 사이트 layer

직접 하위 directory 하나가 site layer 하나다.

```text
example/
  flows.yaml                 # 선택
  scripts/*.lua              # 선택
```

- site Lua는 `":example"`에 저장되며, common Lua 뒤에만 적용된다.
- `scripts/` 아래의 직접 `.lua` 파일만 읽는다. nested directory는 허용되지 않는다.
- 파일은 lexical order로 읽는다. `00_`, `10_` prefix로 load order를 고정한다.
- Lua 또는 `flows.yaml`을 가진 site directory는 반드시 `index.md`에 등록돼야 한다.
- `fixtures`, `dist`, `tools`, `node_modules`, hidden directory는 site layer로 읽지 않는다.

### Flow selector contract

`_common/flows.yaml`과 site overlay의 runtime contract는 exact selector다. 전체 절차는
[`../FLOWS_YAML_SELECTOR_MIGRATION.md`](../FLOWS_YAML_SELECTOR_MIGRATION.md), schema reference는
[`../FLOWS.md` §10–§11](../FLOWS.md#10-selectors--inputselector--outputmap)을 따른다.

- `planner.inputSelector`와 모든 `action`, `action_unit`, `action_contract`, `decision`, `terminal`
  node는 읽는 leaf path만 선언한다. state를 읽지 않는 terminal도 `inputSelector: []`를 명시한다.
- flow-level `inputSelector`, `contexts`, `contextSelector`와 `planner.contexts`는 사용하지 않는다.
  context는 `contexts.<name>` 또는 `contexts.<name>.<leaf>`로 선택한다.
- `$`, `global`, `flows`, `flow`, `active`, `contexts`, `lastIntent` 전체 selector와 동등한 JSONPath는
  금지한다. `active.status`, `contexts.sites`처럼 필요한 leaf만 선택한다.
- 현재 user message는 selector state와 별도다. 자동 전이 뒤 원문을 숨겨야 하는 node만
  `messagePolicy.currentUserText: active_node_only`를 사용한다.
- `outputMap`은 global/context publication allowlist다. 생략하면 외부 publication은 없고, `next`는
  routing 전용이다.

`extends: app`에서 planner는 field-wise merge지만 `flows.<flowId>`는 통째로 대체된다. Playground
overlay가 inherited flow를 바꾸면 그 flow의 모든 node, exact `inputSelector`, transition, terminal을
완전하게 다시 작성해야 한다.

현재 `playground_multi_site_search`는 이 규칙의 예다. `collect`는
`[requestText, query, stores]`만 읽고, serial store search는 `[query, stores]`만 읽으며, result를
읽지 않는 terminal node는 `inputSelector: []`를 사용한다.

## 5. 일반 운영 절차

### 5.1 Source 저장 및 cold reload

Lua, flow, index를 수정한 뒤에는 `sync`를 실행한다.

```bash
node tools/playground.mjs sync --root=playground
```

`sync`는 다음을 한 단위로 수행한다.

1. workspace source와 YAML을 Chrome을 건드리기 전에 검사한다.
2. local index, common/site Lua, common/site flows, empty widgets map을 dedicated profile storage에 기록한다.
3. extension을 reload하고 home으로 이동한다.
4. persisted runtime에서 `remote_sites:false`, stored flows, stored Lua source를 확인한다.

성공 출력에서는 다음을 확인한다.

```text
fromStore > 0
fromRemote = 0
fromLocal = 0
```

Lua가 있는 workspace라면 `fromStore`가 양수여야 한다. `stored-lua:`는 common layer이고 `stored-lua:<domain>`은 active site layer다.

### 5.2 REPL 시작

새 source를 동기화한 뒤 REPL을 연다.

```bash
node tools/playground.mjs repl --root=playground --no-sync
```

`--no-sync`는 저장된 runtime을 검증만 하고 extension storage를 다시 쓰지 않는다. 기본 `repl`은 먼저 sync를 수행하므로, 수정 후 다음 한 명령으로도 운영할 수 있다.

```bash
node tools/playground.mjs repl --root=playground
```

REPL prompt에서 fixture의 common command를 확인한다.

```text
playground> .call AX_playground_common_ping {}
```

indexed site layer를 확인하려면 먼저 해당 host로 이동한다.

```text
playground> .open https://example.com/
playground> .call AX_playground_site_ping {"value":"manual-check"}
```

정상이라면 site command는 `stored-lua:example` source에서 실행된다.

### 5.3 수정 후 반복 절차

가장 짧은 개발 loop는 다음과 같다.

```text
Lua / flows.yaml / index.md 수정
        ↓
REPL에서 .reload 또는 terminal에서 sync
        ↓
common command 또는 indexed site command 실행
        ↓
.status / .ls로 stored source 확인
```

`.reload`와 `.sync`는 page refresh보다 강하다. source를 다시 읽고 storage를 교체한 뒤 extension cold reload까지 수행한다. 같은 script ID의 편집은 단순 browser reload만으로는 반영되지 않을 수 있으므로 source 변경 후에는 `.reload` 또는 `sync`를 사용한다.

## 6. CLI 명령

| 명령 | 용도 |
|---|---|
| `setup` | 전용 profile을 준비하고 manual unpacked-extension 설치/설정이 끝날 때까지 대기한다. |
| `sync` | source를 dedicated extension storage에 저장하고 cold reload 및 runtime 검증을 수행한다. |
| `repl` | 기본 명령. 기본적으로 sync 후 interactive REPL을 연다. |
| `repl --no-sync` | 기존 저장 runtime을 검증한 뒤 REPL을 연다. storage를 쓰지 않는다. |
| `status` | 저장된 local index와 active runtime provenance/source를 검증해 출력한다. |
| `reset --yes` | playground storage records와 extension config를 삭제한다. 아래 reset 주의를 반드시 확인한다. |
| `init --root=<empty-directory>` | 비어 있는 새 directory에 최소 workspace skeleton을 만든다. nonempty directory에는 실행하지 않는다. |
| `help` | 고정된 top-level command와 flag를 출력한다. |

주요 flag:

| Flag | 용도 |
|---|---|
| `--root=PATH` | source workspace root. 기본값은 현재 directory다. |
| `--port=9235` | dedicated Chrome CDP port. |
| `--profile=PATH` | dedicated Chrome user-data directory. |
| `--chrome=PATH` | Chrome executable 경로. |
| `--extension=PATH` | manual setup 시 표시할 unpacked extension directory. |
| `--extension-id=ID` | 기대하는 AXSDK extension ID. |
| `--home=HTTPS_URL` | common-layer home. HTTPS만 허용한다. |
| `--timeout=MS` | durable command/flow deadline. |
| `--no-launch` | dedicated Chrome이 이미 실행 중이지 않으면 실패한다. |
| `--adopt` | 비어 있지 않은 **전용 playground profile**을 최초 sync에서 명시적으로 채택한다. |
| `--allow-shared-profile` | live port/profile 차단을 해제한다. 일반 운영에서 사용하지 않는다. |
| `--yes` | top-level `reset` 확인. |

## 7. REPL 명령

| REPL 입력 | 동작 |
|---|---|
| `.reload` / `.sync` | source 재검사 → storage 교체 → extension cold reload → home runtime 검증. |
| `.ext-reload` | source를 다시 읽지 않고 extension을 reload한 뒤 home을 연다. |
| `.page-reload` | 현재 page만 다시 연다. storage는 바꾸지 않는다. |
| `.home` | configured home으로 이동한다. 기본 home에서는 common layer만 활성화된다. |
| `.open <https-url>` | URL로 이동하고 local index에 해당 host가 있으면 site layer activation을 기다린다. |
| `.send <text>` | 실제 extension flow engine으로 user message를 전송한다. |
| `.run AX_name [json]` | durable Lua execution. navigation/fetch가 가능한 command에는 이 방식을 우선한다. |
| `.call AX_name [json]` | single-turn Lua call. 읽기/즉시 실행 command에 사용한다. |
| `AX_name [json]` | `.run`의 축약형이다. |
| `.page` | 현재 URL과 bounded `AX_read_page` 실행 결과를 출력한다. workspace에 해당 command가 없으면 오류를 `read` field로 출력한다. |
| `.ls` | 현재 Lua command 목록을 출력한다. |
| `.status` | persisted runtime/source 상태를 다시 검증한다. |
| `.sources` | Chrome을 건드리지 않고 현재 workspace의 source digest와 layer key를 출력한다. |
| `.clear` | `RESET` 입력 후 playground storage를 삭제한다. |
| `.stop` | `STOP` 입력 후 확인된 playground Chrome만 종료한다. |
| `.quit` / `.exit` | Chrome을 종료하지 않고 REPL만 끝낸다. |
| `.help` | REPL command 문법을 표시한다. |

`AX_*` argument는 JSON이어야 하며 shell text는 실행되지 않는다. 예를 들어 다음은 유효하다.

```text
.call AX_playground_site_ping {"value":"check"}
```

## 8. 검증 기준

### Common layer

기본 home에서 common Lua가 loaded 되었는지 확인한다.

```text
playground> .home
playground> .call AX_playground_common_ping {}
playground> .ls
```

`AX_playground_common_ping`의 script source는 `stored-lua:`여야 한다.

### Site layer

`index.md`에 등록된 host로 이동한 뒤 site Lua를 확인한다.

```text
playground> .open https://example.com/
playground> .call AX_playground_site_ping {"value":"site-check"}
playground> .ls
```

`AX_playground_site_ping`의 script source는 `stored-lua:example`이어야 한다. `remote` 또는 `ax-local-` source가 보이면 current source가 workspace storage만을 사용하고 있지 않은 상태다.

### Navigation/reload persistence

site Lua가 reload 후에도 persisted layer에서 복구되는지 확인한다.

```text
playground> .open https://example.com/
playground> .call AX_playground_site_ping {"value":"before"}
playground> .page-reload
playground> .call AX_playground_site_ping {"value":"after-page-reload"}
playground> .ext-reload
playground> .open https://example.com/
playground> .call AX_playground_site_ping {"value":"after-extension-reload"}
```

### 8.1 Durable operation fixtures

`_common/scripts/05_durable.lua`는 Lua chunk 간 공유 global인 `AX_PLAYGROUND_DURABLE`를 제공한다. `open`, `save`, `handoff`, `origin`, `summary`는 durable capability와 response를 검증하고, 누락된 durable context를 일관된 `durable_operation_required` 오류로 정규화한다. command별 checkpoint state machine과 phase 전이는 각 command file에 그대로 둔다.

`_common/scripts/10_durable_operations.lua`은 operation-private checkpoint와 explicit handoff 계약을 검증하는 playground 전용 fixture다. `_common/scripts/06_commerce_sites.lua`은 지원 storefront와 entry origin을 한 곳에 정의하고, `_common/scripts/15_storefront.lua`은 site-local replay-safe search reader를 제공한다. `_common/scripts/20_open_site.lua`의 `AX_playground_open_site`는 어느 Playground host에서나 선택한 storefront로 넘기는 portable durable-v2 entry point다.

| Command | 의도된 positive test | Browser side effect |
|---|---|---|
| `AX_playground_durable_checkpoint` | `durable.state.open/save`가 schema 1 checkpoint를 revision-CAS로 저장하는지 확인 | 없음 |
| `AX_playground_durable_same_origin` | checkpoint를 `navigation_armed`로 저장한 뒤 같은 origin의 full navigation/replay에서 `arrived`로 완료되는지 확인 | 명시한 same-origin navigation |
| `AX_playground_durable_handoff` | source checkpoint를 저장하고 허용된 다른 origin에서 한 번만 claim/replay되는지 확인 | 명시한 cross-origin handoff |
| `AX_playground_open_site` | 현재 Playground host에서 선택한 지원 storefront home으로 handoff한 뒤 target host에서 checkpoint를 replay해 `ready`로 완료하는지 확인 | 선택한 storefront로 cross-origin handoff |
| `AX_search_product` | 현재 활성화된 indexed storefront의 같은 query 결과를 읽거나 checkpoint 뒤 search navigation/replay를 완료하는지 확인 | 해당 storefront의 검색 결과만 읽음 |

이 command들은 Lua source만으로 durable 권한을 얻지 않는다. host가 `AXSDK.init`의 `lua.operations`에 command별 operation grant를 등록해야 한다. 특히 handoff는 `portable: true`, target origin allowlist, 그리고 host-owned `DurableWorkStore`/non-site-scoped state key가 필요하다.

Playground는 `tools/playground/store.mjs`의 `PLAYGROUND_LUA_OPERATIONS` allowlist를 dedicated profile configuration에 저장한다. 이 allowlist는 common fixture commands, 10개 storefront origin의 `AX_playground_open_site` portable handoff, 그리고 site-local `AX_search_product` checkpoint를 등록한다. `sync`는 host configuration이 달라졌을 때 먼저 cold reload하고, source stores를 기록한 뒤 다시 reload하므로 첫 sync에서도 stale store 재수화가 source를 덮어쓰지 않는다.

Positive test는 다음과 같다.

```text
# checkpoint only
playground> .run AX_playground_durable_checkpoint {"label":"checkpoint-positive"}

# start on https://axsdk.ai/ko; target must have the same origin
playground> .run AX_playground_durable_same_origin {"target_url":"https://axsdk.ai/ko?playground_durable=same-origin"}

# start on https://example.com/; target must be host-allowlisted and different origin
playground> .open https://example.com/
playground> .run AX_playground_durable_handoff {"target_url":"https://axsdk.ai/ko?playground_durable=handoff"}

# cross-origin storefront entry; target-side durable replay returns ready
playground> .run AX_playground_open_site {"site":"walmart"}

# selected storefront search; it never adds an item to a cart or checks out
playground> .open https://www.walmart.com/
playground> .run AX_search_product {"query":"bluetooth trackball mouse"}
```

`AX_search_product` checkpoints `prepare → navigation_armed → await_results → extracted`. 현재 URL이 같은 query의 현재 storefront results page가 아니면 navigation을 fire하고, replay에서 result cards를 읽는다. 성공 결과는 `site`, `query`, `candidates`, `total_count`, `cursor`, `phase`, `revision`을 담는다. 사이트가 CAPTCHA, sign-in, 또는 access restriction을 요구하면 해당 structured error를 그대로 반환한다.

### 8.2 Direct Amazon search fixture

`_common/flows.yaml`의 `playground_amazon_search` route는 새 chat turn에서 `AX_search_product`를 정확히 한 번 호출한다. 재현 가능한 replay 검증을 위해 query는 `wireless trackball mouse`로 고정했고, cart/checkout command는 포함하지 않는다.

Amazon site layer가 활성화된 뒤 REPL에서 다음을 보낸다.

```text
playground> .open https://www.amazon.com/
playground> .send run playground Amazon durable search test
```

성공하면 `Amazon durable search fixture completed` terminal과 함께 `query`, `candidates`, `total_count`, `cursor`, `phase`, `revision`이 tool result에 나온다. 이 fixture는 `stored-lua:amazon`이 활성화된 `www.amazon.com`에서만 실행한다.

### 8.3 Multi-site shopping flow

`playground_multi_site_search` route는 현재 host가 무엇이든 사용자가 명시한 두 개 이상 열 개 이하의 지원 storefront를 순서대로 연다. 각 item은 `AX_playground_open_site`의 portable durable-v2 handoff로 destination layer를 활성화한 뒤 site-local `AX_search_product`를 replay-safe하게 실행한다. 이 flow는 후보와 각 사이트의 접근 오류를 `store_results`에 모으고, cart, checkout, 주문 command는 포함하지 않는다. 기존 `shopping` route는 고정 Amazon 단일-site fixture로 남아 있다.

```text
playground> .open https://example.com/
playground> .send wireless trackball mouse를 Amazon과 Walmart에서 찾아줘
```

성공 terminal은 `다중 사이트 검색을 완료했습니다`를 반환한다. `shopping_search_sites`의 `store_results`에서 각 `site`, `candidates`, `error`를 확인한다. serial flow의 최종 URL은 사용자가 지정한 마지막 storefront의 search page이며, `.ls`에서는 `AX_playground_open_site`이 `stored-lua:`, `AX_search_product`가 그 활성 storefront의 `stored-lua:<domain>` source여야 한다.

## 9. Reset과 profile 운영

`reset`은 dedicated profile의 다음 records를 삭제한다.

```text
axsdk:sites
axsdk:flows
axsdk:lua
axsdk:widgets
axsdk:playground
axsdk:extension:config
```

따라서 `reset`은 local source뿐 아니라 해당 dedicated profile의 extension configuration도 제거한다. 개발 credentials와 Debug logging 설정이 `axsdk:extension:config`에 저장돼 있다면 다시 `setup`을 실행해 사용자가 설정해야 한다.

```bash
node tools/playground.mjs reset --root=playground --yes
```

다음 상황에서만 `--adopt`를 사용한다.

- profile이 확실히 dedicated playground profile이다.
- 기존 `axsdk:*` records의 소유와 영향 범위를 이해한다.
- 최초 sync가 새 playground stamp를 기록해도 안전하다.

일상 `ax` profile, port `9224`, 또는 사용자 브라우징 profile에는 playground를 연결하지 않는다.

## 10. 문제 해결

### `AXSDK Assistant runtime is unavailable`

CLI는 이 오류를 내기 전에 `.env` 기반 자동 복원(§2.1)을 한 번 시도한다. 오류가 남았다면 원인 후보는 다음과 같다.

- unpacked extension이 설치되지 않았음
- `.env`에 `AXSDK_API_KEY`, `AXSDK_APP_ID`, `AXSDK_BASE_URL`이 없음 — 오류 메시지가 빈 key를 알려준다
- credentials 값 자체가 유효하지 않음
- `AXSDK_EXTENSION_DEBUG=false`로 debug handle이 꺼져 있음
- `--extension-id`가 현재 설치한 extension과 다름

조치:

```bash
node tools/playground.mjs setup --root=playground
```

Chrome UI에서 설치 상태를 확인하고 Enter로 runtime check를 다시 시도한다. Chrome을 껐다 켠 뒤 storage가 비었을 때는 `sync`만 다시 실행해도 설정이 복원된다.

### `Refusing nonempty unstamped profile`

이 profile에는 playground ownership stamp가 없는 `axsdk:*` storage가 있다. 안전한 해결은 새 dedicated profile을 지정하는 것이다.

```bash
node tools/playground.mjs setup --root=playground --profile=C:/Temp/AXSDKPlaygroundChromeProfile
```

정말 dedicated playground profile임을 확인한 경우에만 최초 sync에 `--adopt`를 추가한다.

### source 검사가 실패함

다음을 확인한다.

- `index.md`가 존재하고 올바른 HTTP(S) host/domain mapping을 가짐
- `_common/flows.yaml`이 존재하고 유효한 YAML임
- site directory가 `index.md`의 domain과 일치함
- `scripts/` 아래에 nested directory가 없음
- Lua/flow 파일이 UTF-8임

이 검사는 Chrome launch나 extension storage 변경 전에 실패한다.

### 수정이 반영되지 않음

browser page reload 대신 `.reload` 또는 `sync`를 실행한다.

```text
playground> .reload
```

site layer를 확인할 때는 `.open`으로 `index.md`에 정확히 등록한 hostname으로 이동한다. common home인 `https://axsdk.ai/`에서는 site layer가 활성화되지 않는다.

### Chrome을 자동 실행하지 않고 붙고 싶음

전용 Chrome이 이미 `9235`에서 실행 중일 때만 사용한다.

```bash
node tools/playground.mjs repl --root=playground --no-sync --no-launch
```

## 11. 운영 안전 수칙

1. secrets, credentials, cookies, tokens, 사용자 data를 `playground/` 또는 commit 대상 파일에 기록하지 않는다.
2. `setup`은 사람이 extension을 설치하는 단계다. 설치 이후의 개발 설정은 gitignore된 `.env`에서 dedicated profile로만 복원되며, 그 값은 출력하지 않는다.
3. source 변경 반영에는 browser refresh 대신 `.reload` 또는 `sync`를 사용한다.
4. `--allow-shared-profile`, `--adopt`, `reset`은 profile/state를 바꿀 수 있는 명시적 위험 옵션이다.
5. 실제 사이트에서 mutation command를 직접 실행하기 전에는 side effect를 확인한다.
6. 문제 진단에는 `.status`, `.ls`, `.sources`를 먼저 사용하고, 불필요하게 profile을 reset하지 않는다.

추가 개발/DevTools 참고는 repository root의 [`DEVTOOLS.md`](../DEVTOOLS.md)와 [`EXTENSION_PLAYGROUND_DESIGN.md`](../EXTENSION_PLAYGROUND_DESIGN.md)를 본다.
