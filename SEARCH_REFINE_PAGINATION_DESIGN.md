# 검색 Refine · 결과 Pagination 설계

## 1. 목적과 범위

`shopping_multi_store_total_cost` agentic task에 다음 세 가지를 추가하기 위한 설계다. 구현은 이 문서 승인 이후에 한다.

| 레이어 | 문제 | 대상 |
|---|---|---|
| A. 사이트 결과 pagination | 각 쇼핑몰의 검색 결과 1페이지만 읽는다. 원하는 상품이 2페이지 이후에 있으면 영영 못 찾는다 | 사이트 어댑터 (`60_storefront.lua`, `<site>/scripts/*`) |
| B. 후보 열람 pagination | 사용자가 후보를 훑어보며 고를 수단이 없다. 랭킹 상위 6개를 한 번에 던지고 끝난다 | 공통 커머스 (`50_commerce.lua`) + flow |
| C. Refine | 조건을 좁히거나(더 싼 것, 무료배송만) 질의를 바꿀 수단이 없다. 처음부터 다시 말해야 한다 | flow + 공통 커머스 |

B는 **작은 컨텍스트 모델에서도 동작해야 한다**는 요구가 붙는다. 이 제약이 설계 전반을 지배하므로 §5에서 별도로 다룬다.

이 문서는 [`FLOWS.md`](./FLOWS.md) v1 계약, [`FLOW_CONFORMANCE.md`](./FLOW_CONFORMANCE.md), [`MULTI_STORE_TOTAL_COST_DESIGN.md`](./MULTI_STORE_TOTAL_COST_DESIGN.md)를 전제한다.

---

## 2. 현재 상태 (측정값)

설계의 출발점이므로 추정이 아니라 코드/실측이다.

| 항목 | 현재 값 | 위치 |
|---|---|---|
| 사이트 결과 페이지 | **1페이지 고정**. 결과에 `cursor = false`를 항상 반환 | `_common/scripts/60_storefront.lua` `search()` |
| 페이지당 읽는 행 수 | `result_limit` 기본 24 | `60_storefront.lua` `read_candidates()` |
| 사이트당 비교 후보 | 3 (`MAX_OFFERS_PER_SITE`) | `_common/scripts/50_commerce.lua` |
| 랭킹 노출 | 6 (`MAX_RANKED_OFFERS`) | 같음 |
| 상품 식별 후보 | 6 (`MAX_DISCOVERY_RESULTS`) | 같음 |
| 사용자 열람 | 랭킹 6개를 `comparison_text` 한 덩어리로 `question`에 실어 1회 제시 | `AX_rank_store_offers` → `AX_present_store_offers` |
| 라인 길이 | 실측 약 110~180자/오퍼 (2026-07-26 라이브) | 쿠팡·아마존 M185 비교 |
| Refine | 멀티스토어 플로우에 **없음**. Thumbtack 견적 플로우에만 `refine_search` 계열 노드가 있다 | `_common/flows.yaml` |

**런타임 pagination 기능은 쓸 수 없다.** `FLOWS.md`는 flowTool 필드로 `pagination`을 언급하지만(§9 목록) 규격이 없고, SDK 소스 전체에서 어댑터 구현이 발견되지 않는다(`axsdk-core`에는 knowledge 검색용 `page`/`limit` 파라미터만 존재). 따라서 **페이징은 우리 어댑터와 flow 상태로 구현한다.** 또한 `poll`은 `pagination`과 함께 쓸 수 없다는 제약(§9.1.1)도 이 선택과 충돌하지 않는다.

---

## 3. 지켜야 하는 계약

설계가 깨뜨리면 안 되는 것들이다. 대부분 `npm run check:flows`가 강제한다.

