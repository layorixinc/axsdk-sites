# CWS 제출 — 대시보드 입력 내용과 입력 결과

> **상태 (2026-08-29): 키워드 스팸 사유로 1차 심사 거부 · 영문/국문 설명을 CWS에 저장 완료 · 재제출 대기.**
> 영문·국문 상세 설명에서 제3자 마켓플레이스 이름 목록을 삭제했고, 장바구니를 지원하지 않는 스토어도
> 브랜드 이름 없이 정확히 설명하도록 한 문장을 다듬었습니다. 실제 대시보드에 저장한 뒤 페이지를 다시
> 불러와 저장값을 원본과 비교했습니다: EN 1,669자 / KO 862자, 둘 다 정확히 일치, 이름 목록 0건.
> 기능, 권한, ZIP은 바뀌지 않았고 **`제출하여 검토받기` 버튼은 누르지 않았습니다.**

| 탭 | 넣은 것 | 1차 제출 때 다시 읽어 확인한 값 |
|---|---|---|
| 패키지 | 릴리스 ZIP | 제목이 `AXSDK Assistant (CDP)` → **`AXSDK 쇼핑 어시스턴트`**로 바뀜(요약도 매니페스트 `_locales`에서 옴) |
| 등록정보 en | 설명·카테고리·URL 2개·아이콘·스크린샷 | 설명 **1,762자** · 쇼핑 · 아이콘 128×128 · 현지화 4장 · 공통 4장 · 타일 1 |
| 등록정보 ko | 설명·스크린샷 | 설명 **938자** · 현지화 4장 |
| 개인정보 | 전용 목적 · 권한 사유 8칸 · 원격 코드 | 213 / 137·307·**987**·185·183·226·119·378 / 459자 |
| 개인정보 | 데이터 사용 · Limited Use | 체크된 항목 **정확히 5개**(사용자 활동 · 웹사이트 콘텐츠 + 인증 3) |
| 개인정보 | 처리방침 URL | `…/privacy.html` |
| 배포 | 무료 · 미등록 · 전체 지역 | 라디오 상태로 확인 |
| 설정 | 연락처 이메일 | `support@layorix.ai` — **확인됨** |

공개 URL도 실제 응답을 확인했습니다: `/` 200 (5,612 B) · `/support.html` 200 (8,065 B) ·
`/privacy.html` 200 (15,113 B).

입력 중 알게 된 세 가지, 다음 사람을 위해:

1. **제목과 짧은 설명은 대시보드 입력칸이 아니다.** 매니페스트의 `name`/`description`(여기서는
   `__MSG_extName__` / `__MSG_extDescription__` + `_locales/en|ko`)에서 오고, 대시보드는 그것을 읽기
   전용으로 보여준다. 구버전 패키지가 올라가 있으면 옛 문구가 그대로 보이므로 **ZIP 업로드가 1순위**다.
2. **권한 사유 칸은 1,000자 제한**이다(`store/permissions.md` 참조). `debugger` 문단이 1,108자여서
   붙여넣을 수 없었고, 987자로 줄였다.

3. **마켓플레이스 이름을 카탈로그처럼 나열하면 키워드 스팸으로 판단됩니다.** 2026-08-29 실제 심사에서
   영문·국문 설명의 지원 스토어 목록이 그대로 지목됐습니다. 기능은 “사용자가 고른 지원 스토어를
   비교한다”는 본문으로 이미 설명되므로, 브랜드 목록은 삭제하고 다른 표현으로 우회해 다시 넣지 않습니다.


---

## 원본 문구 (재입력용)

작성 2026-08-27 · 상세 설명 정정 2026-08-29. 모든 문구는 이 저장소의 확정 문서에서 그대로
가져왔습니다(새로 만든 값 없음). 검증: `npm run check:listing` **미결 0건**, 짧은 설명 EN 116자 /
KO 64자(제한 132), 정정 상세 설명 EN 1,669자 / KO 862자.

1차 제출 ZIP: `dist/axsdk-extension-cdp-cws.zip` (8.22 MiB). 이번 설명 정정에는 재업로드하지 않습니다.

