# 권한 소명 (Privacy practices → Permissions justification)

대시보드는 매니페스트가 선언한 권한마다 한 칸을 준다. 아래 문단을 그대로 붙인다. 문장의 근거는 전부
실측이며, 심사자가 재현할 수 있는 것만 적었다.

단일 목적: `store/single-purpose.md`.

---

## English

Paste each paragraph into the matching field. Every claim is measured and reproducible by the reviewer.
Single purpose: `store/single-purpose.md`.

### `debugger`

Every page read, click and keystroke this extension performs travels this channel. It injects no content
script into the page world; it uses the DevTools protocol `DOM`, `Runtime` and `Page` domains to read the
values it needs. The evaluated expressions are code shipped inside the extension, never text fetched at
runtime.

Two bounds apply. First, only tabs in the **agent tab group the user created** are addressed — a normal
browser group is never adopted wholesale; the starting tab is moved into a dedicated group and other tabs
join only when the user visibly drags them in. Second, before an irreversible action (adding to a cart,
submitting a form) the extension reads the button's actual label and asks for confirmation.

Chrome discloses this permission at install as *"Read and change all your data on all websites"* and
keeps its own debugging banner visible for the whole session, from which the user can stop it instantly.

`chrome.scripting` cannot express this product: one task crosses several stores, each with tab
navigations and reloads, and the state has to survive them as one session.

### `host_permissions` (`http://*/*`, `https://*/*`)

**Not the page boundary.** Needed for exactly two things: `fetch` from the extension service worker to
the backend (`api.axsdk.ai`), and one `declarativeNetRequestWithHostAccess` rule that attaches the
extension origin to those backend requests. The page boundary is the agent tab group above. The list of
supported stores ships inside the package and is not refreshed remotely.

### `storage`

Settings (backend credentials), the conversation, and
execution traces — all in local browser storage. `chrome.storage.sync` is not used.

### `tabGroups`

A session IS a tab group: the extension creates a dedicated one and treats only its members as
addressable. Without this permission the "only inside this group" boundary cannot exist.

### `scripting`

Injects the activity indicator and the page widget into an **isolated** world. Nothing is injected into
the page world.

### `offscreen`

Runs the agent runtime in a worker inside an offscreen document (`reasons: [WORKERS]`), one worker per
session, so work in progress is not cut off when the MV3 service worker goes idle.

### `userScripts`

The channel for running user-selected scripts in a dedicated `USER_SCRIPT` world. **This release ships no
path that fetches a script**: what can execute is packaged in the extension and hash-verified. Letting
users install their own scripts is a later update, and this justification will be updated with it.

### `declarativeNetRequestWithHostAccess`

One dynamic rule: it attaches the extension origin header to backend requests. It is not used to block
ads or trackers or to modify page content; the rule is derived in code from the backend URL and the
extension's own origin.

### Remote code field

This release packages all executable logic (flows, Lua modules, site data) inside the extension and
verifies it by SHA-256 on every service-worker start. Remote source switches default to off, the options
page exposes no control for them, and a build gate refuses a tree that reintroduces one.

The package still contains a Lua interpreter (Fengari) and development-time remote-loader code. No
reachable path executes remote code, but those bytes are present.

## 한국어

## `debugger`

이 확장의 페이지 읽기·클릭·입력이 전부 이 통로로 이뤄집니다. 콘텐츠 스크립트를 페이지 세계에 주입하지
않고, DevTools 프로토콜의 `DOM`·`Runtime`·`Page` 도메인으로 필요한 값만 읽습니다. 평가되는 표현식은
**확장에 포함된 코드**이며 원격에서 받아온 텍스트가 아닙니다.

범위는 두 가지로 제한됩니다. 첫째, **사용자가 만든 에이전트 탭 그룹의 탭**만 대상입니다 — 일반 탭 그룹을
통째로 편입하지 않고, 시작한 탭을 전용 그룹으로 옮기며, 다른 탭은 사용자가 눈에 보이게 끌어 넣을 때만
합류합니다. 둘째, 되돌릴 수 없는 동작(장바구니 담기, 폼 전송) 앞에는 **버튼의 실제 문구를 읽어** 확인을
요구합니다.

