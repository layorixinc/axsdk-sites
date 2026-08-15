# Agentic 확장 경쟁 리서치

스토어 리스팅 실측(2026-08-06). 앞선 문서에서 ShopAI Assistant를 "가장 가까운 경쟁"으로 적었는데,
사용자 확인 결과 **Shopify 사이트 안에서만 동작**한다. 그 판단은 리스팅 설명만 보고 내린 것이었고
**틀렸다**. 실제로 여러 사이트에 걸쳐 다단계 작업을 수행하는 확장들을 다시 조사했다.

---

## 1. 실측 데이터

### 범용 agentic (다단계·모든 사이트)

| 확장 | 사용자 | 평점 | 크기 | 갱신 | 가격 |
|---|---|---|---|---|---|
| **dassi** (Omnify Labs) | **20,000** | **4.9** (106) | **9.86 MiB** | **2026-08-06** | $10/월, BYO 키 |
| **Do Browser** | 10,000 | **3.3** (60) | 2.33 MiB | 2026-07-22 | $25/월, BYO 키 |
| Claude in Chrome (Anthropic) | — | — | — | 2026 | Claude 구독 포함 |
| Minded | — | 5.0 | — | — | 화면 녹화 학습형 |
| Autopilot Browser Automation | — | 5.0 | — | — | 음성 안내형 |
| Agent OS | — | — | 477 KiB | 2026-05-07 | 인앱 결제 |
| Bardeen | — | — | 6.77 MiB | 2026-06-19 | 인앱 결제 |

### 쇼핑 특화 (대부분 단일 사이트 또는 단순 조회)

| 확장 | 성격 |
|---|---|
| ShopAI Assistant | **Shopify 내부 전용**(사용자 확인). 28 users |
| Product Search / Goodscouter / Cheaperly | 이미지·키워드로 유사 상품 조회 |
| Amazon Europe Price Compare | 아마존 국가별 비교 |
| AliSmart | AliExpress 중심 + Temu·Amazon·eBay 비교 |
| Dotti / BuyScout / ShopGuru | 가격 추적·리뷰 요약 |

---

## 2. dassi가 가장 참고할 만하다

20,000 사용자, 4.9점, **Featured**, 배지 둘: *"good record with no history of violations"* +
***"Follows recommended practices for Chrome extensions"***. 오늘(2026-08-06)도 갱신됐다.

리스팅에서 읽히는 것:

- **"dassi asks for confirmation before taking important actions"** — 우리 "번호를 고르는 턴이 승인
  턴"과 같은 패턴이다. 이 범주가 심사에서 살아남는 방식이다.
- **Skills & slash commands** — 자주 쓰는 프롬프트를 재사용 단위로 저장. 우리 flows와 목적이 겹친다.
- **6개 언어에 한국어 포함.** 다만 범용 에이전트다.
- 회사 주소를 리스팅에 노출(San Jose, CA). Non-trader 표기.

---

## 3. 우리에게 의미 있는 발견 넷

### 3.1 9.86 MiB가 통과한다 — 그것도 Featured로

`CWS_LAUNCH_PLAN.md` P0-5에서 "번들이 커지면 심사가 길어진다"고 적었다. 사실이지만 **거부 사유는
아니다.** dassi는 9.86 MiB이고 Featured이며 오늘도 갱신했다. Bardeen 6.77 MiB, Do Browser 2.33 MiB.

**Lua 인터프리터 + 번들 Lua로 커지는 것 자체는 이 범주에서 정상이다.** P0-1의 번들 해법에 대한
크기 우려는 낮춰도 된다. 남는 것은 심사 시간이지 통과 여부가 아니다.

### 3.2 dassi의 "데이터 미수집" 선언은 코드와 맞지 않는다 (2026-08-06 정적 검증)

dassi는 페이지를 읽어 LLM에 보내면서도 스토어에 **"수집·사용하지 않음"**으로 선언되어 있고,
리스팅 본문도 *"No conversation logs kept"*라고 적는다. 처음에는 아키텍처로 설명된다고 봤다 —
BYO 키면 브라우저에서 공급자로 직접 가고 중간 서버가 없으니까.

**그 설명은 틀렸다.** 0.51.4 번들을 뜯어 확인한 결과, 프로바이더 모드와 무관하게 GA4
(`google-analytics.com/mp/collect`)로 다음이 나간다: **사용자 프롬프트 원문 최대 300자**
(`user_prompt`), **모델 응답 원문 최대 300자**(`assistant_response`), 방문 페이지 **호스트명**
(`agent_run_start.page_hostname`), 툴 사용 이력(`tool_use`). 옵트아웃 키는 존재하지 않는다.
`client_id`는 Google 계정 id의 SHA-256, `user_id`는 계정 UUID라 개인 단위로 결합된다.
발신부는 오프스크린 워커가 이벤트 **이름 문자열**을 `sw-action`/`trackAnalytics`로 보내고
서비스 워커가 그대로 GA4 큐에 넣는 경로다. 근거: `D:/PROJECTS/researches/dassi-analysis/REVERIFICATION.md` §B.

세 가지가 따라 나온다:

1. **BYO 키는 미수집 선언의 근거가 되지 못한다.** 대화가 공급자로 직행해도 텔레메트리는 따로 나간다.
   우리가 BYO 키 모드를 얹더라도 같은 선언을 얻지는 못한다 — 선언을 만드는 것은 아키텍처가 아니라
   **전송 목록 전체**다.
