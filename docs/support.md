---
layout: default
title: 지원 — AXSDK 확장
---

# 지원

[English](#english) · [한국어](#한국어)

Chrome Web Store 리스팅의 **Support URL**이 이 페이지를 가리킨다.

## English

The Chrome Web Store listing's **Support URL** points here.

### Contact

- Bugs and questions: <https://github.com/layorixinc/axsdk-sites/issues>
- Privacy and data deletion: <support@layorix.ai> (we reply within 7 business days)

What makes an issue answerable in one round: which store, what you typed, the sentence on screen
verbatim, and the extension version (bottom of the options page).

### Check these first

**"The agent will not start."** With credentials empty the extension refuses to start, opens Settings, and
creates no tab group and no session — the message on screen names what is missing.

**"This tab cannot be driven."** `chrome://` pages, extension pages and blank tabs cannot be attached to.
Start again on an ordinary web page.

**"A debugging banner appeared at the top of the browser."** That is expected: this extension reads and
drives pages through Chrome's DevTools protocol, so the browser announces it. Stopping it there ends the
session.

**"Shipping shows as unknown."** The store card did not state a fee. Rows whose total is unknown are
folded out of the default list and counted; ask to include them and they come back. They are never
assumed to be zero, because that would make that store look cheapest for free.

**"A store says a security check is required."** That store showed a bot check. The extension does not
bypass them — pass it yourself in that tab and ask again.

**"I am not sure the item was added."** The extension says a product was added only after re-reading the
store's own cart page and finding the product identifier there. If it cannot confirm, it says so and
claims nothing.

### What this extension will not do

- **It never orders and never pays.** It stops at the checkout review page; the order button is read, not
  clicked, and a code gate holds that.
- It does not fill login forms or payment fields.
- It does not bypass bot checks or login walls.
- It does not read tabs outside the agent tab group.

### Data

What is collected and where it goes: [Privacy policy](privacy.html).

## 한국어

## 문의

- 버그·질문: GitHub 이슈 — <https://github.com/layorixinc/axsdk-sites/issues>
- 개인정보·데이터 삭제 요청: <support@layorix.ai> (영업일 7일 이내 회신)

이슈를 열 때 다음이 있으면 원인이 한 번에 잡힌다: 어떤 스토어였는지, 무엇을 입력했는지, 화면에 나온
문장 그대로, 그리고 확장 버전(옵션 페이지 하단).

## 먼저 확인할 것

**"에이전트가 시작되지 않습니다"**
옵션 페이지에서 자격 정보가 비어 있으면 시작을 거부하고 설정 화면을 엽니다. 그 상태에서는 탭 그룹도
만들지 않고 아무것도 실행하지 않습니다 — 화면의 문장이 무엇을 채워야 하는지 말해 줍니다.

**"현재 탭을 조작할 수 없습니다"**
`chrome://` 페이지, 확장 페이지, 빈 탭에는 붙을 수 없습니다. 일반 웹페이지에서 다시 시작하세요.

**"브라우저 상단에 디버깅 배너가 떴습니다"**
정상입니다. 이 확장은 Chrome의 DevTools 프로토콜로 페이지를 읽고 조작하므로, 브라우저가 그 사실을
직접 알립니다. 배너에서 중단하면 세션이 끊깁니다.

**"검색 결과에 배송비가 '미확인'으로 나옵니다"**
스토어 카드가 배송비를 적지 않은 경우입니다. 총액을 알 수 없는 행은 기본 목록에서 접히고 몇 건이
접혔는지 표시됩니다 — "미확인 포함"이라고 하시면 함께 보여줍니다. 0원으로 가정하지 않는 이유는,
그러면 그 스토어가 근거 없이 가장 싸게 보이기 때문입니다.

**"어떤 스토어가 '보안 확인 필요'라고 나옵니다"**
그 스토어가 봇 확인 화면을 띄웠습니다. 확장은 그런 화면을 우회하지 않습니다. 해당 탭에서 직접 확인을
통과한 뒤 다시 요청하세요.

**"장바구니에 담겼는지 확실하지 않습니다"**
확장은 스토어의 장바구니 페이지에서 **상품 식별자를 다시 읽어** 확인된 경우에만 담겼다고 말합니다.
확인하지 못하면 "확인 불가"로 보고하고 아무것도 주장하지 않습니다.

## 이 확장이 하지 않는 일

- **주문·결제를 하지 않습니다.** 결제 화면까지 안내하고 멈춥니다. 주문 버튼은 읽기만 하고 누르지 않으며,
  이 사실은 코드 게이트로 고정돼 있습니다.
- 로그인 폼과 결제 필드를 채우지 않습니다.
- 봇 확인·로그인 벽을 우회하지 않습니다.
- 에이전트 탭 그룹 밖의 탭을 읽지 않습니다.

## 데이터

무엇을 수집하고 어디로 보내는지는 [개인정보 처리방침](privacy.html)에 있습니다.