1. `choose_offer.allowedTools`는 **정확히** `[present_store_offers, choose_store_offer]`. 페이징 명령 때문에 세 번째 도구를 추가할 수 없다.
2. `choose_offer.inputSelector`에 `offers`, `comparison_text`, `ambiguous_offers`, `excluded_offers`를 넣을 수 없다. 새 상태 필드는 이 이름들을 피해야 한다.
3. `choose_store_offer.parameters.properties`에 `choice_stage`가 있으면 안 된다.
4. 노드 엣지 `collect_request→prepare_identity`, `resolve_product→search_stores`, `search_stores→verify_offers`, `verify_offers→normalize_rank`, `normalize_rank→choose_offer`, `choose_offer --ask--> choose_offer`, mutation 3홉 체인은 그대로 유지. **추가는 되지만 변경·삭제는 불가.**
5. 장바구니 mutation은 `cart_approval`/`identity_approval`/`comparison_approval` 3중 게이트 유지.
6. 승인 토큰은 결정적 도구만 발급. LLM 도구는 `next`/`question`/인덱스/`comparison_id`만 낸다.
7. `flow.map` task budget: `maxNodes 8`, `maxModelCalls 0`, `maxRemoteCalls 5`, `timeoutMs 120000`. 페이징은 이 안에서 이뤄져야 한다.

---

## 4. 레이어 A — 사이트 결과 pagination

### 4.1 어댑터 config 확장

사이트마다 페이지 이동 방식이 다르므로 config로 선언한다. 세 가지 모드만 지원한다.

```lua
pagination = {
  mode = "query",            -- query | offset | click
  param = "page",            -- mode=query: 쿼리 파라미터 이름
  start = 1,                 -- 1페이지의 값
  step = 1,                  -- 다음 페이지 증가분 (offset 모드는 result_limit)
  next_selector = nil,       -- mode=click: "다음" 버튼 셀렉터 (텍스트 매칭 금지, 구조/aria 기반)
  max_pages = 3,             -- 이 사이트에서 허용하는 최대 페이지 수
}
```

- `mode="query"`: `search_url`에 `param=N`을 붙여 재검색 (예: `&page=2`).
- `mode="offset"`: `param=(N-1)*step` (예: `&start=24`).
- `mode="click"`: 다음 버튼 클릭. `dom`은 텍스트 매칭을 못 하므로 `next_selector`는 `aria-label`/구조 기반이어야 한다(`AGENTS.md` §10).
- `pagination`이 없는 사이트는 **1페이지 전용**으로 명시 취급하고 `has_more=false`를 반환한다. 추측해서 URL을 만들지 않는다.

각 사이트의 실제 페이지 파라미터는 **구현 단계에서 라이브로 확인**한다. 이 문서는 값을 단정하지 않는다.

### 4.2 명령 인자·결과 계약

`AX_search_product` / `AX_search_store_product`에 페이지 인자를 추가한다.

```text
args    : { query, page? = 1, cursor? }
result  : { site, query, page, candidates, has_more, next_cursor, total_count, error? }
```

- `page`는 1-base. `cursor`는 사이트가 토큰형 페이징을 쓸 때만 사용하고, 기본은 `page`.
- `has_more`는 **다음 페이지 존재 여부의 관측값**이다. 추정하지 않는다. `mode=query`는 "이번 페이지가 가득 찼는가"로, `mode=click`은 "다음 버튼이 존재하는가"로 판정한다.
- `next_cursor`는 다음 호출에 그대로 넘길 불투명 값. 현재 항상 `false`인 자리를 그대로 쓴다(호환).

### 4.3 페이지 이동의 durable 재진입

페이지 이동은 네비게이션이다. 기존 규칙을 그대로 따른다.

```text
search(page=2) → 이동 필요 → nav 발사 후 { status = "navigating" } 반환
             → 상위 노드가 navigating 전이로 재호출 → 로드된 페이지에서 읽기
```

`shopping_search_one_store` 서브플로우에 이미 `search → search_after_navigation → search_after_navigation_retry → normalize` 홉이 있으므로 **그래프 변경 없이** 재사용한다. 페이지 루프는 노드 자기 반복이 아니라 **어댑터 내부 반복**으로 두어 `maxNodes 8` 예산을 소모하지 않는다.

### 4.4 수집 중단 규칙

무한히 읽으면 안 되므로 네 가지 정지 조건을 모두 적용하고, 먼저 걸리는 것을 따른다.

1. **충분함**: 관련성 필터를 통과한 누적 후보가 목표치 `target_candidates`(기본 = 사이트당 캡의 3배, 즉 9) 이상.
2. **한계**: `pagination.max_pages` 도달 (기본 3).
3. **예산**: 워커의 `maxRemoteCalls`(5) 중 페이지 읽기에 쓸 수 있는 몫 초과. 페이지 1회 = 원격 1회로 계산한다.
4. **수확 체감**: 직전 페이지에서 신규(중복 제외) 적격 후보가 0건.