2. 우리는 백엔드를 경유하므로 어차피 **수집으로 공시해야 한다.** 2026-08-01 개정으로 수집 데이터는
   "공시된 단일 목적에 엄격히 필요"해야 하므로, 우리 GA/로그 항목도 같은 기준으로 세어 둘 것.
3. **Featured + "위반 이력 없음" 배지는 공시 정확성을 보증하지 않는다.** 심사는 코드와 선언을
   대조하지 않는다. 경쟁사 공시를 벤치마크로 삼는 것 자체가 위험하다 — 베끼면 같은 노출을 진다.

### 3.3 "코드를 생성해 실행한다"는 확장들 — 추측을 실측으로 교체

Do Browser(10,000 사용자, 위반 이력 없음 배지)는 **코드를 생성해 실행한다고 리스팅에 적어 두었다.**
초판은 가능한 설명 셋을 세워 두고 어느 쪽인지 모른다고 했다. **dassi를 뜯어서 답이 나왔다** — 셋 중
둘이 실제로 쓰이고 있고, 세 번째까지 합쳐 **정책이 명시한 면제 채널 전부**를 쓴다.

| dassi가 실행하는 동적 코드 | 어디서 | 면제 조항 |
|---|---|---|
| LLM이 쓴 JS + 공개 CDN 6곳의 npm 패키지 (`repl`) | `sandbox.html` (`new AsyncFunction`) | 샌드박스 컨텍스트 |
| LLM이 쓴 JS (`javascript_exec`) | 대상 페이지 (`chrome.debugger` → `Runtime.evaluate`) | **Debugger API** |
| LLM이 쓴 JS (`user_script_create`) | 임의 사이트 MAIN world, 영구 (`chrome.userScripts.register`) | **User Scripts API** |

**그리고 그 샌드박스는 완전 격리가 아니다.** `sandbox/bootstrap.js`가
`postMessage({method:"tool", payload:{name, params}})`로 **38개 툴 레지스트리 전체**를 부를 수 있게
열어 둔다 — `javascript_exec` 포함. 매개된 채널로 확장 능력에 닿는데도 통과했다.

> **[INFERENCE] 초판 판단을 절반 수정한다.** 초판은 "샌드박스 면제는 우리를 구하지 못한다"고 단정했다.
> 정확히는 **두 문제 중 하나만 없앤다**:
> - 없애 주는 것: *"확장 API를 부르는 인터프리터"* — 샌드박스로 옮기고 고정 op 어휘로만 호스트를
>   부르면 dassi의 `repl`과 구조가 같아진다. 이것이 `CWS_LAUNCH_PLAN.md`의 **M1-B**다.
> - 남는 것: 우리 Lua는 **제품의 동작 그 자체**다. dassi가 실행하는 건 모델이 그 자리에서 쓴 일회성
>   코드이고 제품 동작은 전부 패키지 안에 있다. §1의 *"기능이 제출된 코드에서 파악되어야 한다"*는
>   요구는 위치를 바꿔도 남는다.
>
> 그래서 M1-B는 **선례 있는 방어 가능한 경로**이지 확실한 경로가 아니다. 그리고 §3.2가 보여주듯
> **dassi 통과는 정책 허용의 증거가 아니다** — 같은 확장이 공시를 틀리게 하고도 Featured다.

### 3.4 우리 자리는 비어 있다

- **범용 agentic**(dassi, Do Browser, Claude in Chrome)은 "무엇이든 하는" 도구다. 쇼핑은 예시 중 하나.
- **쇼핑 특화**는 단일 사이트이거나(ShopAI=Shopify, Amazon Europe=아마존) 단순 조회다.
- **한국 커머스 10곳을 배송비 포함 총액으로 비교하고, 사용자가 고른 하나로 이동시키는 에이전트는
  이 목록에 없다.**

그리고 Do Browser 3.3점 vs dassi 4.9점의 차이가 시사하는 바가 있다. 이 범주의 사용자 불만은 기능이
아니라 **신뢰성**에서 나온다. 에이전트가 틀린 값을 자신 있게 말하면 곧바로 별점이 된다.

> 이 저장소가 세션 내내 붙들었던 규칙 — *"비교에서 잘못된 숫자는 빠진 행보다 나쁘다"*, *"없는 절약을
> 만들어내지 않는다"*, *"봇월은 우회하지 않고 표면화한다"* — 은 마침 이 시장의 실패 지점을 정확히
> 겨냥한다. 차별점은 "AI가 비교한다"가 아니라 **"틀리지 않는다"**여야 한다.

---

## 4. 반영할 것

| 문서 | 수정 |
|---|---|
| `SITE_DATA_SPLIT_DESIGN.md` 부록 | ShopAI를 "가장 가까운 경쟁"이 아니라 **Shopify 전용**으로 정정. 리스팅 문구 참고 가치는 유효 |
| `CWS_LAUNCH_PLAN.md` P0-5 | 번들 크기 우려 완화 — 9.86 MiB가 Featured로 통과한다 |
| `CWS_LAUNCH_PLAN.md` P0-3 | 단일 목적: 경쟁사는 "AI 브라우저 자동화"(Workflow & Planning)로 넓게 잡거나 쇼핑으로 좁게 잡는다. 우리는 **쇼핑 쪽 좁은 목적**이 유리하다 — 견적·메모리 플로우가 그 밖으로 나간다 |
| 제품 | BYO 키 모드가 데이터 공시 부담을 구조적으로 줄인다 **[확인필요]** |
