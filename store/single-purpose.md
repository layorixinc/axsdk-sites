# 단일 목적 (Chrome Web Store · Privacy practices → Single purpose)

R1의 문장. 대시보드에 **이 한 줄**을 넣는다. 다른 모든 산출물(`store/listing.md`,
`store/permissions.md`, `docs/privacy.md`)이 이 문장을 참조하므로, 바꿀 곳은 여기 하나다.

> 지원하는 온라인 쇼핑몰에서 한 상품의 배송비 포함 총액을 비교하고, 사용자가 고른 상품을 장바구니에
> 넣고 결제 화면까지 안내한다. 주문이나 결제는 하지 않는다.

English (listing is bilingual; the store field takes one language at a time):

> Compare one product's total cost including shipping across supported online stores, then add the
> product the user picked to that store's cart and take them to its checkout review. It never places
> an order or pays.

---

## English

The sentence for the dashboard field, in the language the reviewer reads:

> Compare one product's total cost including shipping across supported online stores, then add the
> product the user picked to that store's cart and take them to its checkout review. It never places an
> order or pays.

Why this one: Quality Guidelines §1 refuses "bundles of unrelated functionality", and the 2026-08-01
Limited Use revision requires collected data to be strictly necessary for the disclosed purpose.
Shopping alone satisfies both — what is read is the product name, price and shipping fee on a page, and
no contact detail. The Korean section carries the measured comparison of the three candidate sentences
and the code work this choice implies (three intents and the memory-capture hook leave the store build).

## 한국어

## 왜 이 문장인가 (측정 첨부)

`CWS_LAUNCH_PLAN.md` §P0-3의 세 안 중 **A안**이다. 판단 축은 취향이 아니라 Quality Guidelines §1의
"묶음(bundles of unrelated functionality)"과 2026-08-01 개정 Limited Use의 "공시된 단일 목적에 엄격히
필요한 데이터"를 **동시에** 통과하는가 하나였다.

| 안 | flow | 모듈 | KiB | §1 위험 |
|---|---|---|---|---|
| **A (선택)** | 4 | 20 | 282.1 | 낮음 — 쇼핑 하나 |
| B (+지역 서비스 견적) | 6 | 24 | 367.3 | 소매와 리드 생성이 다른 버티컬로 읽힌다 |
| C (문장 없음) | 7 | 25 | 371.4 | §1이 이름으로 지목하는 구성 |

A는 수집 데이터가 목적과 1:1로 대응한다 — 페이지의 상품·가격, 연락처 없음. 그래서 `docs/privacy.md`가
짧고, 짧은 것이 방어 가능하다.

## A를 고른 대가 — 코드에서 해야 하는 일

R1 스토어 빌드에서 빠져야 하는 것들이다. 빼지 않으면 심사자가 아무 말이나 입력했을 때 리스팅과 다른
답이 나오고, 그게 §1 위반의 가장 흔한 발견 경로다.

- 라우터에서 `request_service_quote`(Thumbtack 견적) · `memory` · `bluemoonsoft` intent 제거
- `router.defaultIntent`를 쇼핑 플로우로 이전 — **지금 기본값이 `request_service_quote`다**
- `hooks.beforeIntent: [record_memory]` **삭제**. 이게 남아 있으면 목적이 "상품 구매"인데 매 턴 연락처를
  추출하는 훅이 도는 상태이고, Limited Use에서 방어 불가다
- 전용 모듈 제거: `64_rpc_thumbtack`, `65_rpc_quote`, `10_form_wizard`, `72_rpc_sitemap`, `70_rpc_memory`
- `thumbtack/`, `bluemoonsoft/` 사이트 데이터를 스토어 빌드에서 제외 (저장소에서 지우지 않는다)

게이트가 잡아준다: `dead:lua`, `check:flows`, `build:schema --check`.

**견적 플로우는 버리는 것이 아니다.** §1 자신이 처방을 적어 두었다 —
*"better delivered as separate extensions"*. 모듈 단위로 이미 갈라져 있어(전용 75.5 KiB, 공유 모듈에 대한
역의존 없음) 두 번째 확장으로 분리할 수 있다.

## B로 되돌리려면

이 파일의 문장과 위 목록만 바뀐다. `docs/privacy.md`의 "연락처" 항목이 살아나고,
`store/listing.md`의 기능 목록에 견적이 추가된다. 그 외 산출물은 그대로다.
