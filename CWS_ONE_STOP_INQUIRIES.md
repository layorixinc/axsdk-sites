# One Stop Support 사전 문의 2건 — 발송본

작성 2026-08-15 · 근거 `CWS_LAUNCH_PLAN.md` P0-1 · `SITE_DATA_SPLIT_DESIGN.md` §5

**왜 사전에 묻는가.** 두 질문의 답이 각각 하나의 설계 전체를 결정한다. 답을 추정해서 구현하면 심사에서
거절될 때 되돌릴 것이 설계 전부가 된다. 심사 자체를 앞당기려는 문의가 아니라, **구현 방향을 고르기 위한
정책 해석 확인**이다.

**보낼 때의 원칙 세 가지** — 아래 문안은 이미 그렇게 쓰여 있다.

1. **구조만 서술한다.** 경쟁 확장 이름을 근거로 들지 않는다("X도 하는데 왜 우리는" 은 정책 해석 요청이
   아니라 이의 제기로 읽히고, 답은 "각 확장은 개별 심사됩니다" 로 끝난다).
2. **우리 쪽 결론을 먼저 말한다.** 우리가 이미 어느 쪽으로 판단했는지 밝히고 그 판단이 맞는지 묻는다.
   열린 질문으로 보내면 "정책을 읽어 보세요" 로 돌아온다.
3. **한 통에 한 질문.** 두 건은 별개 티켓으로 보낸다. 하나가 막혀도 다른 하나는 답을 받는다.

---

## 문의 ① — 선택자 테이블이 §3.2의 "remote configuration file" 범위인가

**제목**: Does a remotely-fetched CSS selector table fall under §3.2 "remote configuration file"?