수집 결과는 `product_id` 기준으로 dedupe하고 **읽은 순서를 보존**한다. 각 후보에 `source_page`를 기록해 증빙에 남긴다.

### 4.5 예산 영향

현재 워커 1개는 원격 2회(사이트 열기 + 검색)를 쓴다. 페이지 3개까지 허용하면 최대 4회로, `maxRemoteCalls 5` 안에 들어간다. 스토어 수 × 페이지 수가 aggregate 한도(512 remote, 120s)를 넘지 않도록 `max_pages`는 사이트별 config로 조인다.

---

## 5. 레이어 B — 후보 열람 pagination (작은 컨텍스트 모델 대응)

### 5.1 원칙

**모델은 목록을 보지 않는다. 창(window)만 본다.**

- 전체 후보/오퍼는 flow 상태에 남고, 프롬프트에는 절대 주입하지 않는다. (이미 conformance가 `offers`·`comparison_text` 주입을 금지한다 — 이 설계는 그 규칙을 페이징으로 확장하는 것이다.)
- 사용자에게 보이는 텍스트는 결정적 Lua가 만들어 `question`으로만 전달한다. 모델은 그 텍스트를 다시 요약하거나 재작성하지 않는다.
- 모델이 출력하는 것은 **번호와 명령어뿐**이다.

이 구조에서 모델의 프롬프트 크기는 후보 수와 **무관**하다. 후보가 6개든 200개든 프롬프트는 동일하다.

### 5.2 뷰 상태

conformance 금지 이름을 피해 새 필드를 둔다.

| 필드 | 의미 | 초기값 |
|---|---|---|
| `view_page` | 현재 페이지(1-base) | 1 |
| `view_page_size` | 페이지당 항목 수 | §5.3 규칙 |
| `view_sort` | `total_asc`(기본) \| `price_asc` \| `rating_desc` \| `delivery_asc` | `total_asc` |
| `view_filters` | 결정적 필터 객체 (§6.2) | `{}` |
| `view_total` | 필터 적용 후 총 항목 수 | 랭킹 결과 수 |
| `view_signature` | 필터+정렬 해시. 바뀌면 `comparison_id` 재발급 | — |

`offers`(전체 배열)는 지금처럼 상태에 남지만 `choose_offer`가 선택하지 않는다. 창 렌더링은 `AX_present_store_offers`가 상태가 아니라 **커머스 모듈의 스냅샷**(`C.current_comparison`)에서 읽는다 — 이미 그렇게 동작하므로 구조 변경이 없다.

### 5.3 페이지 크기 산정

실측 라인 길이는 110~180자다. 안전 상한을 두고 역산한다.

```text
question 예산 = 1,200자 (헤더/푸터 약 200자 포함)
항목 예산     = (1,200 - 200) / 180 ≈ 5
```

- 기본 `view_page_size = 5`.
- 소형 컨텍스트 프로파일에서는 3으로 낮춘다. 프로파일은 **모델 id가 아니라 세션 설정**으로 결정한다(모델 문자열 하드코딩 금지).
- 렌더링 후 실제 길이가 예산을 넘으면 **필드를 정해진 순서로 떨어뜨린다**: `condition` → `rating` → `shipping 내역` → 상품명 절단(40자). 절단은 항상 마지막이다.
- 항목 1줄은 다음 최소 정보를 유지한다: `번호 · 사이트 · 상품명(절단 가능) · 총액`.

### 5.4 창 렌더링 계약

```text
헤더 : "총 42개 중 6-10번 (2/9 페이지) · 정렬: 총액 낮은 순 · 필터: 무료배송"
본문 : 항목 5줄 (전역 번호 유지)
푸터 : "번호로 선택 · '다음'/'이전' · '무료배송만', '3만원 이하' 같은 조건 · '취소'"
```

- **번호는 전역 인덱스**다. 2페이지의 첫 항목은 6번이지 1번이 아니다. 창이 바뀌어도 번호가 그대로이므로 사용자가 "아까 그 3번"이라고 해도 정확히 지칭된다.
- 헤더에 총 개수를 노출해 "더 있는지" 질문을 없앤다.