---

## 0. 순서

아래는 초기 제출 순서입니다. **이번 정정은 2번의 영문·국문 상세 설명만 교체하고 저장한 뒤 5번을
실행합니다.** 패키지, 개인정보, 배포, 그래픽은 건드리지 않습니다.

1. **Package** 탭 — ZIP 업로드
2. **Store listing** 탭 — 이름 · 짧은 설명 · 상세 설명 · 카테고리 · 언어 · 스크린샷 4장 · 프로모 타일 · URL 3개
3. **Privacy** 탭 — 단일 목적 · 권한 사유(8칸) · 원격 코드 · 데이터 사용 공시 · Limited Use 확약
4. **Distribution** 탭 — Unlisted · 전체 지역
5. 저장 → **Submit for review**

---

## 1. Store listing 탭

### 이름 (Name)

```
AXSDK Shopping Assistant
```

### 짧은 설명 (Short description · 132자 제한)

한국어 리스팅으로 제출하는 경우:

```
여러 쇼핑몰의 배송비 포함 총액을 한 번에 비교하고, 고른 상품을 장바구니까지 담아 줍니다. 주문은 하지 않습니다.
```

영어로 제출하는 경우:

```
Compares total cost with shipping across stores, then adds the product you chose to that store's cart. Never orders.
```

### 상세 설명 (Detailed description)

한국어:

```
같은 상품이 어느 스토어에서 실제로 더 싼지 알려면 배송비까지 더해 봐야 합니다. AXSDK는 그 계산을 대신
합니다.

무엇을 하나요
· 요청한 상품을 지원 스토어에서 찾고, 상품가와 배송비를 더한 총액으로 나란히 비교합니다
· 같은 제조사 모델인지 확인한 뒤 비교합니다 — 액세서리나 다른 모델이 섞이지 않습니다
· 배송비를 알 수 없는 행은 0원으로 가정하지 않고 "미확인"으로 접어 두고, 몇 건이 접혔는지 알려줍니다
· 조건을 말하면(예: "3만원 이하만", "평점 높은 순") 그 자리에서 다시 정리합니다
· 장바구니를 지원하는 스토어에서는 고른 상품을 담고, 장바구니 페이지에서 상품이 맞는지 다시 확인합니다
· 결제 화면까지 안내하고 멈춥니다

무엇을 하지 않나요
· 주문하지 않습니다. 결제하지 않습니다. 결제수단을 읽거나 저장하지 않습니다
· 로그인 폼과 결제 필드를 채우지 않습니다
· 봇 확인 화면을 우회하지 않습니다 — 그 사실을 알리고 멈춥니다
· 에이전트 탭 그룹 밖의 탭은 읽지 않습니다

어떻게 동작하나요
브라우저가 이미 여는 페이지를 읽습니다. 에이전트는 사용자가 만든 전용 탭 그룹 안에서만 동작하고,
동작 중에는 Chrome이 직접 상단에 알림 배너를 띄웁니다. 되돌릴 수 없는 동작 앞에서는 버튼의 실제 문구를
읽어 확인을 받습니다.

이 릴리스는 AXSDK 계정(API 키)이 있는 사용자를 위한 비공개 배포입니다. 소비자 로그인은 준비 중이며,
그때까지는 옵션 화면에서 키를 입력합니다.

개인정보: https://layorixinc.github.io/axsdk-sites/privacy.html
지원: https://layorixinc.github.io/axsdk-sites/support.html
```

영어:

