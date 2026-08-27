# CWS 제출 — 사람이 답해야 하는 12건 초안

작성 2026-08-27 · SITES 초안 · **확정 전까지 어떤 문서에도 반영하지 않았습니다.**
`npm run check:listing`이 세는 12건과 1:1로 대응합니다. 각 항목은 셋 중 하나로 표시했습니다:

- **[초안]** — 제가 문구까지 썼습니다. 사실관계가 맞으면 그대로 반영합니다.
- **[확정 필요]** — 제가 알 수 없는 값입니다. 값만 주시면 문구는 제가 맞춥니다.
- **[승인 필요]** — 제가 할 수 있지만 계정/데이터를 건드리므로 허락이 필요합니다.

---

## A. 백엔드 데이터 (5건) — `docs/privacy.md:72,83,105,140,148,159,184`

이 다섯은 서로 물려 있어 한 묶음입니다. **코드가 강제하지 않는 정책 진술**이라는 점이 중요합니다 —
공시한 기간이 실제로 지켜지도록 백엔드에 보관 정책이 있어야 하고, 없으면 공시가 거짓이 됩니다.

### A1. 세션·메시지 보관 기간 — **[확정 필요]**

제안: **30일 후 삭제**(운영 지표는 집계·익명화 형태로만 남김).

> | AXSDK 백엔드 | 세션과 메시지 | **30일**, 그 후 삭제 |

30일을 제안하는 이유: 심사자가 "필요 최소"를 판단할 때 무기한(`indefinite`)은 Limited Use에서 방어가
어렵고, 지원 문의 대응에 필요한 기간으로 30일이 관행적입니다. **백엔드가 실제로 30일에 지우는지**를
확인해 주셔야 합니다. 지우지 않는다면 지금 값(예: 90일 · 무기한)을 그대로 적는 것이 정직합니다.

### A2. 삭제 요청 채널과 처리 기간 — **[확정 필요]** (A5의 이메일과 같은 주소)

제안:

> - **백엔드 보관분**: 아래 지원 이메일로 요청하시면 **영업일 7일 이내** 삭제하고 완료를 회신합니다.

### A3. 사람에 의한 접근 절차 — **[초안]**

제안 문구(영/한 양쪽 같은 내용):

> 저장된 대화에 사람이 접근하는 것은 **두 경우뿐**입니다: ① 사용자가 지원을 요청하고 그 대화를 지목한
> 경우, ② 보안 사고 조사. 두 경우 모두 접근은 지정된 운영자에 한정되고 기록됩니다. 그 밖의 목적(광고,
> 프로필링, 모델 학습)으로는 접근하지 않습니다.

확인해 주실 것: **지정된 운영자**가 실제로 정해져 있는지, 접근 로그가 남는지. 없으면 문구를 약하게
고쳐야 합니다("사용자 요청 또는 보안 사고 시에만 접근합니다"까지만).

### A4. 하위 처리자(모델 공급자) 명칭 — **[확정 필요]**

정책은 **이름을 요구**합니다. 저장소에서 확인되는 것은 모델 식별자 `openai/gpt-oss-120b` 하나이고,
그것을 **서비스하는 사업자**는 백엔드 설정에 있어 제가 알 수 없습니다. 확정 후 문구:

> **하위 처리자**: 대화 텍스트는 언어모델 추론을 위해 `<사업자명>`(`openai/gpt-oss-120b` 모델)에
> 전달됩니다. 그 밖의 제3자에게는 전달되지 않습니다.

### A5. 공개 연락 이메일 — **[확정 필요]** · `docs/support.md:19,64`

제안: `axsdk-support@lilysnc.com` (커밋 신원의 도메인 `lilysnc.com` 기준 추정입니다 — **추정이므로
반드시 확인**해 주십시오). 개인정보·삭제 요청과 지원 문의를 같은 주소로 받는 것을 권합니다: 주소가
둘이면 심사자가 어느 쪽이 유효한지 확인할 수 없습니다.

---

## B. 리스팅 (2건)

### B1. 영어 상세 설명 — **[초안]** · `store/listing.md:122`

단일 목적 문장에서 유도했고, 패키지가 실제로 하는 일만 적었습니다(견적·메모리·사이트 탐색 없음):

> **AXSDK Shopping Assistant compares one product's total cost across the stores you choose.**
>
> Tell it what you want to buy and which stores to check. It opens each store's own search, reads the
> product name, price and shipping fee from the results, converts them to one currency, and shows a
> numbered comparison of the total cost — item price plus shipping, not just the sticker price. Rows whose
> shipping is unknown are folded away and counted, so a missing fee never looks like a free one.
>
> You choose by number. Only then does it add that one offer to that store's cart, after re-reading the
> product page to confirm the model and price still match what you compared. It can then open the store's
> checkout page so you can review the order.
>
> **It never places an order and never pays.** Payment and order placement are always yours.
>
> Supported stores: Amazon, Walmart, eBay, AliExpress, Etsy, Coupang, Naver Shopping, Gmarket, 11st, SSG.
>
> The assistant reads only the page you are on, and only while you are using it. It stores no contact
> details: this release has no memory feature.

확인해 주실 것: 마지막 두 단락의 톤(방어적으로 정확한 편입니다). 심사자가 읽는 문장이라 "never places an
order"를 굵게 두는 편을 권합니다.

### B2. `4-cart.png` 재촬영 — **[승인 필요]** · `store/listing.md:161`

현재 캡처의 장바구니에 **이전 테스트 잔여 5건**이 함께 보입니다. 빈 장바구니에서 다시 찍으려면
**실제 Amazon 계정의 장바구니를 비워야** 합니다. 제가 자동으로 비우지는 않았습니다 — 계정 데이터입니다.

셋 중 골라 주십시오:
1. **직접 비우신 뒤** 알려주시면 제가 재촬영합니다(권장, 3분).
2. 제가 장바구니를 비우는 것을 승인 (스크린샷 촬영 목적, 5건 삭제).
3. 그대로 제출 — 잔여 품목이 보이지만 기능 설명에는 문제가 없습니다. 다만 심사자가 "무엇을 담았는지"
   혼동할 여지가 있어 권하지 않습니다.

---

## C. 이미 결정으로 닫을 수 있는 것 (1건)

### C1. `store/permissions.md:153` — **[초안, 즉시 반영 가능]**

원래 문구는 "One Stop Support 답변 수령 후 이 칸의 최종 문구 확정"입니다. 그런데 **D7은 생략으로
결정**됐습니다(비공개 Unlisted 심사가 더 빠른 답이라는 판단). 따라서 이 칸은 답변을 기다릴 대상이
아니고, 지금 문구로 확정하면 됩니다 — 승인해 주시면 이 항목은 제가 바로 닫습니다.

---

## 정리 — 제가 받아야 하는 값 5개

| # | 값 | 없으면 |
|---|---|---|
| A1 | 보관 기간 (일수 또는 "무기한") | 공시 칸을 비워 제출 불가 |
| A2 | 삭제 처리 기간 (제안: 영업일 7일) | 같음 |
| A4 | 모델 공급 사업자명 | 하위 처리자 미기재 = 정책 위반 |
| A5 | 공개 이메일 (제안: `axsdk-support@lilysnc.com`) | 지원·삭제 요청 채널 없음 |
| B2 | 장바구니 비우기 방식 1·2·3 중 택1 | 잔여 품목이 보이는 캡처로 제출 |

A3·B1·C1은 **초안대로 승인**만 해주시면 제가 반영합니다.