### 5.5 명령 라우팅 — 도구를 추가하지 않는다

제약 ①(allowedTools 정확히 2개) 때문에 페이징 명령은 기존 두 도구에 흡수한다.

`choose_store_offer`의 `next` enum을 확장한다.

```yaml
choose_store_offer:
  parameters:
    properties:
      next: { type: string, enum: [ask, select, cancel, page, refine] }   # page/refine 추가
      choice_index: { type: [integer, number, "null"] }
      choice_comparison_id: { type: [string, "null"] }
      page_command: { type: [string, "null"], enum: [next, prev, first, last] }
      page_number:  { type: [integer, "null"] }
      refine_request: { type: [string, "null"] }   # 자연어 그대로. 해석은 결정적 도구가 한다
```

- `next="page"` → 노드는 자기 자신으로 self-loop, 결정적 도구가 `view_page`를 갱신하고 새 창을 `question`으로 낸다.
- `next="refine"` → §6으로 간다.
- 모델은 **필터를 해석하지 않는다.** `refine_request`에 사용자 문장을 그대로 넣고, 구조화는 결정적 파서가 한다(§6.2). 소형 모델에서 필터 스키마를 지키게 하는 것보다 문자열 전달이 안전하다.

`present_store_offers`는 `page`/`sort`/`filters` 인자를 받아 해당 창을 렌더한다. 반환은 지금과 같이 `question` 하나다.

### 5.6 선택의 정합성

- `choice_index`는 **전역 인덱스**이며, `choice_comparison_id`와 함께 `AX_resolve_store_offer`가 검증한다.
- 페이지 이동은 스냅샷을 바꾸지 않으므로 `comparison_id` 불변.
- 필터·정렬 변경은 목록 자체를 바꾸므로 **새 `comparison_id`를 발급**하고, 이전 번호로 들어온 선택은 `stale_comparison`으로 거절한다. 이 규칙이 "3페이지에서 필터를 바꾼 뒤 예전 번호로 담기"를 원천 차단한다.

---

## 6. 레이어 C — Refine

### 6.1 두 종류를 구분한다

| 종류 | 트리거 | 네트워크 | identity | comparison_id |
|---|---|---|---|---|
| C1. 결과 내 refine | "무료배송만", "3만원 이하", "평점 높은 순" | 없음 | 유지 | 재발급 |
| C2. 재검색 refine | "M185 말고 M240", "쿠팡 빼고 11번가 추가" | 있음 | **재확정 필요** | 재발급 |

구분은 결정적으로 한다. 요청이 **상품 정체성(브랜드/모델/카테고리)** 또는 **스토어 집합**을 건드리면 C2, 그 외 속성(가격·배송·평점·조건)만 건드리면 C1이다.

### 6.2 결정적 필터 문법

자연어 → 구조화는 Lua 파서가 담당한다. 지원 축은 처음부터 좁게 간다.

```lua
view_filters = {
  price_max = 30000,          -- "3만원 이하", "under $20"
  price_min = nil,
  free_shipping_only = true,  -- "무료배송만"
  min_rating = 4.0,           -- "평점 4점 이상"
  sites = { "coupang" },      -- "쿠팡 것만"
  exclude_sponsored = true,   -- "광고 빼고"
  complete_cost_only = true,  -- "총액 확실한 것만"
}
view_sort = "total_asc" | "price_asc" | "rating_desc" | "delivery_asc"
```

- 파서가 해석하지 못한 문장은 **거절하고 되묻는다**. 추측해서 필터를 만들지 않는다.
- 필터 적용 결과가 0건이면 필터를 적용하지 않은 상태로 되돌리고 `refine_empty`를 알린다. 빈 화면을 보여주지 않는다.
- 필터는 **누적**이다. "무료배송만" 다음 "3만원 이하"는 두 조건의 AND. "필터 해제"로 초기화한다.

### 6.3 C2(재검색)의 identity 규칙

- 모델/브랜드가 바뀌면 기존 `identity_id`·`identity_approval`은 **즉시 무효**다. `prepare_identity`부터 다시 탄다.
- 스토어 집합만 바뀌면 identity는 유지하고 `search_stores`부터 다시 탄다.
- 어느 경우든 `cart_approval`은 폐기한다.

### 6.4 승인 무효화 규칙 (요약)

