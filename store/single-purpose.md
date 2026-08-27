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

> **2026-08-26 · bluemoonsoft는 세 안에서 사라졌다.** 표의 숫자는 그 이전 측정이다. 특정 고객사 사이트
> 탐색은 어느 목적 문장에도 들어가지 않아 **제품에서 삭제**했다 — 플로우·도구·사이트 데이터와 전용
> 모듈 `72_rpc_sitemap`(4.1 KiB)이 함께 사라졌으므로, C 안은 플로우 하나와 그 모듈만큼 줄어들고 §1
> 위험도 그만큼 낮아진다. A·B 안의 숫자는 영향받지 않는다(둘 다 이미 bluemoonsoft를 제외한 값).

A는 수집 데이터가 목적과 1:1로 대응한다 — 페이지의 상품·가격, 연락처 없음. 그래서 `docs/privacy.md`가
짧고, 짧은 것이 방어 가능하다.

## A를 고른 대가 — **실행 완료 (2026-08-27)**

문장은 코드가 됐다. `tools/build-store-flows.mjs`가 저장소의 문서를 **스토어 프로필**로 좁히고,
`build:cws`가 그 결과를 패키지에 싣는다. 견적·메모리는 **저장소에 그대로 남는다** — §1 자신이 처방한
*"better delivered as separate extensions"* 자산이므로, 지우는 대신 출시 패키지에서만 뺀다.

측정값(빌드 출력):

|항목|dev 프로필|스토어 프로필|
|---|---|---|
|플로우|10|**8** (`request_service_quote`·`memory` 제거, `record_memory`는 **무력화**하여 유지)|
|flowTools|79|**41**|
|런타임 모듈|25|**20** (`64_rpc_thumbtack`·`65_rpc_quote`·`10_form_wizard`·`70_rpc_memory`·`71_rpc_zip`)|
|패키지 자산|29 · 850 KiB급|**23 · 636.7 KiB**|
|플로우 문서|255.2 KiB|**132.0 KiB**|
|`defaultIntent`|`request_service_quote`|**`shopping_multi_store_total_cost`**|
|`hooks.beforeIntent`|`[record_memory]`|`[record_memory]` — **아무것도 하지 않는 플로우**|

**훅은 지우는 것이 아니라 무력화한다.** 훅 목록은 **앱 문서**(플랫폼 소유, rev 126, 91줄)가 선언하고
오버레이는 앱이 선언한 키를 지울 수 없다. 우리 플로우를 지우자 앱의 `record_memory`(모델 노드 +
`memory_record` 도구)가 대신 돌았고, 사용자에게 나간 답이 모델 원문이었다 —
`<|channel|>commentary to=functions.memory_record …`. 그래서 스토어 프로필은 같은 이름의 플로우를
**respond 없는 terminal 하나**(FLOWS.md §7.3)로 대체한다: 도구 없음·모듈 없음·모델 호출 없음·출력 없음.

**남은 앱 레이어 의존(우리 저장소 밖).** 앱 문서는 여전히 `memory_record`/`memory_skip` 도구와
메모리 데모 플로우를 갖고 있고 `defaultIntent`가 `site_intent_resolution`이다. 우리 오버레이가
`defaultIntent`와 훅을 덮어 출시 동작은 문장과 일치하지만, 앱 문서 자체를 좁히는 것은 BIZ/플랫폼
작업이다(§9: `browser-extension` 앱 푸시는 프로덕션을 교체한다).

게이트 셋이 이 상태를 지킨다: `tools/build-store-flows.test.mjs`(닫힘·참조·프롬프트·문서 크기),
`release:cws`(문장 밖 표면이 남은 패키지는 릴리스 거부), 아티팩트 스모크(실제로 견적 요청을 보내
거부되는지 확인 — 물어보지 않은 실행은 주장할 수 없고, 어떤 턴이든 모델 원문이 섞이면 실패한다).

라이브 증거(2026-08-27, 스토어 패키지): `CWS ARTIFACT SMOKE PASS sha256:2848b527…` — 비교 25.4s ·
정제 5.3s · 취소 4.7s(무변경) · 카트 24.1s · 결제 검토 46.4s(주문 없음), 그리고 견적 요청에 대한 답:

> 죄송하지만 해당 요청은 지원되지 않습니다. 대신, 지원되는 매장에서 선택하신 제품의 총 비용(배송 포함)을
> 비교하고, 해당 매장 장바구니에 추가한 뒤 결제 페이지를 열어 검토하도록 도와드릴 수 있습니다.

### 원래 목록 (참고)

R1 스토어 빌드에서 빠져야 하는 것들이다. 빼지 않으면 심사자가 아무 말이나 입력했을 때 리스팅과 다른
답이 나오고, 그게 §1 위반의 가장 흔한 발견 경로다.

- 라우터에서 `request_service_quote`(Thumbtack 견적) · `memory` intent 제거
- `router.defaultIntent`를 쇼핑 플로우로 이전 — **지금 기본값이 `request_service_quote`다**
- `hooks.beforeIntent: [record_memory]` **삭제**. 이게 남아 있으면 목적이 "상품 구매"인데 매 턴 연락처를
  추출하는 훅이 도는 상태이고, Limited Use에서 방어 불가다
- 전용 모듈 제거: `64_rpc_thumbtack`, `65_rpc_quote`, `10_form_wizard`, `70_rpc_memory`
- `thumbtack/` 사이트 데이터를 스토어 빌드에서 제외 (저장소에서 지우지 않는다)

게이트가 잡아준다: `dead:lua`, `check:flows`, `build:schema --check`.

**견적 플로우는 버리는 것이 아니다.** §1 자신이 처방을 적어 두었다 —
*"better delivered as separate extensions"*. 모듈 단위로 이미 갈라져 있어(전용 75.5 KiB, 공유 모듈에 대한
역의존 없음) 두 번째 확장으로 분리할 수 있다.

## B로 되돌리려면

이 파일의 문장과 위 목록만 바뀐다. `docs/privacy.md`의 "연락처" 항목이 살아나고,
`store/listing.md`의 기능 목록에 견적이 추가된다. 그 외 산출물은 그대로다.
