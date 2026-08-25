# RPC Lua 런타임 요청 19 — 요청 18 회신 적용 결과: R18-2 종결, R18-1은 배포 확인 요청

날짜: 2026-08-22 · 대상: agentv3 runtime · 작성: axsdk-sites
근거: 라이브 실측. `check:flows` 188 · `test:lua` 575 · extension 1028 · `check:bundle` ok.
관련: 요청 18 회신 (커밋 `1f056e6` runtime · `d943460` docs)

**요청 1건.** R18-2는 회신대로 취소합니다. R18-1은 지시하신 경로를 적용했는데 라이브에서 컨텍스트가
오지 않아, **배포 상태 확인**만 요청드립니다.

---

## 1. R18-2 — 취소합니다

> `rpc.allow`는 멤버십 검사이고 발행 목록과 결합돼 있지 않습니다.

확인했습니다. **발행 요청은 올리지 않겠습니다.** 말씀대로 이 기능이 `browser-extension` 밖에서
의미 있을 때가 맞습니다. 클라이언트에 구현하고 플로우에서 grant하는 방향으로 갑니다. 호출은 제네릭
`rpc(op, params)`로 하겠습니다 — `dom.*` 헬퍼가 미발행 op엔 없다는 점 포함해 기록했습니다.

`tools/rpc-allow.mjs`가 `/lua/ops`를 미러링하는 것이 **우리 쪽 게이트**라는 지적도 맞습니다.
발견 가능성과 호출 가능성을 같은 것으로 취급하고 있었습니다. 그 게이트를 손봅니다.

## 2. 게이트 제안 — 채택했고, 즉시 두 건을 잡았습니다

> `inputSelector`의 `contexts.<name>`은 `parameters`가 아니라 `contextAccess.read/write`에 있어야 한다.

그대로 추가했습니다. 처음 돌리자마자 저희 플로우에서 두 가지를 잡았습니다.

```text
community_script.classify: community_classify declares contexts.community as a parameter
community_script.classify: community_classify must declare contextAccess.read community
```

기존 게이트("계약 노드가 선택한 필드는 도구가 선언해야 한다")도 `contexts.*`를 예외로 두도록
고쳤습니다 — 그 규칙의 대상이 아니라는 지적이 정확했고, 두 게이트가 서로 반대를 요구하고 있었습니다.

## 3. R18-1 — 지시대로 적용했는데 컨텍스트가 오지 않습니다

### 3.1 적용한 형태

```yaml
community_classify:
  contextAccess:
    read: [ community ]
  parameters:
    type: object
    additionalProperties: false
    properties:
      requestText: { type: [ string, "null" ] }
  execute:
    kind: runtime
    implementation: lua
    modules: [ "_common.69_rpc_widget", "_common.75_rpc_community" ]
    entry: run
```

`contexts:` 섹션에 `community: ""`가 선언돼 있고, 클라이언트가 **메시지마다** 값을 보냅니다.

### 3.2 관측

스크립트 안에서 `AX_` 접두어를 뺀 모든 전역 이름을 나열했습니다.

```text
_G _VERSION __json_decode __json_encode __rpc __rpc_delivered_to __rpc_fanout
__rpc_now __rpc_sleep args array assert coroutine dom error getmetatable input
ipairs json math memory modules nav next page pairs pcall rawequal rawget rawlen
rawset rpc run select setmetatable sitemap string table tonumber tostring type xpcall
```

**`community`가 없습니다.** `rawget(_G, "community")`도 `nil`입니다.

### 3.3 컨텍스트 자체는 정상적으로 전달되고 있습니다

같은 컨텍스트를 **터미널의 `respond`가 선택하면** 라이브에서 정확히 읽힙니다. 같은 프로필, 같은 턴
구성입니다.

```text
$ send '이 페이지 뭐라고 쓰여 있어?'
이 페이지의 제목은 "AXSDK community fixture page" 입니다.
이 내용은 Fixture Page Reader 1.0.0 의 read_heading 명령으로 읽어왔습니다.
```

이 답변의 내용은 **컨텍스트 블록에만** 존재하는 값입니다. 즉 클라이언트가 보내고 백엔드가
프롬프트까지 나릅니다. 도구 쪽에서만 전역이 없습니다.

### 3.4 요청

**커밋 `1f056e6`이 저희가 쓰는 앱(`browser-extension`)에 배포되어 있는지** 확인 부탁드립니다.

배포되어 있다면 저희 선언이 틀린 것이니, 위 YAML에서 무엇을 고쳐야 하는지 한 줄만 주시면
됩니다. 특히 확인하고 싶은 것:

- `contextAccess`의 위치가 flowTool 최상위(=`parameters`/`execute`의 형제)가 맞습니까?
- 전역 이름이 컨텍스트 이름과 같습니까(`community`), 아니면 다른 namespace 아래입니까?
- 값이 문자열 컨텍스트일 때도 전역으로 옵니까? 회신 예시가 `count`/`first`를 읽는 구조라, 저희처럼
  **문자열 하나**인 컨텍스트에도 같은 경로가 적용되는지 확신이 없습니다.

세 번째가 가장 유력한 오해 지점으로 보입니다. 저희 `community`는 렌더된 텍스트 블록 하나입니다.
구조화된 값이어야 한다면 그렇게 바꾸겠습니다 — 분류기 입장에서도 이름 배열을 받는 편이
렌더링 형식 변화에 강해서 더 낫습니다.

### 3.5 배열 표시 수정 건

> 설치된 스크립트가 없을 때가 `commands: []`입니다 — 첫 줄이 정확히 여러분을 막았을 것입니다.

감사합니다. 다만 저희가 막힌 지점은 그 앞이었습니다 — 전역 자체가 없어서 빈 배열까지 가지
못했습니다. 위 배포 확인이 끝나고 컨텍스트가 도착하면, 설치 0건 상태를 회귀 항목으로 함께
확인하겠습니다.

## 4. 현재 상태

| | |
|---|---|
| 라이브 동작 | 서명 릴리스 설치·검증·캐시 → `chrome.userScripts` 등록 → 핸드셰이크 → 인자 없는 read 사전 실행 → **단일 턴 자연어 답변** |
| 분류기 | 작성·테스트 완료(18개, 뮤테이션 3건). 컨텍스트가 도착하는 즉시 붙습니다 |
| 확인 위젯 | 렌더러·확장 AX 경로 완료(테스트·뮤테이션 검증). 제안 트리거만 대기 |
| 게이트 | `check:flows` **188** (제안하신 규칙 포함) · `test:lua` 575 · extension 1028 |

R18-1 회신 전까지는 R18-2 방향(클라이언트 op + grant)을 먼저 진행하겠습니다. 그 경로가 되면
제안 절차 자체가 없어져 이 문제를 우회하는 것이 아니라 **불필요하게** 만듭니다.
