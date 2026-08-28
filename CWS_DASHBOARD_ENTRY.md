# CWS 대시보드 입력표 — 사람이 눌러야 하는 것만

작성 2026-08-27 · 출처는 모두 이 저장소의 확정 문서(`docs/privacy.md`, `docs/support.md`,
`store/listing.md`, `store/permissions.md`)이며, 값을 새로 정하지 않았습니다. `check:listing`이 검사하는
마커는 이 표의 값들로 이미 0개입니다(리스팅 캡처 1건만 별도로 열려 있음).

이 파일은 **대시보드에서만 할 수 있는 입력**을 모아둔 것입니다. 저장소에서 할 수 있는 일은 이미 반영돼
있으므로, 아래는 붙여넣기와 체크박스뿐입니다.

---

## 1. Privacy practices — 데이터 사용 공시 (Data usage)

| 항목 | 입력할 값 | 근거 |
|---|---|---|
| Personally identifiable information | **수집하지 않음(No)** | `docs/privacy.md` — 대화·트레이스·설정은 **로컬 브라우저 저장소**, 확장 제거 시 함께 삭제. 이름·이메일·전화·주소를 저장하는 기능이 없다 |
| Health information | No | 해당 기능 없음 |
| Financial and payment information | No | 결제는 스토어 자신의 페이지에서 사용자가 진행. 확장은 **주문을 넣지 않음**(`68_rpc_checkout.lua`는 검토만 읽음) |
| Authentication information | No | 자격증명을 읽거나 저장하지 않음 |
| Personal communications | No | |
| Location | No | |
| Web history | **No** | 방문 이력을 수집하지 않음. 사용자가 요청한 그 페이지만 읽는다 |
| User activity | **Yes** — 세션·메시지 | 백엔드에 세션과 메시지가 **30일** 보관된 뒤 삭제 |
| Website content | **Yes** — 요청한 페이지의 상품 정보 | 비교·장바구니를 위해 사용자가 지목한 스토어 페이지를 읽음 |

**보관·삭제 문구(그대로 사용 가능)**

- 보관: `Sessions and messages are kept 30 days, then deleted.`
- 삭제 요청 채널: `support@layorix.ai` — `Backend deletion within 7 business days` (요청 완료 시 회신)

## 2. Limited Use 확약 (Certification)

세 항목 모두 **동의(체크)**. 근거 문장은 `docs/privacy.md`의 Limited Use 절에 이미 있습니다:

1. 사용 목적 제한 — 단일 목적(지원 스토어 총비용 비교 · 장바구니 담기 · 결제 페이지 검토) 외 사용 없음.
2. 제3자 전송 제한 — 광고·프로파일링·데이터 브로커 판매 없음. 모델 추론 위임은 하위 처리자 공시로 처리.
3. 사람의 접근 제한 — 사용자의 명시적 요청, 보안 목적, 법적 요구, 또는 **집계·익명화된 형태**에 한정.

## 3. 하위 처리자(모델 공급자) 공시

| 항목 | 값 |
|---|---|
| 사업자 | **OpenRouter** |
| 모델 | `openai/gpt-oss-120b` |
| BYOK | 사용자가 자기 키를 넣으면 그 공급자로 전달됨(공시 반영됨) |

## 4. Distribution

| 항목 | 값 | 결정 |
|---|---|---|
| Visibility | **Unlisted** | D3 = c (2026-08-26) |
| 지역 | 전체 | `store/listing.md` |

## 5. 남은 저장소 작업 1건 (제 몫, 대시보드 아님)

`store/listing.md:186`의 마커 — `4-cart.png`를 **빈 장바구니**에서 재촬영. 2026-08-27 현재 촬영이 막힌
이유는 스토어 접근 상태이며, 측정값은 `CWS_BIZ_ANSWERS_DRAFT.md`의 재시도 기록에 있습니다.