```
Knowing which store is actually cheaper means adding the shipping fee. AXSDK does that arithmetic for you.

What it does
· Finds the product you asked for on supported stores and compares them by price + shipping = total
· Verifies the manufacturer model before comparing, so accessories and other models do not slip in
· Never assumes a missing shipping fee is zero: rows whose total is unknown are folded away and counted,
  and shown when you ask for them
· Re-sorts or filters the same list when you say what you want ("cheapest first", "under 30,000", "free
  shipping only")
· When the selected store supports a cart, adds the product you picked, then re-reads the cart page to
  confirm it is there
· Takes you to the checkout review page and stops

What it does not do
· It never places an order, never pays, and never reads or stores a payment method
· It does not fill login forms or payment fields
· It does not bypass bot checks — it tells you it hit one and stops
· It does not read tabs outside the agent tab group you created

How it works
It reads the pages your browser already opens. The agent only operates inside a dedicated tab group you
create, and Chrome itself shows a banner across the top for as long as it is attached, which you can stop
at any time. Before anything irreversible it reads the actual label on the button and asks.

This release is an unlisted distribution for users who already have an AXSDK account (API key).
Consumer sign-in is coming; until then the extension asks for a key in its options page.

Privacy: https://layorixinc.github.io/axsdk-sites/privacy.html
Support: https://layorixinc.github.io/axsdk-sites/support.html
```

### 카테고리 · 언어

| 칸 | 값 |
|---|---|
| Category | Shopping |
| Language | 한국어 (스크린샷·위젯이 한국어이므로 리스팅 언어도 한국어) |

### 그래픽

| 칸 | 파일 | 규격 |
|---|---|---|
| 스토어 아이콘 | 패키지 내 `assets/icon-128.png` | 128×128 |
| 스크린샷 1 | `store/assets/ko/1-comparison.png` | 1280×800 |
| 스크린샷 2 | `store/assets/ko/2-refine.png` | 1280×800 |
| 스크린샷 3 | `store/assets/ko/3-choices.png` | 1280×800 |
| 스크린샷 4 | `store/assets/ko/4-cart.png` | 1280×800 |
| 작은 프로모 타일 | `store/assets/tile-small.png` | 440×280 |

### URL

| 칸 | 값 |
|---|---|
| Homepage URL | `https://layorixinc.github.io/axsdk-sites/` |
| Support URL | `https://layorixinc.github.io/axsdk-sites/support.html` |
| Privacy policy URL | `https://layorixinc.github.io/axsdk-sites/privacy.html` |

> GitHub Pages: 저장소 **Settings → Pages → Deploy from a branch → `main` / `/docs`**. 이 세 URL이
> 200으로 열려야 제출이 통과합니다.

---

## 2. Privacy 탭

### 단일 목적 (Single purpose) — 한 줄

```
Compare one product's total cost including shipping across supported online stores, then add the product the user picked to that store's cart and take them to its checkout review. It never places an order or pays.
```

한국어로 넣는 경우:

```
지원하는 온라인 쇼핑몰에서 한 상품의 배송비 포함 총액을 비교하고, 사용자가 고른 상품을 장바구니에 넣고 결제 화면까지 안내한다. 주문이나 결제는 하지 않는다.
```

### 권한 사유 (각 칸에 해당 문단을 붙여넣기)

#### `debugger`

```
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
```

#### 호스트 권한 `http://*/*`, `https://*/*`

```
**Not the page boundary.** Needed for exactly two things: `fetch` from the extension service worker to
the backend (`api.axsdk.ai`), and one `declarativeNetRequestWithHostAccess` rule that attaches the
extension origin to those backend requests. The page boundary is the agent tab group above. The list of
supported stores ships inside the package and is not refreshed remotely.
```

#### `storage`

```
Settings (backend credentials), the conversation, and
execution traces — all in local browser storage. `chrome.storage.sync` is not used.
```

#### `tabGroups`

```
A session IS a tab group: the extension creates a dedicated one and treats only its members as
addressable. Without this permission the "only inside this group" boundary cannot exist.
```

#### `scripting`

```
Injects the activity indicator and the page widget into an **isolated** world. Nothing is injected into
the page world.
```

#### `offscreen`

```
Runs the agent runtime in a worker inside an offscreen document (`reasons: [WORKERS]`), one worker per
session, so work in progress is not cut off when the MV3 service worker goes idle.
```

#### `userScripts`

```
The channel for running user-selected scripts in a dedicated `USER_SCRIPT` world. **This release ships no
path that fetches a script**: what can execute is packaged in the extension and hash-verified. Letting
users install their own scripts is a later update, and this justification will be updated with it.
```