| 변경 | comparison_id | identity_approval | cart_approval |
|---|---|---|---|
| 페이지 이동 | 유지 | 유지 | 유지 |
| 정렬·필터 변경 | 재발급 | 유지 | **폐기** |
| 스토어 집합 변경 | 재발급 | 유지 | **폐기** |
| 모델/브랜드 변경 | 재발급 | **폐기** | **폐기** |

---

## 7. 변경 요약

### 7.1 노드 그래프

기존 엣지는 전부 보존하고 다음만 추가한다.

```text
choose_offer --page--> choose_offer      (self-loop, 창 이동)
choose_offer --refine--> refine_offers   (신규 action_contract)
refine_offers --view--> choose_offer     (C1: 필터/정렬만 바뀜)
refine_offers --research--> search_stores (C2: 스토어 집합 변경)
refine_offers --relock--> prepare_identity (C2: 모델/브랜드 변경)
refine_offers --error--> error
```

`refine_offers`는 결정적 노드다. LLM은 `choose_offer`에서 문장을 넘기기만 한다.

### 7.2 flowTool

| 도구 | 변경 |
|---|---|
| `choose_store_offer` | `next` enum에 `page`/`refine` 추가, `page_command`/`page_number`/`refine_request` 인자 추가 |
| `present_store_offers` | `page`/`sort`/`filters` 인자 수용, 창 단위 `question` 반환 |
| `shopping_refine_offers` (신규) | `AX_refine_store_offers` 바인딩. 문장 → 필터/정렬 구조화, 분기 결정 |
| `shopping_search_one_store` | `page` 인자 전달, `has_more`/`source_page` 결과 통과 |
| `shopping_normalize_store_result` | `source_page` 보존 |

### 7.3 AX_* 명령

| 명령 | 변경 |
|---|---|
| `AX_search_product` | `page`/`cursor` 인자, `page`/`has_more`/`next_cursor` 결과 |
| `AX_search_store_product` | 동일 + 페이지 누적·중단 규칙(§4.4) |
| `AX_rank_store_offers` | `view_*` 반영, 창 렌더링 분리, `view_total` 반환 |
| `AX_present_store_offers` | 창 인자 수용 |
| `AX_refine_store_offers` (신규) | 자연어 → 필터/정렬, 분기 코드 반환 |

`SCHEMA.md`는 같은 변경에서 갱신한다.

### 7.4 상태 필드

추가: `view_page`, `view_page_size`, `view_sort`, `view_filters`, `view_total`, `view_signature`, `refine_request`, `refine_error`.
후보 항목에 추가: `source_page`.

---

## 8. 실패 모드

| 코드 | 의미 | 처리 |
|---|---|---|
| `pagination_unsupported` | 사이트에 `pagination` config 없음 | 1페이지 결과로 진행, 사용자에게 그 사실만 알림 |
| `page_navigation_failed` | 페이지 이동 실패 | 지금까지 모은 후보로 진행 (부분 성공) |
| `page_out_of_range` | 존재하지 않는 페이지 요청 | 마지막 페이지로 고정하고 안내 |
| `refine_unparsed` | 필터 문장 해석 실패 | 되묻기. 추측 금지 |
| `refine_empty` | 필터 결과 0건 | 직전 상태로 롤백 후 안내 |
| `stale_comparison` | 필터 변경 후 옛 번호 선택 | 거절 후 현재 창 재제시 |
| `budget_exhausted` | 페이지 예산 소진 | 수집한 만큼으로 비교 진행 |

---

## 9. 검증 계획

### 9.1 conformance 추가 단언

`tools/flow-conformance.test.mjs`에 같은 변경으로 추가한다.

1. `choose_offer.allowedTools`는 여전히 정확히 2개다.
2. `choose_offer.inputSelector`에 `offers`/`comparison_text`/`ambiguous_offers`/`excluded_offers`/`view_filters`가 없다. (창 payload도 금지 대상에 추가)
3. `choose_offer.next.page === 'choose_offer'`, `choose_offer.next.refine === 'refine_offers'`.
4. `refine_offers`의 세 분기(`view`/`research`/`relock`)가 각각 `choose_offer`/`search_stores`/`prepare_identity`로 간다.
5. `choose_store_offer.parameters.properties`에 `choice_stage`가 여전히 없다.
6. mutation 3중 게이트 불변.