Chrome은 이 권한을 설치 시점에 *"Read and change all your data on all websites"*로 공시하고, 세션이
붙어 있는 동안 **브라우저 자체 배너**를 계속 띄우며 사용자가 그 배너에서 즉시 중단할 수 있습니다. 즉
사용자는 무엇을 허용했는지 알고, 언제든 회수할 수 있습니다.

`chrome.scripting`으로는 이 제품이 성립하지 않습니다: 여러 스토어를 오가는 한 번의 작업이 탭 이동과
페이지 재로드를 거치며 상태를 유지해야 하고, 그 흐름을 하나의 세션으로 붙잡는 것이 이 API입니다.

## `host_permissions` (`http://*/*`, `https://*/*`)

**페이지 접근 경계가 아닙니다.** 두 가지 용도로만 필요합니다.

1. 확장 서비스워커에서 백엔드(`api.axsdk.ai`)로의 `fetch`.
2. `declarativeNetRequestWithHostAccess` 규칙 **한 건** — 백엔드 요청에 확장 오리진을 붙이기 위한 것.

페이지에 대한 실제 경계는 위에 적은 에이전트 탭 그룹입니다. 지원 스토어 목록은 확장 패키지에 포함된
사이트 인덱스에 있고, 이 목록은 원격에서 갱신되지 않습니다.

## `storage`

설정(백엔드 자격 정보), 대화 기록, 실행 흔적을 브라우저 로컬에
둡니다. 원격 동기화를 사용하지 않습니다(`chrome.storage.sync` 미사용).

## `tabGroups`

에이전트 세션의 단위가 탭 그룹입니다. 전용 그룹을 만들고, 그 그룹의 구성원만 조작 대상으로 삼기 위해
필요합니다. 이 권한이 없으면 "이 그룹 안에서만"이라는 경계를 만들 수 없습니다.

## `scripting`

활동 표시(무엇이 실행 중인지 알리는 오버레이)와 페이지 상단 위젯을 **격리된 세계**에 주입합니다.
페이지 세계(MAIN world)에는 주입하지 않습니다.

## `offscreen`

에이전트 런타임을 오프스크린 문서의 워커에서 실행합니다(`reasons: [WORKERS]`). 세션마다 워커 하나이며,
MV3 서비스워커가 유휴로 종료되는 동안에도 진행 중인 작업이 끊기지 않게 하기 위한 것입니다.

## `userScripts`

사용자가 선택한 스크립트를 전용 `USER_SCRIPT` 월드에서 실행하기 위한 채널입니다. **이번 릴리스에서는
원격 스크립트 취득 경로가 없고**, 실행 대상은 확장 패키지에 포함되어 해시로 검증된 것뿐입니다. 사용자가
직접 스크립트를 설치하는 기능은 다음 업데이트에서 활성화되며, 그때 이 소명을 갱신합니다.

## `declarativeNetRequestWithHostAccess`

동적 규칙 **한 건**입니다: 백엔드 요청에 확장 오리진 헤더를 붙입니다. 광고·추적 차단이나 콘텐츠 변경에
사용하지 않으며, 규칙은 코드에서 백엔드 URL과 확장 오리진으로부터 생성됩니다.

---

## Remote code 칸

이번 릴리스는 실행 가능한 모든 로직(플로우, Lua 모듈, 사이트 데이터)을 **확장 패키지에 포함**하고,
서비스워커가 시작될 때마다 SHA-256으로 검증합니다. 원격 소스 스위치는 기본 꺼짐이고 옵션 페이지에 그
컨트롤이 없으며, 빌드 게이트가 그 상태를 고정합니다.

패키지에는 Lua 인터프리터(Fengari)와, 개발용 원격 로더 코드가 여전히 컴파일되어 있습니다. 도달 가능한
경로로는 실행되지 않지만 바이트에는 존재합니다.

<!-- 확정 2026-08-27: D7(One Stop 문의)은 생략으로 결정됐다 — 비공개(Unlisted) 심사가 더 빠른 답이므로
     기다릴 답변이 없다. 이 칸은 위 문구로 제출한다. -->