#### `declarativeNetRequestWithHostAccess`

```
One dynamic rule: it attaches the extension origin header to backend requests. It is not used to block
ads or trackers or to modify page content; the rule is derived in code from the backend URL and the
extension's own origin.
```

### 원격 코드 사용 (Are you using remote code?)

**아니요 (No, I am not using remote code)** 를 선택하고, 설명 칸에:

```
This release packages all executable logic (flows, Lua modules, site data) inside the extension and
verifies it by SHA-256 on every service-worker start. Remote source switches default to off, the options
page exposes no control for them, and a build gate refuses a tree that reintroduces one.

The package still contains a Lua interpreter (Fengari) and development-time remote-loader code. No
reachable path executes remote code, but those bytes are present.
```

### 데이터 사용 공시 (Data usage) — 체크 상태

| 항목 | 선택 | 근거 |
|---|---|---|
| Personally identifiable information | ☐ 아니요 | 이름·이메일·전화·주소를 저장하는 기능이 없음 |
| Health information | ☐ 아니요 | 해당 기능 없음 |
| Financial and payment information | ☐ 아니요 | 결제는 스토어 페이지에서 사용자가 진행, 확장은 **주문하지 않음** |
| Authentication information | ☐ 아니요 | 자격증명을 읽거나 저장하지 않음 |
| Personal communications | ☐ 아니요 | 해당 기능 없음 |
| Location | ☐ 아니요 | 해당 기능 없음 |
| Web history | ☐ 아니요 | 방문 이력을 수집하지 않음 — 사용자가 지목한 페이지만 읽음 |
| **User activity** | ☑ **예** | 세션과 메시지가 백엔드에 **30일** 보관된 뒤 삭제 |
| **Website content** | ☑ **예** | 비교·담기를 위해 사용자가 지목한 스토어 페이지의 상품명·가격·배송비를 읽음 |

보관/삭제 문구가 필요한 칸에는:

```
Sessions and messages are kept 30 days, then deleted. Deletion requests go to support@layorix.ai and are completed within 7 business days.
```

### Limited Use 확약 — 세 항목 모두 체크

1. ☑ 공시한 단일 목적 외 사용 없음
2. ☑ 제3자 전송/판매 없음 (광고·프로파일링·데이터 브로커 없음)
3. ☑ 사람의 접근은 사용자 요청·보안·법적 요구·집계 익명화에 한정

### 하위 처리자(모델 공급자) — 물어보는 칸이 있을 때

| 항목 | 값 |
|---|---|
| 사업자 | OpenRouter |
| 모델 | `openai/gpt-oss-120b` |
| BYOK | 사용자가 자기 키를 넣으면 그 공급자로 전달 (개인정보 문서에 공시됨) |

---

## 3. Distribution 탭

| 칸 | 값 | 근거 |
|---|---|---|
| Visibility | **Unlisted** | 결정 D3 = c (2026-08-26). 검색·목록에 노출되지 않고 URL을 아는 사람만 설치 |
| 지역 | All regions | `store/listing.md` |
| 가격 | 무료 | |

---

## 4. 제출 전 마지막 확인 (제가 이미 통과시킨 것)

| 확인 | 상태 |
|---|---|
| `npm run check:listing` 미결 답변 | **0건** |
| 스크린샷 4장 1280×800 · 타일 440×280 | PNG 헤더로 확인 |
| 패키지에 원격 소스 경로 없음 | `assertNoRemoteSourceCode` 통과 |
| URL 설치 표면 제거됨 | `assertNoUrlInstallSurface` 통과 |
| 실제 턴으로 동작 증명 | `test:cws:artifact` PASS (비교·정제·취소·담기·결제검토 무주문·삭제) |
| 백엔드 모듈 정합 | `release:cws` — backend revision 144와 해시 일치 |

제출 후 심사 의견이 오면 그 문장을 그대로 주십시오 — 어느 산출물을 고쳐야 하는지 대응시켜 드립니다.