### 9.2 오프라인

- 필터 파서 단위 테스트: 지원 표현/미지원 표현/누적/해제.
- 창 렌더링 단위 테스트: 길이 예산 초과 시 필드 강등 순서, 전역 번호 유지.
- (Lua 단위 테스트 수단이 없으므로 파서·렌더러는 순수 함수로 분리해 `node --test`에서 검증할 수 있는 형태로 둘지 구현 단계에서 결정한다.)

### 9.3 라이브 시나리오

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | 2페이지 이상 필요한 질의 | `source_page ≥ 2`인 후보가 비교에 포함 |
| 2 | 후보 20개 이상에서 "다음" 3회 | 프롬프트 크기 불변, 전역 번호 연속 |
| 3 | "무료배송만" | 필터 적용, `comparison_id` 재발급, 이전 번호 선택 시 `stale_comparison` |
| 4 | "3만원 이하" 후 0건 | 롤백 + `refine_empty` 안내 |
| 5 | "M185 말고 M240" | identity 재확정부터 재실행 |
| 6 | 페이징 미지원 사이트 포함 | 해당 사이트만 1페이지, 나머지는 정상 페이징 |
| 7 | 소형 컨텍스트 프로파일 | `view_page_size=3`, 라인 길이 예산 준수 |

각 시나리오는 mutation 없이 승인 게이트 직전까지만 실행한다.

---

## 10. 구현 순서

1. **레이어 A 어댑터 계약**: `pagination` config + `page` 인자 + `has_more`. 사이트 1곳(가장 안정적인 곳)만 먼저 적용해 라이브 확인.
2. 수집 중단 규칙과 dedupe, `source_page` 증빙.
3. 나머지 사이트에 `pagination` config를 라이브 확인하며 하나씩 추가. 확인 못 한 사이트는 미지원으로 둔다.
4. **레이어 B 창 렌더링**: `AX_rank_store_offers`에서 렌더링 분리, `view_*` 상태, 전역 번호, 길이 예산.
5. `choose_store_offer` enum 확장 + `next="page"` self-loop. conformance 단언 추가.
6. **레이어 C1**: 필터 파서 + `refine_offers` 노드의 `view` 분기.
7. **레이어 C2**: `research`/`relock` 분기와 승인 무효화 규칙.
8. 라이브 시나리오 7종 검증.

1~3단계와 4~5단계는 독립적이므로 병렬 진행할 수 있다. 6~7은 4~5 이후다.

---

## 11. 확정된 결정 (사용자 승인)

1. **페이지 예산**: 1차는 **2페이지**(`P.DEFAULT_MAX_PAGES = 2`, 사이트 config `max_pages: 2`).
2. **소형 컨텍스트 프로파일 판정**: 보류. 창 렌더링은 모델과 무관하게 항상 적용한다(프로파일 분기 없음).
3. **`view_page_size` 사용자 조절**: 보류. 페이지 크기는 `C.VIEW_PAGE_SIZE = 5` 고정.
4. **Thumbtack 적용**: 이번 범위에 포함. 후보 목록 랭킹·선택을 결정적 브라우저로 이관했다.

---

## 12. 구현 결과 (TDD, 라이브 검증 완료)

설계 대비 실제 구현에서 바뀐 점만 적는다. 나머지는 위 설계 그대로다.

### 12.1 추가·변경된 파일