> Hello,
>
> We are preparing an extension for submission and would like to confirm one policy reading **before** we
> implement, because the answer determines the whole design.
>
> **What the extension does.** It assists a user with shopping on a set of supported retail sites: it reads
> the product cards on a search results page, normalizes prices and shipping into a comparison, and can add
> a product the user selected to that site's cart. All of the behaviour — what to read, in what order, what
> to compare, when to stop and ask the user — is compiled into the extension package.
>
> **What we would like to fetch remotely.** Only a table of **CSS selector strings** keyed by site, e.g.
>
> ```json
> { "ebay": { "result_selector": "li.s-card[data-listingid]",
>             "result_price_selector": ".s-card__price",
>             "cart_item_selector": "[data-test-id='cart-item-link']" } }
> ```
>
> These are pure strings passed to `document.querySelector`. They contain no expressions, no code, no URLs
> to fetch, and no control flow. The extension does not evaluate them as anything other than a selector
> argument, and a selector that matches nothing produces a "field not found" state that the extension
> already handles.
>
> **Why we want this.** Retail sites change their markup without notice, and when they do our reader stops
> finding the field — the user sees an incomplete comparison. Three such breakages happened to us in a
> single week of testing (a shipping-fee element renamed, a title selector that started matching a brand
> heading instead of the product title, and a search-card class that was replaced outright). Each is a
> one-string fix. Shipping them as package updates means every markup change waits on a review cycle.
>
> **Our reading**, from
> [Additional Requirements for Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
> §3.2:
>
> > Fetching a remote configuration file for A/B testing or determining enabled features, where all logic
> > for the functionality is contained within the extension package
>
> we believe a selector table is such a configuration file: the logic is entirely in the package and the
> remote resource only tells it *where* on a given page to look.
>
> **We are aware of the neighbouring prohibition** in the same document and we are explicitly NOT asking
> about it:
>
> > Building an interpreter to run complex commands fetched from a remote source, even if those commands
> > are fetched as data
>
> Our submission will contain no remotely-fetched executable logic of any kind; that is a separate change we
> have already completed, and the extension now provisions itself entirely from its own package.
>
> **The question.** Is a remotely-fetched table of CSS selector strings, consumed only as
> `querySelector` arguments by logic that ships in the package, within the scope of §3.2 — or would you
> consider a selector to be part of "the logic for the functionality" because it determines which element
> the extension acts on?
>
> If the latter, we will ship the selectors in the package and accept the review cycle for markup fixes. We
> would rather know now.
>
> Thank you.

**우리 쪽 예상과 대비.** 답이 "§3.2 범위 안" 이면 `SITE_DATA_SPLIT_DESIGN.md` 구현으로 간다.
"로직에 해당" 이면 그 설계는 폐기하고 선택자는 패키지에 남는다 — 그리고 마크업 수정마다 심사를 기다리는
비용이 확정되므로, P0-5(릴리스 모델) 판단의 입력이 된다. **어느 답이든 진행 가능하다는 점을 문의에
적어 둔 이유가 이것이다.**

**답이 "로직에 해당" 일 때 남는 위험은 우리가 이미 적어 두었다** (`SITE_DATA_SPLIT_DESIGN.md` §5-4):
선택자는 에이전트가 **무엇을 클릭할지**를 정한다. 탈취된 `sites.json`은 임의 요소 클릭을 유도할 수 있고,
"데이터라서 안전하다" 는 정책상의 분류이지 보안상의 결론이 아니다. 이 문의를 보내기 전에 서명·무결성
방안을 정해 두는 것이 순서다.

---

## 문의 ② — 샌드박스 페이지 + 고정 op 어휘가 §1 예외에 드는가

**제목**: Does a sandboxed interpreter with a fixed, non-extensible operation vocabulary meet the §1 sandbox exception?

> Hello,
>
> A second, separate policy reading we would like to confirm before implementing.
>
> **Background.** Our extension currently interprets a small scripting language to drive its site-specific
> behaviour. We have already moved that content into the extension package, so nothing is fetched remotely.
> The remaining question is about the interpreter itself.
>
> **What we are considering.** Moving the interpreter into a
> [sandboxed page](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox) with:
>
> - **no access to any extension API** from inside the sandbox, and
> - a **fixed, closed vocabulary** of operations the sandbox may request of the extension — currently 15
>   named operations, all of them page reads or a click/navigate (e.g. "query elements matching this
>   selector", "read the text of this element", "click this element", "navigate to this URL"). The list is
>   compiled into the package. The sandbox cannot introduce a new operation, and any name outside the list
>   is refused by the host side.
>
> **Our reading** of the §1 sandbox exception is that it lifts the restriction on *where* code may be loaded
> from, while leaving this requirement in force:
>
> > it must still be possible to determine the full functionality of your extension
>
> We believe a closed 15-operation vocabulary satisfies that requirement more strongly than the general
> case, because the complete set of effects the extension can have on a page is enumerable from the package
> alone, independent of what the interpreted content says.
>
> **The question, in two parts.**
>
> 1. Is that reading correct — does a fixed, non-extensible operation vocabulary satisfy "determine the full
>    functionality", given that the interpreted content itself also ships in the package?
> 2. Is the sandbox move **relevant at all** to your review if nothing is fetched remotely? Our own reading
>    is that once the interpreted content is in the package, the sandbox changes no policy outcome and is
>    only a defence-in-depth measure. We would rather not do work that has no bearing on the review.
>
> To be explicit about what we are not asking: we are not seeking permission to load logic from a remote
> source in any form.
>
> Thank you.

**우리 쪽 예상.** 2번 답이 "관련 없음" 일 가능성이 높다고 본다 — 그렇다면 M1-B는 하지 않고
`CWS_LAUNCH_PLAN.md`가 이미 적어 둔 기본값(M1-A)이 확정된다. **그 확인 자체가 이 문의의 가치다**:
하지 않아도 되는 작업을 하지 않기 위한 문의이지, 새 통로를 요청하는 문의가 아니다.

---

## 발송 체크리스트

- [ ] 두 건을 **별개 티켓**으로 보낸다.
- [ ] 확장 ID·스크린샷·계정 정보는 붙이지 않는다. 정책 해석 문의이고, 미제출 항목이다.
- [ ] 회신을 받으면 **원문 그대로** 이 문서에 덧붙이고, 그 답이 바꾸는 문서를 같은 커밋에서 갱신한다
      (① → `SITE_DATA_SPLIT_DESIGN.md` §5-1 · ② → `CWS_LAUNCH_PLAN.md` P0-1 M1-B).
- [ ] 답이 애매하면 되묻지 말고 **우리 판단을 적고 그 판단으로 진행한다**. 왕복은 한 번으로 끝낸다.
