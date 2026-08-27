# 스토어 리스팅 (Store listing 탭)

대시보드에 붙이는 문안. 단일 목적은 `store/single-purpose.md`, 권한 소명은 `store/permissions.md`.

---

## 제품명

```
AXSDK Shopping Assistant
```

현재 매니페스트의 `AXSDK Assistant (CDP)`에서 `(CDP)`는 내부 빌드 구분자이므로 스토어명에서 제거한다.

## 짧은 설명 (132자 이내)

```
여러 쇼핑몰의 배송비 포함 총액을 한 번에 비교하고, 고른 상품을 장바구니까지 담아 줍니다. 주문은 하지 않습니다.
```

```
Compares total cost with shipping across stores, then adds the product you chose to that store's cart. Never orders.
```

## 상세 설명

```
같은 상품이 어느 스토어에서 실제로 더 싼지 알려면 배송비까지 더해 봐야 합니다. AXSDK는 그 계산을 대신
합니다.

무엇을 하나요
· 요청한 상품을 지원 스토어에서 찾고, 상품가와 배송비를 더한 총액으로 나란히 비교합니다
· 같은 제조사 모델인지 확인한 뒤 비교합니다 — 액세서리나 다른 모델이 섞이지 않습니다
· 배송비를 알 수 없는 행은 0원으로 가정하지 않고 "미확인"으로 접어 두고, 몇 건이 접혔는지 알려줍니다
· 조건을 말하면(예: "3만원 이하만", "평점 높은 순") 그 자리에서 다시 정리합니다
· 고른 상품을 그 스토어 장바구니에 담고, 장바구니 페이지에서 상품이 맞는지 다시 확인합니다
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

지원 스토어
Amazon, eBay, Walmart, AliExpress, Etsy, 쿠팡, 11번가, G마켓, SSG, 네이버쇼핑(읽기 전용)

개인정보: https://layorixinc.github.io/axsdk-sites/privacy.html
지원: https://layorixinc.github.io/axsdk-sites/support.html
```

## 카테고리 · 언어

- 카테고리: Shopping
- 언어: 한국어, English — 매니페스트 이름·설명·툴바 툴팁은 `_locales/{en,ko}` 에서 오고(기본 `en`),
  `assertLocalizedManifest`가 빌드마다 두 로케일의 키 집합과 132자 상한을 검사한다.
  대시보드의 **상세 설명**은 로케일 파일이 아니라 리스팅 입력이다 — <!-- BIZ-CONFIRM: 영어 상세 설명 번역 확정 -->

## URL

| 칸 | 값 |
|---|---|
| Homepage URL | `https://layorixinc.github.io/axsdk-sites/` |
| Support URL | `https://layorixinc.github.io/axsdk-sites/support.html` |
| Privacy policy URL | `https://layorixinc.github.io/axsdk-sites/privacy.html` |

GitHub Pages 설정: 저장소 **Settings → Pages → Deploy from a branch → `main` / `/docs`**. 저장소가
공개이므로 별도 호스팅이 필요 없다.

## 그래픽 산출물 (아직 없음)

| 칸 | 규격 | 상태 |
|---|---|---|
| 스토어 아이콘 | 128×128 | 패키지에 있음(`assets/icon-128.png`) — 그대로 사용 가능 |
| 스크린샷 | 1280×800, 1~5장 | <!-- BIZ-CONFIRM: 촬영 필요 — 비교 창, 조건 정리, 장바구니 확인, 결제 화면 정지 --> |
| 작은 프로모 타일 | 440×280 | <!-- BIZ-CONFIRM: 제작 필요 --> |
| 마키 타일 | 1400×560 (선택) | 생략 가능 |
| 프로모 영상 | YouTube (선택) | 생략 |

스크린샷은 **실제 동작 화면**이어야 한다. 이 저장소의 라이브 시나리오가 그 화면을 만든다:
`npm run test:commerce:live` (비교 → 선택 → 장바구니 → 결제 검토).

## 배포 (Distribution 탭)

- Visibility: **결정 D3에 따름** — 소비자 로그인이 없으므로 첫 릴리스는 비공개(Unlisted)를 권고
- 지역: All regions
