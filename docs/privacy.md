---
layout: default
title: 개인정보 처리방침 — AXSDK 확장
---

# 개인정보 처리방침 (Chrome 확장)

[English](#english) · [한국어](#한국어)

AXSDK 회사 전체 방침이 아니라 **이 확장이 하는 일만** 적는다. Chrome Web Store 리스팅의 개인정보
처리방침 URL이 이 페이지를 가리킨다.

이 확장의 목적은 하나다:

> 지원하는 온라인 쇼핑몰에서 한 상품의 배송비 포함 총액을 비교하고, 사용자가 고른 상품을 장바구니에
> 넣고 결제 화면까지 안내한다. 주문이나 결제는 하지 않는다.

아래의 모든 수집 항목은 그 목적에 필요한 것뿐이다.

최종 갱신: 2026-08-26 · 확장 버전 0.1.0

---

## English

This describes **only what the extension does** — not AXSDK company practices in general. The Chrome Web
Store listing's privacy policy URL points here.

Purpose:

> Compare one product's total cost including shipping across supported online stores, then add the
> product the user picked to that store's cart and take them to its checkout review. It never places an
> order or pays.

Everything collected below is needed for that.

### What is collected

The agent operates only in tabs inside **the agent tab group you created**. Tabs outside it, other
windows and other profiles are not read.

| Item | What it is | Why |
|---|---|---|
| Page content (partial) | Product title, price, shipping fee, rating, review count and stock wording read from the tabs the agent drives | Comparing totals requires reading the numbers printed on the card |
| Page address | The URL of that tab and the product identifier | To tell products and stores apart, and to re-verify the same product before it is added to a cart |
| Conversation | Your requests and the assistant replies | To interpret the request and choose the next step |
| Execution trace | Which tool ran in what order, and error codes | So a failure can say what failed |

**Not collected**: passwords, payment methods and card numbers are neither read nor stored; login and
payment fields are not filled. A login wall or bot check is reported and the run stops. Full browsing
history, other tabs, bookmarks and cookies are not collected.

### Where it goes

1. **The AXSDK backend (`api.axsdk.ai`)** receives the conversation and the page-derived values needed to
   choose the next step, passes them to a language model to decide, and returns that decision.
2. **The language-model provider** receives data only through the backend; the extension never contacts a
   model provider directly.
3. **The store you are shopping** receives your search terms and the cart addition you approved — which is
   what a browser does anyway.

Data is **not sold**, not used for advertising or profiling, and not given to data brokers. This extension
contains no affiliate links and injects no tracking parameters (that code was deleted from the product on
2026-08-18).

### How long it stays

| Where | What | For how long |
|---|---|---|
| Local browser storage | Conversations, traces, settings | Until you clear them; removed with the extension |
| Local browser storage | Values you **explicitly asked** to remember (name, email, phone, postal code) | Until you ask to delete them |
| AXSDK backend | Sessions and messages | <!-- BIZ-CONFIRM: retention period --> |

Memory is written **only on an explicit request**. Without a phrase like "remember this", a value that
appears in conversation is not stored — this is enforced in code and pinned by tests.

### How to delete it

- **Conversation and memory**: clear them in the extension options, or ask in conversation ("forget my
  phone number") — the assistant lists what matches and deletes what you confirm.
- **Everything local**: removing the extension removes it.
- **Backend copies**: <!-- BIZ-CONFIRM: deletion request channel and turnaround -->

### Permissions

See `store/permissions.md` for the full field-by-field justification. In short: `debugger` is how pages
are read and driven, and Chrome both discloses it at install and shows a banner while it is in use; the
broad host permission is for backend access and one network rule, not for page reach.

### Children and sensitive data

Not directed at children under 13. No health, financial, biometric, political or religious data is
collected.

### Limited Use

This extension complies with the Chrome Web Store **Limited Use** requirements:

1. Data collected is used only as needed for the single purpose disclosed above.
2. It is **not sold** to third parties.
3. It is not used or transferred for advertising purposes, including personalization or retargeting.
4. It is not used for creditworthiness or lending purposes.
5. Humans do not read the data except with your consent, for security, to comply with law, or in
   aggregated/anonymized form for operations. <!-- BIZ-CONFIRM: human access procedure -->

### Contact

Questions and deletion requests: [Support](support.html)

## 한국어

## 무엇을 수집하는가

에이전트는 **당신이 만든 에이전트 탭 그룹 안의 탭**에서만 동작한다. 그룹 밖의 탭, 다른 창, 다른 프로필은
읽지 않는다. 그룹은 당신이 만들고, 탭은 당신이 끌어 넣는다.

| 항목 | 무엇인지 | 왜 필요한지 |
|---|---|---|
| 페이지 내용(일부) | 에이전트가 조작하는 탭에서 읽은 **상품명·가격·배송비·평점·리뷰 수·재고 문구**와 그 요소의 텍스트 | 총액을 비교하려면 카드에 적힌 숫자를 읽어야 한다 |
| 페이지 주소 | 그 탭의 URL과 상품 식별자 | 어느 상품·어느 스토어인지 구분, 장바구니에 담기 전 같은 상품인지 재확인 |
| 대화 내용 | 당신이 입력한 요청과 어시스턴트의 답 | 요청을 해석하고 다음 단계를 고른다 |
| 실행 흔적 | 어떤 도구가 어떤 순서로 돌았는지, 오류 코드 | 실패했을 때 무엇이 실패했는지 보여준다 |

**수집하지 않는 것**: 비밀번호·결제수단·카드번호를 읽거나 저장하지 않는다. 로그인 폼과 결제 필드는
채우지 않는다. 로그인 벽이나 봇 확인 화면을 만나면 **그 사실만 보고하고 멈춘다**. 방문 기록 전체, 다른
탭, 북마크, 쿠키를 수집하지 않는다.

## 어디로 가는가

1. **AXSDK 백엔드(`api.axsdk.ai`)** — 대화와, 다음 단계를 고르는 데 필요한 페이지 유래 정보(상품명·가격
   같은 값)가 전송된다. 백엔드는 이를 **언어모델에 전달해 다음 행동을 결정**하고 그 결정을 돌려준다.
2. **언어모델 공급자** — 백엔드를 통해서만 전달된다. 확장이 모델 공급자에 직접 접속하지 않는다.
3. **당신이 쇼핑하는 스토어** — 검색어와, 당신이 승인한 장바구니 담기 동작이 그 스토어에 전달된다.
   그건 브라우저가 원래 하는 일과 같다.

**판매·광고·프로파일링에 사용하지 않는다.** 데이터 브로커에 제공하지 않는다. 이 확장에는 어필리에이트
링크나 추적 파라미터 삽입이 없다(해당 코드는 2026-08-18에 제품에서 삭제됐다).

<!-- BIZ-CONFIRM: 백엔드 보관 기간, 사람에 의한 접근 조건, 하위 처리자(모델 공급자) 명칭을 확정해 이 절에 명시 -->

## 얼마나 남아 있는가

| 어디 | 무엇 | 기간 |
|---|---|---|
| 브라우저 로컬(`chrome.storage.local`) | 세션별 대화, 실행 흔적, 설정 | 당신이 지울 때까지. 확장 삭제 시 함께 사라진다 |
| 브라우저 로컬 | 기억해 달라고 **명시적으로 요청한** 값(이름·이메일·전화·우편번호) | 당신이 삭제를 요청할 때까지 |
| AXSDK 백엔드 | 세션과 메시지 | <!-- BIZ-CONFIRM: 보관 기간 --> |

기억(memory)은 **명시적 요청이 있을 때만** 저장된다. "기억해 줘"와 같은 문구가 없으면 값이 대화에
등장해도 저장되지 않는다 — 이건 코드로 강제되고 테스트로 고정돼 있다.

## 삭제하는 방법

- **대화·기억**: 확장 옵션에서 지우거나, 대화로 "기억 지워 줘"라고 요청한다(목록 확인 → 삭제).
- **전부**: 확장을 삭제하면 로컬 저장분이 모두 사라진다.
- **백엔드 보관분**: <!-- BIZ-CONFIRM: 삭제 요청 채널(이메일 또는 폼)과 처리 기간 -->

## 권한을 왜 요구하는가

- **`debugger`** — 페이지를 읽고 클릭·입력하는 통로다. Chrome은 이 권한을 설치 시점에 *"모든 웹사이트의
  모든 데이터를 읽고 변경"*으로 공시하며, 세션이 붙어 있는 동안 **브라우저가 직접 배너를 띄운다.** 그
  배너에서 언제든 중단할 수 있다.
- **모든 사이트 호스트 권한** — 백엔드 접속과 네트워크 규칙 한 건에 필요하다. 페이지 접근 경계는 위의
  탭 그룹이다.
- 나머지(`storage`, `tabGroups`, `scripting`, `offscreen`, `userScripts`,
  `declarativeNetRequestWithHostAccess`)의 개별 사유는 스토어 리스팅의 권한 소명에 적는다.

## 아이·민감정보

13세 미만을 대상으로 하지 않는다. 건강·금융·생체·정치·종교 정보를 수집하지 않는다.

## Limited Use

이 확장은 Chrome Web Store **Limited Use** 요건을 준수한다:

1. 수집한 데이터는 위에 공시한 **단일 목적에 필요한 범위로만** 사용한다.
2. 제3자에게 **판매하지 않는다.**
3. 광고 목적(개인화·재타겟팅·광고 성과 측정)으로 사용하거나 이전하지 않는다.
4. 신용도 평가나 대출 목적에 사용하지 않는다.
5. 사람이 데이터를 읽는 것은 다음의 경우로 한정한다: 사용자 동의, 보안 목적, 법적 요구, 그리고
   집계·익명화된 형태의 서비스 운영. <!-- BIZ-CONFIRM: 사람 접근 절차 확정 -->

## 연락

문의·삭제 요청: [지원 페이지](support.html)