| 파일 | 역할 |
|---|---|
| `_common/scripts/44_pagination.lua` | `AX_PAGINATION` — 페이지 계획(`plan_page`), 누적(`merge_pages`), 중단 규칙(`should_continue`). 순수 모듈 |
| `_common/scripts/45_offer_view.lua` | `AX_OFFER_VIEW` — refine 파서, 필터/정렬, 페이지 경계, 창 렌더링, 스냅샷 서명. 순수 모듈 |
| `_common/scripts/46_candidate_browser.lua` | `AX_browse_service_candidates` — Thumbtack 전문가 목록 랭킹·창·선택 |
| `_common/scripts/50_commerce.lua` | `AX_collect_store_page` 신설, `AX_rank_store_offers`/`AX_present_store_offers` 창 기반으로 교체, `AX_refine_store_offers` 신설, `MAX_RANKED_OFFERS` 6 → 15 |
| `_common/scripts/60_storefront.lua` | `S.page_plan`/`S.has_more_from`/`S.next_control_present`, `search`의 `page` 인자와 `has_more`·`page` 반환, 페이지 인지 네비게이션 |
| `amazon/scripts/search.lua`, `ebay/scripts/00_common.lua`+`search.lua` | 전용 어댑터에도 동일한 `page` 계약 적용 |
| `walmart|ssg|aliexpress/scripts/00_common.lua` | `pagination` config 추가(라이브 확인된 사이트만) |
| `_common/flows.yaml` | 워커 페이지 루프(`collect`/`search_next_page`), `browse_offers` 노드, `shopping_collect_store_page`·`shopping_refine_store_offers`·`browse_service_candidates` flowTool, Thumbtack `refine_search` 재작성 |
| `tools/lua/*` | fengari 기반 Lua 단위 테스트 하네스와 5개 스위트(89 테스트), `npm run test:lua` |

### 12.2 설계와 달라진 점

- **스냅샷은 Lua 전역에 둘 수 없다.** 턴마다 Lua 컨텍스트가 새로 만들어져 `C.current_comparison`은 다음 턴에 사라진다(라이브에서 `stale_comparison`으로 재현). 그래서 **offer 목록은 flow 상태로 이동**시키고(결정적 노드 `browse_offers`가 `inputSelector`로 읽는다 — 프롬프트 비용 0), 모델이 호출하는 `AX_present_store_offers`만 **`session_state`에 렌더링된 창 텍스트**를 남겨 읽는다. `session_state`는 **문자열 값만 허용**하므로(`axsdk-core` `setLuaSessionState`) 테이블은 저장되지 않는다 — 테스트 픽스처도 이 제약을 그대로 강제한다.
- **`no_results`는 중단 사유가 아니다.** 1페이지가 전부 무관한 결과일 때가 2페이지를 읽어야 하는 대표 상황이다. 차단(captcha/login/access)만 즉시 중단한다.
- **`has_more`가 없으면 더 없는 것으로 본다.** 어댑터가 알 수 없다고 답한 경우 추측으로 네비게이션을 쓰지 않는다.
- **coupang·naver-shopping은 pagination 미지원으로 둔다.** coupang은 `?page=2`가 항상 빈 그리드를 반환하고(라이브 확인), 온페이지 컨트롤은 해시 클래스 버튼이라 `AGENTS.md` §10 위반이다. naver는 봇 월 때문에 2페이지를 관측하지 못했다. 확인 못 한 파라미터는 넣지 않는다.
- **`refine_candidates`에서 `refine_selected`를 제거**했다. 모델이 전문가 목록을 다시 써 내려가던 경로가 사라지고, 선택은 번호 → `AX_browse_service_candidates`가 수행한다.

### 12.3 검증

- 오프라인: `npm run test:lua` 89, `npm run check:flows` 7, `npm run test:playground` 42, `npm run build:lua:check` 13 번들.
- 라이브(레이어 A): ssg 1페이지 24행·관련 0 → 수집기가 `more` → **2페이지 실제 이동·재판독** → `no_more_pages`로 종료(`pages_read: 2`). 페이지 파라미터 확인: ssg·walmart·aliexpress·amazon(`page`), ebay(`_pgn`, 코드만 — 라이브 결과 0행이라 미확인).
- 라이브(레이어 B): 8개 offer → `총 8개 중 1-5번 (1/2 페이지)` → `다음` → `6-8번 (2/2 페이지)`(전역 번호 유지, 같은 `comparison_id`) → **페이지 네비게이션으로 Lua 컨텍스트를 파괴한 뒤에도** `AX_present_store_offers`가 같은 창을 반환 → `무료배송만` → 4개로 축소되며 `comparison_id` 재발급.
- 라이브(플로우 전체): `SSG, 아마존, 알리익스프레스에서 로지텍 M170 …` → 창 표시, `무료배송만 보여줘` → 3 → 2개 축소(22초, 재검색 없음), `필터 해제` → 3개 복원.
- 라이브(Thumbtack): `리뷰 많은 순` 창 → `다음`(4-6번) → `1, 3` 다중 선택 → `성실` 키워드 2명.
