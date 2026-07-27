# AXSDK Chrome Extension Agentic Task Research

## 1. 목적

이 문서는 글로벌·한국 주요 웹사이트 카테고리에서 사용자에게 유용하고 가치가 높으며, AXSDK의 agentic 실행 능력을 홍보하기 좋은 task를 도출한다.

초기 구현 형태는 Chrome Extension이다. 따라서 단순 질의응답이나 페이지 요약보다 다음 흐름을 우선한다.

> 현재 페이지 이해 → 여러 탭·사이트 조사 → 결과 정규화·비교 → 사용자 선택 → 명시적 승인 → 실제 작업 → 완료 증빙

## 2. 결론

첫 MVP 및 공개 데모에 가장 적합한 task는 다음과 같다.

1. 다중 쇼핑몰 최적 구매
2. 레시피에서 장바구니까지
3. 채용공고 맞춤 지원 Copilot
4. 유연한 날짜의 여행 최적화
5. 통합 배송 조회·반품 처리

이 task들은 다음 조건을 충족한다.

- 금전·시간 절약이 명확하다.
- 현재 페이지, 로그인 세션, 탭 이동이라는 Chrome Extension의 장점을 활용한다.
- 검색에 그치지 않고 외부 상태를 실제로 변경한다.
- 실행 전후 차이와 완료 결과를 화면으로 보여주기 쉽다.
- 사용자 승인 지점을 구조화할 수 있다.

## 3. 시장 및 기술 근거

### 3.1 경쟁 제품이 제시한 browser agent 기준

Google은 2026년 Chrome Auto Browse 사례로 다음 작업을 공개했다.

- 여러 탭의 옵션 비교
- 여러 사이트의 상품 리뷰 요약
- 여러 날짜의 항공·숙박 비용 비교
- 아파트 조건 검색
- 약속 예약
- 온라인 폼 작성
- 세금 문서 수집
- 견적 요청
- 청구서 납부 여부 확인
- 경비 보고서 작성
- 구독 관리
- 운전면허 갱신
- 상품 검색 및 장바구니 추가

따라서 페이지 요약만으로는 AXSDK의 차별성이 약하다. AXSDK는 사이트별 구조화된 계약, 결정적 흐름, 권한 제한, 상태 보존, 실행 전 승인, 완료 검증을 보여줘야 한다.

OpenAI CUA가 공개한 소규모 시험에서는 반복적인 단순 UI 작업은 높은 성공률을 보였지만, Redfin 복합 부동산 검색은 3/10에 그쳤다. 장소 예약 작업은 사이트 사용법을 상세히 제공했을 때 3/10에서 8/10으로 개선됐다. 이는 범용 시각 에이전트가 복잡한 사이트에서 여전히 task와 UI 구조에 크게 의존한다는 근거다.

**[추론]** AXSDK가 사이트별 도구 스키마와 `flows.yaml` 계약을 통해 허용 도구, 필수 필드, 전환, 동의를 구조화하면 범용 DOM agent보다 높은 신뢰성을 차별화 포인트로 삼을 수 있다. 실제 우위는 사이트별 live scenario로 검증해야 한다.

## 4. 평가 기준

아래 우선순위와 점수는 **[추론] 예비 평가**다.

- **가치**: 시간, 비용, 오류를 줄이는 정도
- **홍보성**: 짧은 데모에서 실행 전후 차이가 명확한 정도
- **구현성**: Chrome Extension과 현재 AXSDK 패턴으로 안정적으로 만들기 쉬운 정도
- 각 항목 5점 만점이며 구현성 5점은 상대적으로 구현하기 쉽다는 의미다.
- `P0`은 첫 데모 후보, `P3`은 초기 실제 mutation에서 제외하거나 강하게 제한할 대상이다.

## 5. 카테고리별 Agentic Task

아래 사이트는 각 task를 구현·시연할 수 있는 대표 후보이다. 목록 포함은 제휴, 공개 API 제공, 자동화 허용 또는 DOM 안정성을 의미하지 않으며 실제 구현 전에 사이트별 약관, 권한, 로그인, CAPTCHA, adapter 가능성을 별도로 검증해야 한다.

### 5.1 이커머스·가격 비교

**우선순위: P0 · 가치 5 / 홍보성 5 / 구현성 4**

#### 대표 사이트와 주소

- 글로벌: [Amazon](https://www.amazon.com/), [Walmart](https://www.walmart.com/), [eBay](https://www.ebay.com/), [AliExpress](https://www.aliexpress.com/), [Etsy](https://www.etsy.com/)
- 한국: [쿠팡](https://www.coupang.com/), [네이버쇼핑](https://shopping.naver.com/), [G마켓](https://www.gmarket.co.kr/), [11번가](https://www.11st.co.kr/), [SSG.COM](https://www.ssg.com/)

#### 추천 Agentic Task 5가지

1. **다중 쇼핑몰 총비용 최적 구매** — 현재 상품의 정확한 모델과 옵션을 추출하고 여러 쇼핑몰에서 동일 상품을 찾아 가격, 배송비, 도착일, 평점, 반품 조건을 정규화한다. `이 노트북과 같은 사양을 쿠팡, G마켓, 11번가에서 비교해 가장 가성비 좋은 제품을 장바구니에 넣어줘` 같은 요청을 처리한다. 비교표 제시, 상품 확인, 장바구니 추가, 별도 체크아웃 승인까지 완료한다.
2. **호환 제품·액세서리 번들 구성** — 현재 보고 있는 본체의 모델 번호와 규격을 읽고 충전기, 케이스, 메모리, 소모품처럼 호환성이 필요한 상품을 여러 사이트에서 찾는다. 제조사 호환 정보와 판매 페이지의 옵션을 교차검증하고 예산 내 번들을 장바구니에 준비한다. 호환 근거가 없는 상품은 자동 제외한다.
3. **장바구니 예산·배송 최적화** — 현재 장바구니를 읽어 중복 상품, 최소 주문금액, 묶음 배송, 쿠폰, 멤버십, 도착일을 분석한다. 상품 수량이나 판매자를 조정한 대안을 계산해 절약액과 배송 차이를 보여준다. 사용자가 선택한 변경만 적용하고 결제는 수행하지 않는다.
4. **리뷰 기반 품질 위험 분석과 대체품 탐색** — 여러 사이트의 리뷰에서 반복되는 고장, 사이즈 편차, 배송 문제, 광고와 실제 사양의 차이를 추출한다. 리뷰 수와 최신성을 함께 표시하고 같은 가격대의 대체품을 비교한다. 추천 근거와 반대 근거를 모두 제시한 뒤 선택 상품 페이지를 연다.
5. **복수 상품 조건부 구매 계획** — 선물, 사무용 비품, 이사 준비처럼 여러 상품이 필요한 요청을 품목별 하위 작업으로 나눈다. 전체 예산, 도착 마감일, 브랜드 제외 조건을 만족하도록 사이트별 후보를 모으고 주문 묶음을 구성한다. 품목별 선택과 전체 금액을 확인받은 뒤 각 장바구니를 준비한다.

홍보 포인트:

- 여러 쇼핑몰 탭이 하나의 비교표와 실행 가능한 장바구니로 바뀐다.
- 절약 금액, 배송시간, 제외한 후보를 숫자로 보여줄 수 있다.

안전 경계:

- 상품 옵션과 가격을 행동 직전에 다시 읽는다.
- 장바구니 추가와 체크아웃은 서로 다른 승인 단계로 유지한다.

### 5.2 여행·숙박·교통

**우선순위: P0 · 가치 5 / 홍보성 5 / 구현성 3**

#### 대표 사이트와 주소

- 글로벌: [Booking.com](https://www.booking.com/), [Trip.com](https://www.trip.com/), [Airbnb](https://www.airbnb.com/), [Agoda](https://www.agoda.com/), [Expedia](https://www.expedia.com/)
- 한국: [코레일](https://www.letskorail.com/), [NOL](https://nol.yanolja.com/), [여기어때](https://www.goodchoice.kr/), [하나투어](https://www.hanatour.com/), [모두투어](https://www.modetour.com/)

#### 추천 Agentic Task 5가지

1. **유연한 날짜의 항공·숙박 총액 최적화** — 출발지, 목적지, 인원, 예산, 날짜 허용 범위를 수집하고 날짜 조합별 항공권과 숙소를 검색한다. 수하물, 세금, 수수료, 취소 조건을 포함한 총액으로 정규화해 상위 조합을 제시한다. 선택 후 예약 폼을 채우고 결제 단계에서 사용자에게 제어권을 반환한다.
2. **예약 이메일 기반 통합 여행 일정 구성** — 이메일과 현재 열린 예약 페이지에서 항공, 숙박, 철도, 렌터카 정보를 추출한다. 시간대와 이동시간을 정규화하고 누락된 구간이나 일정 충돌을 탐지한다. 확정 일정, 필요한 추가 예약, 체크인 마감시간을 정리해 캘린더 초안을 만든다.
3. **지연·취소 시 대체편 탐색과 재예약 준비** — 현재 예약과 항공사 공지를 확인해 지연 또는 취소 영향을 계산한다. 원래 목적과 예산을 최대한 유지하는 대체 항공, 철도, 숙박 연장안을 비교한다. 변경 수수료와 환불 조건을 보여주고 선택한 변경 절차를 최종 제출 직전까지 진행한다.
4. **그룹 여행 후보 수집과 합의 도출** — 참여자의 출발지, 예산, 선호 일정, 필수 조건을 모아 공통으로 가능한 여행 조합을 만든다. 후보별 비용과 불편 요소를 비교하고 각 참여자의 제약을 충족하지 못하는 이유를 표시한다. 선택된 안의 예약 링크와 분담 금액을 준비한다.
5. **출장 정책 준수 예약·경비 패키지** — 회사의 출장 정책과 행사 이메일을 읽고 허용 운임, 숙박 상한, 영수증 조건에 맞는 항공과 숙소를 찾는다. 정책 위반 항목을 사전에 표시하고 예약 후 영수증과 일정 정보를 경비 보고서 초안으로 연결한다. 예약과 보고서 제출은 각각 확인받는다.

홍보 포인트:

- 수십 개 항공·숙박 탭을 총액 기준의 실행 가능한 소수 조합으로 줄인다.
- 예약 전후의 일정과 경비 처리까지 하나의 흐름으로 연결한다.

안전 경계:

- 예약 가능성과 가격을 선택 직후 재검증한다.
- 승객 정보 제출, 예약 변경, 결제는 명시적 승인 또는 사용자 직접 조작으로 제한한다.

### 5.3 채용·구직·커리어

**우선순위: P0 · 가치 5 / 홍보성 5 / 구현성 4**

#### 대표 사이트와 주소

- 글로벌: [LinkedIn Jobs](https://www.linkedin.com/jobs/), [Indeed](https://www.indeed.com/), [Glassdoor](https://www.glassdoor.com/), [ZipRecruiter](https://www.ziprecruiter.com/), [Wellfound](https://wellfound.com/jobs)
- 한국: [잡코리아](https://www.jobkorea.co.kr/), [사람인](https://www.saramin.co.kr/), [원티드](https://www.wanted.co.kr/), [고용24](https://www.work24.go.kr/), [인크루트](https://www.incruit.com/)

#### 추천 Agentic Task 5가지

1. **다중 채용 사이트 맞춤 공고 Shortlist** — 희망 역할, 급여, 위치, 원격근무, 기술 조건을 수집하고 여러 채용 사이트를 검색한다. 중복 공고를 병합하고 필수 조건과 사용자 경력의 일치 근거를 계산한다. 지원 가치가 높은 공고와 제외 사유를 함께 보여주고 저장 목록을 만든다.
2. **공고별 사실 기반 적합성 분석** — 현재 채용공고의 필수·우대 조건을 사용자 이력서의 경력, 기술, 성과와 대조한다. 각 조건을 `충족`, `부분 충족`, `근거 없음`으로 분류하고 근거가 있는 이력서 문장을 연결한다. 지원 여부 결정에 필요한 부족 조건과 질문 목록을 반환한다.
3. **공고 맞춤 이력서·자기소개서 패키지** — 선택한 공고와 기존 이력서를 바탕으로 관련 경력의 순서와 표현을 조정하고 자기소개서 초안을 만든다. 공고 키워드를 기계적으로 복사하지 않고 실제 경력에 근거한 문장만 사용한다. 변경 전후와 근거를 보여주고 사용자가 승인한 문서만 저장한다.
4. **지원 폼 완성·제출 보조** — 채용 사이트의 기존 프로필과 지원 폼을 읽어 자동 입력 가능한 필드, 누락 필드, 서술형 질문을 분류한다. 검증된 정보만 채우고 불확실한 답변은 사용자에게 질문한다. 전체 지원서를 미리 보여준 뒤 해당 공고에 대한 개별 승인을 받아 제출한다.
5. **지원 현황·면접·후속 연락 관리** — 이메일과 채용 사이트에서 접수, 과제, 면접, 탈락, 추가 요청 상태를 추출한다. 마감일과 면접 일정을 캘린더 초안으로 만들고 공고 내용에 근거한 면접 질문과 후속 메일을 준비한다. 일정 생성과 메일 전송은 별도로 승인받는다.

홍보 포인트:

- 현재 보고 있는 공고에서 지원 문서와 폼까지 실제로 완성된다.
- 허위 없는 근거 연결을 보여줘 범용 글쓰기 도구와 차별화한다.

안전 경계:

- 대량 자동 지원을 제외한다.
- 허위 경력, 과장, 사용자가 확인하지 않은 답변을 만들지 않는다.
- 공고별 개별 승인 후 제출한다.

### 5.4 부동산·주거 탐색

**우선순위: P1 · 가치 5 / 홍보성 5 / 구현성 3**

#### 대표 사이트와 주소

- 글로벌: [Zillow](https://www.zillow.com/), [Realtor.com](https://www.realtor.com/), [Redfin](https://www.redfin.com/), [Rightmove](https://www.rightmove.co.uk/), [Apartments.com](https://www.apartments.com/)
- 한국: [네이버 부동산](https://land.naver.com/), [직방](https://www.zigbang.com/), [다방](https://www.dabangapp.com/), [호갱노노](https://hogangnono.com/), [KB부동산](https://kbland.kr/)

#### 추천 Agentic Task 5가지

1. **다중 사이트 실거주비 기반 매물 Shortlist** — 보증금, 월세, 관리비, 면적, 층, 준공연도, 중개비를 정규화하고 중복 매물을 병합한다. 보증금 환산 기준과 월 예상 비용을 명시해 상위 매물을 선택한다. 선택 결과와 원본 매물 링크를 저장한다.
2. **동일 매물 가격·정보 불일치 감사** — 주소, 사진, 면적, 층, 중개사 정보를 이용해 여러 사이트의 동일 매물을 연결한다. 가격, 관리비, 계약 형태, 등록일이 다른 부분을 표시하고 더 오래되거나 불완전한 게시물을 구분한다. 확인이 필요한 질문을 중개 문의 초안으로 만든다.
3. **통근·생활 동선 적합성 평가** — 직장, 학교, 병원, 대중교통 같은 사용자의 목적지를 수집해 후보 매물별 시간대별 이동시간을 계산한다. 월 주거비와 통근시간을 함께 비교하고 영업시간이 있는 시설의 실제 이용 가능성도 확인한다. 보호 특성을 사용하지 않고 기능적 조건만 평가한다.
4. **복수 매물 방문 일정과 중개 문의 자동화** — 선택한 매물의 중개 가능 시간과 사용자의 캘린더를 비교해 현실적인 방문 순서를 만든다. 매물별 확인 질문과 방문 요청 메시지를 준비하고 중복 시간 또는 과도한 이동을 제거한다. 문의 전 수신처와 내용을 보여주고 승인받는다.
5. **계약 전 공개정보·서류 체크리스트 준비** — 매물 유형과 계약 방식에 맞춰 확인할 등기, 건축물, 실거래가, 관리비, 보증 관련 공개정보 경로를 정리한다. 사용자가 확보한 문서에서 누락 항목과 서로 다른 정보를 표시한다. 법률 판단 대신 전문가에게 확인할 질문 목록을 만든다.

홍보 포인트:

- 표시 가격이 아니라 관리비와 통근비용까지 포함한 실제 선택을 지원한다.
- 여러 사이트의 중복·불일치를 자동으로 드러낸다.

안전 경계:

- 보호 특성을 직접 또는 대리 변수로 추론하거나 필터링하지 않는다.
- 법적 권리 분석이나 계약 안전을 보장하지 않는다.

### 5.5 업무·생산성·협업

**우선순위: P1 · 가치 5 / 홍보성 4 / 구현성 3**

#### 대표 사이트와 주소

- 글로벌: [Gmail](https://mail.google.com/), [Google Calendar](https://calendar.google.com/), [Microsoft 365](https://www.microsoft365.com/), [Notion](https://www.notion.so/), [GitHub](https://github.com/)
- 한국: [네이버 메일](https://mail.naver.com/), [네이버 MYBOX](https://mybox.naver.com/), [네이버웍스](https://naver.worksmobile.com/), [하이웍스](https://www.hiworks.com/), [Dooray!](https://dooray.com/)

#### 추천 Agentic Task 5가지

1. **Inbox에서 Task·Calendar·답장 초안까지** — 이메일에서 실행 항목, 마감일, 담당자를 추출하고 중복을 병합한다. 캘린더 충돌을 확인해 작업 시간과 답장 초안을 제안한다. 업무 도구 생성과 메일 전송은 각각 미리보기 후 승인받는다.
2. **회의 사전 브리핑과 후속 실행** — 회의 초대, 관련 이메일, 문서, 이전 회의록을 찾아 결정사항과 미해결 질문을 정리한다. 회의 후에는 기록에서 담당자와 기한을 추출해 작업과 후속 메일 초안을 만든다. 출처 문서와 생성된 작업을 연결해 검증 가능하게 유지한다.
3. **영수증 기반 경비 보고서 완성** — 이메일, 다운로드 페이지, 카드 영수증에서 날짜, 공급자, 금액, 통화, 세금을 추출한다. 회사 경비 정책과 대조해 누락 증빙과 정책 위반 가능성을 표시한다. 경비 시스템 폼을 채우고 제출 전 전체 보고서를 사용자에게 보여준다.
4. **구독·계정 관리 Concierge** — 여러 SaaS 계정의 요금제, 갱신일, 사용자 수, 사용량을 수집한다. 중복 구독과 사용하지 않는 좌석을 찾아 절감 대안을 제시하고 취소 또는 다운그레이드 경로를 준비한다. 실제 계약 변경은 조건과 효력 발생일을 확인받은 뒤 수행한다.
5. **GitHub·Issue Tracker·Docs 연결 작업 계획** — 현재 PR이나 이슈에서 요구사항, 관련 코드 링크, 설계 문서, 미완료 리뷰를 모은다. 의존성과 담당자를 반영한 실행 순서를 만들고 이슈 또는 프로젝트 보드 초안을 업데이트한다. 저장 전 변경 항목과 링크를 검토받는다.

홍보 포인트:

- 읽지 않은 정보가 실제 작업, 일정, 보고서, 답장 초안으로 바뀐다.
- 여러 SaaS를 오가는 반복 업무를 하나의 side panel에서 처리한다.

안전 경계:

- 이메일 전송, 캘린더 생성, 외부 공유, 계약 변경, 문서 삭제는 별도 승인한다.

### 5.6 배송·물류·반품

**우선순위: P0 · 가치 5 / 홍보성 4 / 구현성 3**

#### 대표 사이트와 주소

- 글로벌: [USPS](https://www.usps.com/), [UPS](https://www.ups.com/), [FedEx](https://www.fedex.com/), [DHL](https://www.dhl.com/), [17TRACK](https://www.17track.net/)
- 한국: [우체국](https://www.epost.go.kr/), [CJ대한통운](https://www.cjlogistics.com/ko/main), [한진택배](https://www.hanjin.com/kor/Main.do), [롯데글로벌로지스](https://www.lotteglogis.com/), [로젠택배](https://www.ilogen.com/)

#### 추천 Agentic Task 5가지

1. **다중 쇼핑몰·배송사 통합 주문 추적** — 주문 페이지와 배송사 조회 페이지에서 주문번호, 상품, 현재 상태, 도착 예정일을 정규화한다. 중복 배송과 지연 가능성을 식별하고 한 화면에 시간순으로 표시한다. 각 상태의 출처와 마지막 확인 시점을 남긴다.
2. **배송 지연·분실 조사와 보상 요청 준비** — 예정일이 지난 주문의 이동 이력과 판매자 정책을 확인해 지연, 분실 가능성, 문의 가능 시점을 판단한다. 필요한 주문정보와 증빙을 모아 판매자 또는 배송사 문의 초안을 만든다. 허위 사유 없이 사용자가 승인한 요청만 전송한다.
3. **교환·반품 방식 최적화** — 반품 기한, 반품비, 재입고 수수료, 교환 재고, 환불 수단을 비교한다. 교환과 반품 후 재구매의 비용·시간 차이를 보여주고 선택한 절차의 폼을 작성한다. 최종 신청 전 회수 주소와 환불 금액을 재확인한다.
4. **배송 일정·주소·수령 방식 변경 보조** — 배송사와 판매자가 허용하는 변경 범위를 확인해 배송일, 수령 장소, 픽업 지점 후보를 보여준다. 사용자의 일정과 충돌하지 않는 옵션을 선택하고 변경 요청을 준비한다. 추가 비용과 책임 조건을 표시한 뒤 승인받는다.
5. **국제배송 통관 문서·상태 관리** — 주문 정보와 배송사 요청에서 품목, 가격, 통관 상태, 필요한 서류를 추출한다. 누락 문서와 제출 경로를 정리하고 공식 안내에 따라 폼 초안을 만든다. 세금 또는 통관 자격을 판단하지 않고 사용자나 전문가가 확인할 항목을 분리한다.

홍보 포인트:

- 여러 쇼핑몰과 배송사의 주문을 하나의 진행 상태로 통합한다.
- 구매 이후의 번거로운 반품과 클레임까지 해결한다.

안전 경계:

- 반품 또는 클레임 사유를 허위로 선택하지 않는다.
- 환불 방식, 비용, 회수 주소를 제출 직전에 다시 표시한다.

### 5.7 지도·장소·로컬 서비스

**우선순위: P1 · 가치 4 / 홍보성 5 / 구현성 3**

#### 대표 사이트와 주소

- 글로벌: [Google Maps](https://maps.google.com/), [Apple Maps](https://maps.apple.com/), [Bing Maps](https://www.bing.com/maps), [OpenStreetMap](https://www.openstreetmap.org/), [Yelp](https://www.yelp.com/)
- 한국: [네이버 지도](https://map.naver.com/), [카카오맵](https://map.kakao.com/), [T map](https://www.tmap.co.kr/), [식신](https://www.siksinhot.com/), [숨고](https://soomgo.com/)

#### 추천 Agentic Task 5가지

1. **시간 제약이 있는 다중 장소 동선 계획** — 방문할 장소, 체류시간, 영업시간, 출발·종료 위치를 수집해 현실적인 방문 순서를 계산한다. 이동시간과 예약 시간을 확인하고 불가능한 후보를 제거한다. 확정 동선을 지도 목록과 캘린더 초안으로 만든다.
2. **지역 서비스 업체 견적·예약 비교** — 수리, 청소, 이사, 미용처럼 위치 기반 서비스의 요구사항을 구조화한다. 여러 업체의 가능 시간, 가격 범위, 리뷰, 취소 조건을 비교하고 동일한 요청으로 견적 폼을 준비한다. 업체별 전송 내용과 개인정보를 확인받는다.
3. **접근성 조건 기반 장소 검증** — 휠체어 접근, 엘리베이터, 장애인 화장실, 주차, 유아 시설 같은 조건을 공식 페이지와 최신 사용자 정보에서 확인한다. 확인된 사실과 미확인 항목을 구분해 후보를 비교한다. 예약 전 장소에 확인할 질문을 준비한다.
4. **그룹 후보 수집·합의·예약** — 참여자가 공유한 장소와 예산, 이동 한계, 음식 제약을 모아 모두에게 가능한 후보를 찾는다. 각 후보가 누구의 조건을 충족하지 못하는지 표시하고 투표 또는 선택 결과를 반영한다. 선택 장소의 예약 폼을 준비한다.
5. **주차·대중교통·운영 중단 대안 계획** — 행사나 약속의 시간과 위치를 기준으로 주차장, 마지막 대중교통, 공사·휴무 정보를 확인한다. 기본 경로와 실패 시 대체 경로를 만들고 출발 시점을 계산한다. 변경된 운영 정보의 출처와 확인 시각을 표시한다.

홍보 포인트:

- 지도 위의 흩어진 후보가 시간과 제약을 만족하는 하나의 실행 계획으로 바뀐다.

안전 경계:

- 접근성, 영업시간, 예약 가능성은 공식 페이지 또는 최신 데이터로 확인한다.
- 출처와 확인 시점을 표시한다.

### 5.8 음식·레시피·주문

**우선순위: P0 · 가치 5 / 홍보성 5 / 구현성 4**

#### 대표 사이트와 주소

- 글로벌: [Allrecipes](https://www.allrecipes.com/), [Cookpad](https://cookpad.com/), [Tabelog](https://tabelog.com/), [DoorDash](https://www.doordash.com/), [Uber Eats](https://www.ubereats.com/)
- 한국: [만개의레시피](https://www.10000recipe.com/), [82cook](https://www.82cook.com/), [다이닝코드](https://www.diningcode.com/), [요기요](https://www.yogiyo.co.kr/), [배달의민족](https://www.baemin.com/)

#### 추천 Agentic Task 5가지

1. **레시피에서 다중 쇼핑몰 장바구니까지** — 현재 레시피의 재료와 인분을 추출하고 목표 인분, 보유 재료, 식단 조건을 반영한다. 필요한 양과 판매 단위 차이를 계산해 여러 쇼핑몰의 총액과 배송비를 비교한다. 대체품을 확인받은 뒤 장바구니를 준비한다.
2. **일주일 식단·통합 장보기 계획** — 인원, 예산, 조리 가능 시간, 영양 선호, 제외 재료를 수집해 반복 재료를 활용하는 식단을 구성한다. 레시피별 수량을 합산하고 남는 재료와 유통기한을 고려해 장보기 목록을 최적화한다. 선택한 쇼핑몰 장바구니에 품목을 나눠 담는다.
3. **냉장고 재료·유통기한 기반 식재료 구조 Rescue** — 사용자가 입력하거나 영수증에서 추출한 보유 재료와 유통기한을 정리한다. 먼저 소비해야 할 재료로 가능한 레시피를 찾고 부족 재료만 구매 목록에 추가한다. 버리는 식재료와 추가 구매 비용을 비교해 계획을 제시한다.
4. **식단 제약을 만족하는 식당 탐색·예약** — 일행의 알레르기, 채식, 종교적 제한, 예산, 위치, 시간을 수집한다. 메뉴와 공식 안내에서 조건을 확인하고 미확인 위험을 표시한 뒤 예약 가능한 후보를 비교한다. 최종 식당과 전달할 요청사항을 확인받아 예약을 준비한다.
5. **배달 서비스 총액·도착시간 비교 주문** — 동일 음식점 또는 유사 메뉴를 여러 배달 사이트에서 찾아 메뉴 가격, 배달비, 최소 주문금액, 쿠폰, 예상 도착시간을 정규화한다. 전체 주문과 옵션을 보여주고 선택한 장바구니를 구성한다. 주소 확인과 결제는 별도 승인한다.

홍보 포인트:

- 현재 보고 있는 콘텐츠가 실제 장보기 또는 예약 행동으로 연결된다.
- 예산 절감과 식재료 낭비 감소를 숫자로 보여줄 수 있다.

안전 경계:

- 알레르기 안전성을 보장하지 않는다.
- 제품 라벨, 식당 확인, 교차오염 경고를 사용자가 직접 검토하도록 표시한다.

### 5.9 교육·학습 관리

**우선순위: P1 · 가치 4 / 홍보성 4 / 구현성 4**

#### 대표 사이트와 주소

- 글로벌: [Coursera](https://www.coursera.org/), [Udemy](https://www.udemy.com/), [Khan Academy](https://www.khanacademy.org/), [edX](https://www.edx.org/), [Canvas](https://www.instructure.com/canvas)
- 한국: [EBS](https://www.ebs.co.kr/), [K-MOOC](https://www.kmooc.kr/), [메가스터디](https://www.megastudy.net/), [해커스](https://www.hackers.com/), [나이스](https://www.neis.go.kr/)

#### 추천 Agentic Task 5가지

1. **다중 LMS 과제·시험 마감 통합** — 여러 과목 페이지에서 과제, 시험, 읽을 자료, 마감일을 추출하고 중복 공지를 병합한다. 시간대와 변경 이력을 정리해 우선순위 목록을 만든다. 사용자의 캘린더 빈 시간에 학습 블록을 제안한다.
2. **강의계획서에서 학기 실행 계획 생성** — 강의계획서와 평가 기준에서 주차별 주제, 평가 비중, 제출 방식, 주요 일정을 추출한다. 예상 업무량과 다른 과목의 마감 충돌을 표시하고 학기 계획을 만든다. 캘린더와 task 앱에 저장할 항목을 승인받는다.
3. **수업 자료 기반 개인 학습 패키지 생성** — 현재 강의 페이지와 제공된 자료만 사용해 요약, 개념 관계, 플래시카드, 연습 문제를 만든다. 출처 페이지를 각 항목에 연결하고 이해가 부족한 주제를 다음 학습 순서로 배치한다. 평가 답안 대신 학습용 자료만 생성한다.
4. **과제 제출 전 요구사항 감사** — 과제 지시문, rubric, 제출 폼과 사용자의 파일을 비교해 형식, 필수 항목, 인용, 파일명, 제출 기한을 확인한다. 누락과 불일치를 표시하고 수정할 체크리스트를 만든다. 최종 제출은 전체 미리보기 후 사용자에게 맡기거나 승인받는다.
5. **과목 탐색·수강 계획 보조** — 학위 요건, 선수과목, 시간표, 정원, 사용자의 목표를 비교해 가능한 수강 조합을 만든다. 시간 충돌과 선수과목 부족을 표시하고 대체 과목을 제안한다. 수강 신청은 선택 과목과 학점 총계를 확인받은 뒤 진행한다.

홍보 포인트:

- 학습 요약보다 직접적인 가치가 큰 마감 누락과 제출 오류를 줄인다.
- 로그인된 LMS의 실제 상태와 캘린더를 연결한다.

안전 경계:

- 평가 과제를 대신 수행하거나 시험 답안을 제출하지 않는다.
- 과제·수강 신청과 캘린더 생성은 사용자 확인이 필요하다.

### 5.10 기기·통신·고객 지원

**우선순위: P1 · 가치 5 / 홍보성 4 / 구현성 3**

#### 대표 사이트와 주소

- 글로벌: [Apple Support](https://support.apple.com/), [Microsoft Support](https://support.microsoft.com/), [Samsung Support](https://www.samsung.com/us/support/), [Dell Support](https://www.dell.com/support/), [HP Support](https://support.hp.com/)
- 한국: [삼성전자서비스](https://www.samsungsvc.co.kr/), [T world](https://www.tworld.co.kr/), [KT](https://www.kt.com/), [LG U+](https://www.lguplus.com/), [LG전자 고객지원](https://www.lge.co.kr/support)

#### 추천 Agentic Task 5가지

1. **현재 오류에서 공식 해결 절차까지** — 현재 페이지의 오류 코드와 사용자가 제공한 제품 모델·환경을 읽는다. 제조사의 공식 지식베이스에서 해당 조건에 맞는 해결법을 찾고 위험이 낮은 단계부터 실행 가능한 체크리스트로 만든다. 해결 여부를 확인하며 다음 단계 또는 지원 접수로 전환한다.
2. **보증·수리·교체 옵션 비교와 예약** — 구매내역과 제품 정보를 이용해 보증 상태, 예상 비용, 수리센터, 택배 수리, 교체 프로그램을 비교한다. 사용자의 위치와 일정에 맞는 옵션을 선택하고 예약 폼을 준비한다. 비용과 데이터 초기화 가능성을 확인받은 뒤 예약한다.
3. **통신 요금제 사용량 기반 최적화** — 현재 요금제, 최근 사용량, 약정, 부가서비스를 읽고 제공 중인 대안과 비교한다. 할인 종료, 위약금, 데이터 한도까지 포함한 실제 월 비용을 계산한다. 변경 효과와 효력 발생일을 표시하고 승인 후 변경 절차를 진행한다.
4. **지원 티켓·상담 Handoff 자동화** — 오류 상황, 기기 정보, 이미 시도한 조치, 관련 로그를 구조화해 지원 티켓 초안을 만든다. 지원 사이트에서 적절한 카테고리와 연락 수단을 선택하고 누락 정보를 질문한다. 전송 전 포함될 개인정보와 첨부파일을 보여준다.
5. **계정 접근·보안 사고 대응 안내** — 계정 잠금, 의심 로그인, 결제 이상 같은 상황에서 공식 복구 경로와 필요한 검증 단계를 찾는다. 현재 세션에서 안전한 비파괴 조치를 안내하고 지원 요청 초안을 준비한다. 비밀번호, 복구 코드, MFA 입력은 사용자가 직접 수행한다.

홍보 포인트:

- 오류 코드 복사와 모델 재검색 없이 현재 화면에서 해결 또는 지원 흐름을 시작한다.

안전 경계:

- 출처가 불명확한 실행 파일 다운로드, 보안 설정 해제, 데이터 초기화를 자동화하지 않는다.
- 인증정보와 복구 코드는 에이전트가 읽거나 저장하지 않는다.

### 5.11 공공·행정 서비스

**우선순위: P2 · 가치 5 / 홍보성 4 / 구현성 2**

#### 대표 사이트와 주소

- 글로벌: [USA.gov](https://www.usa.gov/), [GOV.UK](https://www.gov.uk/), [Government of Canada](https://www.canada.ca/), [gov.br](https://www.gov.br/), [Your Europe](https://europa.eu/youreurope/)
- 한국: [정부24](https://www.gov.kr/), [홈택스](https://www.hometax.go.kr/), [고용24](https://www.work24.go.kr/), [서울특별시](https://www.seoul.go.kr/), [대한민국 법원](https://www.scourt.go.kr/)

#### 추천 Agentic Task 5가지

1. **지원사업·복지 자격 사전 점검과 신청서 초안** — 공식 공고의 자격, 제외 조건, 신청 기간을 구조화하고 사용자 정보와 대조한다. 충족, 미충족, 추가 확인 항목을 근거 조항과 함께 표시한다. 필요한 정보를 수집해 신청 폼을 채우되 법적 제출 전 사용자에게 인계한다.
2. **분산된 증명서·첨부 문서 수집 계획** — 신청 페이지의 필수 서류를 읽고 정부·세금·고용·교육 사이트별 발급 경로와 유효기간을 정리한다. 이미 확보한 문서와 대조해 누락·만료 항목을 표시한다. 발급 페이지를 순서대로 열고 다운로드 결과를 검증한다.
3. **면허·허가·등록 갱신 관리** — 현재 등록 정보와 공식 갱신 안내에서 만료일, 수수료, 교육·검사 요건을 추출한다. 필요한 선행 작업과 예약 가능 시간을 정리하고 갱신 폼을 준비한다. 인증, 전자서명, 납부는 사용자 확인 아래 진행한다.
4. **민원 목적 분석과 올바른 기관·서식 연결** — 사용자의 문제를 관할 기관, 민원 유형, 필요한 사실과 증빙으로 분해한다. 공식 사이트에서 올바른 접수 경로를 찾고 중복 또는 잘못된 기관 접수를 방지한다. 민원 초안을 만들고 사실관계와 수신처를 확인받는다.
5. **신청 진행상태·보완 요청 대응** — 포털과 이메일에서 접수번호, 현재 상태, 보완 기한, 요청 서류를 추출한다. 누락된 조치와 응답 초안을 준비하고 사용자가 제출한 자료와 요구사항을 대조한다. 최종 보완 제출 전 전체 패키지를 검토받는다.

홍보 포인트:

- 복잡한 행정 절차를 자격 여부, 필요 서류, 다음 행동으로 단순화한다.

안전 경계:

- 자격 판정을 보장하지 않고 적용 규정과 출처를 표시한다.
- 본인 인증, 전자서명, 법적 제출은 사용자 직접 조작 또는 최종 승인으로 제한한다.

### 5.12 건강·병원·약국

**우선순위: P3 · 가치 5 / 홍보성 4 / 구현성 2**

#### 대표 사이트와 주소

- 글로벌: [Mayo Clinic](https://www.mayoclinic.org/), [Cleveland Clinic](https://my.clevelandclinic.org/), [CVS](https://www.cvs.com/), [Walgreens](https://www.walgreens.com/), [Zocdoc](https://www.zocdoc.com/)
- 한국: [닥터나우](https://doctornow.co.kr/), [서울아산병원](https://www.amc.seoul.kr/), [서울대학교병원](https://www.snuh.org/), [삼성서울병원](https://www.samsunghospital.com/), [건강보험심사평가원](https://www.hira.or.kr/)

#### 추천 Agentic Task 5가지

1. **조건 기반 의료기관 탐색·예약 준비** — 사용자가 지정한 진료과, 위치, 시간, 접근성, 보험 조건으로 공식 의료기관 페이지를 검색한다. 위치와 예약 가능 시간을 정규화해 후보를 비교하고 선택한 예약 폼을 준비한다. 진단이나 특정 치료 추천은 하지 않는다.
2. **진료 전 문진·준비사항 패키지** — 병원 공식 안내와 예약 정보를 읽어 금식, 복용 중인 약 목록, 과거 검사, 신분증, 보험서류 등 필요한 준비 항목을 정리한다. 문진 폼에 검증된 정보만 채우고 민감 질문은 사용자에게 직접 묻는다. 제출 전 전체 내용을 검토받는다.
3. **의뢰서 기반 다중 진료 일정 조율** — 사용자가 제공한 의뢰서와 병원 안내에서 필요한 진료과, 검사 순서, 유효기간을 추출한다. 여러 병원의 예약 가능 시간과 이동시간을 비교해 현실적인 일정을 만든다. 의료적 우선순위를 판단하지 않고 공식 지시 순서만 따른다.
4. **진료·검사 문서 정리와 용어 설명** — 포털에서 진료비, 검사, 처방 관련 문서를 수집해 날짜와 기관별로 정리한다. 문서에 적힌 용어를 출처와 함께 평이하게 설명하고 다음 방문에 물어볼 질문을 만든다. 결과 해석이나 진단을 생성하지 않는다.
5. **보험 청구용 의료 문서 준비** — 보험사가 요구하는 영수증, 세부내역서, 진단 관련 서류 목록과 의료기관 발급 경로를 대조한다. 누락 문서와 청구 기한을 표시하고 청구 폼 초안을 준비한다. 보험 적용 여부를 보장하지 않고 최종 제출은 사용자에게 맡긴다.

홍보 포인트:

- 대기전화, 일정 비교, 반복 입력 같은 의료 행정 부담을 줄인다.

안전 경계:

- 진단, 응급도 판단, 약물 선택, 처방 변경을 수행하지 않는다.
- 의료 페이지 진입부터 별도 동의를 받고 민감정보를 최소화한다.
- 최종 예약, 문진, 보험 청구 제출은 사용자 검토가 필요하다.

### 5.13 금융·결제·세금

**우선순위: P3 · 가치 5 / 홍보성 4 / 구현성 1**

#### 대표 사이트와 주소

- 글로벌: [PayPal](https://www.paypal.com/), [Wise](https://wise.com/), [Chase](https://www.chase.com/), [Capital One](https://www.capitalone.com/), [TradingView](https://www.tradingview.com/)
- 한국: [토스](https://toss.im/), [네이버페이](https://pay.naver.com/), [카카오페이](https://www.kakaopay.com/), [KB국민은행](https://www.kbstar.com/), [신한은행](https://bank.shinhan.com/)

#### 추천 Agentic Task 5가지

1. **읽기 전용 반복 결제·구독 감사** — 최근 거래에서 반복 결제, 가격 인상, 중복 서비스, 사용하지 않는 구독 후보를 분류한다. 갱신일과 취소 조건을 공식 계정 페이지에서 확인하고 월·연간 절감 가능액을 계산한다. 취소 경로만 준비하고 실제 변경은 별도 승인한다.
2. **청구서 납부기한·자동이체 상태 점검** — 카드, 공과금, 통신 등 사용자가 허용한 계정에서 납부일, 금액, 자동이체 상태를 읽는다. 중복 납부와 미납 위험을 표시하고 캘린더 또는 알림 초안을 만든다. 송금이나 결제는 수행하지 않는다.
3. **세금 신고용 문서 수집·누락 감사** — 고용, 금융, 기부, 사업 관련 사이트에서 사용자가 지정한 기간의 신고 문서를 수집한다. 문서 유형, 발급처, 과세연도, 금액 필드를 정규화하고 누락 가능성을 표시한다. 세법 판단 대신 세무 전문가에게 확인할 질문을 만든다.
4. **수수료·이상 거래 설명 패키지** — 사용자가 선택한 거래와 약관 페이지를 연결해 수수료 발생 근거와 이전 기간과의 차이를 설명한다. 이상 가능성이 있는 항목을 표시하되 사기라고 단정하지 않는다. 금융기관에 보낼 문의 또는 확인 요청 초안을 만든다.
5. **환불·카드 이의제기·서비스 취소 준비** — 주문, 거래, 판매자 정책, 기존 문의 기록에서 필요한 사실과 증빙을 모은다. 가능한 공식 절차와 기한을 비교해 요청 초안을 작성하고 첨부할 문서를 정리한다. 사용자가 사실관계와 수신처를 확인한 뒤 직접 제출하거나 승인한다.

홍보 포인트:

- 놓치던 반복 비용, 마감, 누락 문서를 숫자와 근거로 보여준다.

안전 경계:

- 초기 버전은 읽기와 초안 작성으로 제한한다.
- 송금, 거래, 투자, 대출 선택, 카드 발급, 계좌 변경을 수행하지 않는다.
- 실제 금융 계정으로 공개 데모를 하지 않는다.

### 5.14 콘텐츠·커뮤니티·스트리밍

**우선순위: P2 · 가치 3 / 홍보성 3 / 구현성 4**

#### 대표 사이트와 주소

- 글로벌: [YouTube](https://www.youtube.com/), [Reddit](https://www.reddit.com/), [X](https://x.com/), [Instagram](https://www.instagram.com/), [Netflix](https://www.netflix.com/)
- 한국: [네이버 카페](https://section.cafe.naver.com/), [네이버 블로그](https://section.blog.naver.com/), [DCInside](https://www.dcinside.com/), [나무위키](https://namu.wiki/), [TVING](https://www.tving.com/)

#### 추천 Agentic Task 5가지

1. **다중 출처 기반 콘텐츠 제작 패키지** — 현재 열린 자료의 주장, 근거, 반대 의견, 출처를 구조화한다. 이를 바탕으로 블로그 초안, 짧은 SNS 초안, 출처 목록을 만들고 근거가 약한 문장을 표시한다. 게시하지 않고 사용자 편집용 초안까지만 완성한다.
2. **영상·팟캐스트 핵심 구간과 재활용 소재 추출** — 영상 페이지의 자막, 챕터, 설명을 읽어 주요 주장과 시간 구간을 정리한다. 숏폼 후보, 제목, 설명, 썸네일 문구 초안을 만들고 원본 시간 링크를 연결한다. 저작권과 인용 범위를 사용자가 확인하도록 한다.
3. **플랫폼별 게시 폼 준비와 품질 감사** — 하나의 승인된 원고를 각 플랫폼의 길이, 태그, 링크, 접근성 텍스트 요구에 맞게 변환한다. 깨진 링크, 누락된 출처, 금칙어, 잘못된 멘션을 검사하고 게시 폼을 채운다. 플랫폼별 게시 버튼은 개별 승인 후 실행한다.
4. **재생목록·읽기목록 목표 기반 큐레이션** — 사용자의 주제, 시간, 이미 본 콘텐츠, 제외 조건을 수집해 여러 사이트에서 후보를 찾는다. 중복과 접근 불가능한 항목을 제거하고 순서를 구성한다. 선택된 항목을 재생목록 또는 읽기목록에 추가하기 전 최종 목록을 보여준다.
5. **커뮤니티 운영 Moderation Queue 보조** — 사이트 정책에 따라 신고 게시물, 반복 스팸, 미응답 질문을 분류하고 근거 링크를 연결한다. 숨김, 경고, 답변 초안을 각각 준비하되 정책상 모호한 항목은 사람에게 에스컬레이션한다. 실제 제재와 메시지 전송은 운영자 승인을 요구한다.

홍보 포인트:

- 소비하던 콘텐츠를 출처가 연결된 제작·운영 작업으로 전환한다.
- 기존 생성 도구가 많으므로 게시·운영의 실제 실행을 보여줘야 차별화된다.

안전 경계:

- 게시, 댓글, 메시지, 제재는 반드시 승인한다.
- 대량 댓글, 홍보, 팔로우 자동화를 제외한다.

### 5.15 검색·포털

**우선순위: P1 · 가치 4 / 홍보성 3 / 구현성 4**

#### 대표 사이트와 주소

- 글로벌: [Google](https://www.google.com/), [Bing](https://www.bing.com/), [Yahoo](https://www.yahoo.com/), [DuckDuckGo](https://duckduckgo.com/), [Perplexity](https://www.perplexity.ai/)
- 한국: [네이버](https://www.naver.com/), [다음](https://www.daum.net/), [ZUM](https://zum.com/), [NATE](https://www.nate.com/), [Google Korea](https://www.google.co.kr/)

#### 추천 Agentic Task 5가지

1. **출처가 추적되는 다중 소스 조사 Concierge** — 주제를 하위 질문으로 나누고 공식 자료, 최신 기사, 반대 근거를 각각 검색한다. 중복을 제거하고 주장별 근거표, 출처 링크, 확인 날짜를 만든다. 근거가 충돌하는 부분을 숨기지 않고 결론과 함께 표시한다.
2. **현재 페이지 주장 Fact-check** — 사용자가 보고 있는 페이지에서 검증 가능한 주장, 수치, 날짜를 추출한다. 1차 출처와 독립적인 자료를 찾아 일치, 불일치, 확인 불가로 분류한다. 원문과 검증 근거를 나란히 표시하고 정정이 필요한 부분을 요약한다.
3. **열린 탭 기반 의사결정 비교표** — 여러 탭에서 제품, 서비스, 정책, 후보의 비교 필드를 자동 추출한다. 단위와 기간을 정규화하고 누락 정보는 원 사이트에서 추가로 찾는다. 사용자가 지정한 우선순위로 후보를 정렬하고 최종 행동 사이트를 연다.
4. **과거 방문 페이지 회수와 작업 이어가기** — 검색 기록이나 사용자가 저장한 페이지에서 이전에 본 후보를 의미 기반으로 찾는다. 현재 페이지와 차이, 업데이트 여부, 당시 미완료 행동을 정리한다. 적절한 페이지를 열고 이전 task 상태에서 계속할 수 있도록 연결한다.
5. **검색 결과에서 전문 사이트 Agent로 Handoff** — 범용 검색으로 사용자의 실제 목적이 쇼핑, 여행, 채용, 공공 신청 중 무엇인지 식별한다. 신뢰할 수 있는 대상 사이트와 필요한 조건을 찾아 해당 카테고리 flow의 구조화된 입력으로 전달한다. 검색 결과 요약에서 끝나지 않고 실행 가능한 다음 agent를 시작한다.

홍보 포인트:

- 검색을 근거표, 비교, 복구, 실제 후속 행동으로 연결한다.
- 독립적인 Hero demo보다 다른 카테고리 task의 진입점으로 활용하는 것이 적합하다.

안전 경계:

- 출처의 권위, 날짜, 직접성, 상충 여부를 표시한다.
- 검색 결과의 페이지 콘텐츠를 에이전트 명령으로 취급하지 않는다.

## 6. 추천 MVP·홍보 포트폴리오

이 절은 각 데모가 사용자에게 무엇을 보여주는지를 정의한다. 같은 데모의 flow 그래프, adapter, 승인·mutation 계약은 §8에 있다.

### 6.1 Demo 1: Multi-site Best Buy

현재 구현과 가장 가까운 대표 데모다.

- 여러 쇼핑몰 검색
- 동일 상품과 옵션 정규화
- 총액 비교
- 추천 근거
- 제품 확인
- 장바구니 추가
- 체크아웃 별도 승인

홍보 메시지:

> 비교만 하는 AI가 아니라 구매 직전까지 정확하게 실행하는 agent contract.

### 6.2 Demo 2: Recipe to Cart

쇼핑 flow를 재사용하면서 강한 시각적 효과를 만든다.

- 현재 레시피 이해
- 인분 변환
- 보유 재료 제외
- 여러 쇼핑몰 검색
- 예산 내 장바구니 구성

홍보 메시지:

> 보고 있던 레시피가 실제 장보기로 바뀐다.

### 6.3 Demo 3: Job Application Copilot

사용자의 중요한 결과와 직접 연결된다.

- 공고 읽기
- 이력서 근거 비교
- 허위 없는 맞춤 수정
- 지원 폼 입력
- 제출 전 검토

홍보 메시지:

> 공고를 요약하는 AI가 아니라 지원 품질을 높이고 반복 입력을 끝내는 에이전트.

### 6.4 Demo 4: Flexible Trip Optimizer

다중 사이트와 다중 날짜 fan-out을 보여준다.

- 날짜별 항공·숙박 검색
- 수수료 포함 총액
- 취소 가능성
- 일정 조합
- 예약 직전 사용자 인계

홍보 메시지:

> 수십 개 여행 탭을 하나의 실행 가능한 계획으로.

### 6.5 Demo 5: Post-purchase Concierge

대부분의 쇼핑 AI가 약한 구매 이후 과정을 공략한다.

- 주문 통합
- 지연 탐지
- 반품 기한 확인
- 반품 신청 준비
- 접수번호 추적

홍보 메시지:

> AXSDK는 구매 전환뿐 아니라 구매 이후 고객 경험도 자동화한다.

## 7. 데모 구현 설계 계약

§5·§6이 "무엇을 만들까"라면 이 장부터는 "flow document contract v1으로 어떻게 만드는가"다. 기준은 다음 세 가지이고, 이 문서가 임의로 확장하지 않는다.

| 기준 | 파일 | 역할 |
|---|---|---|
| 엔진 규격 | [`FLOWS.md`](./FLOWS.md) | 노드 kind, flowTool, 예산, pause/resume, `flow.map`의 정의 |
| 준수 계약 | [`FLOW_CONFORMANCE.md`](./FLOW_CONFORMANCE.md) + `tools/flow-conformance.test.mjs` | 실행 가능한 게이트. 여기서 강제하는 규칙이 최종 판정이다 |
| 참조 구현 | `_common/flows.yaml`의 `shopping_multi_store_total_cost` | 이미 통과 중인 실제 그래프 |

SDK 쪽 참조 문서는 `../axsdk-sdk-js/packages/axsdk-react/apps/browser-extension/flows.yaml`이다. 이는 전체 `version: 1` app document이며 production site flow가 아니다. production 계층은 `extends: app` overlay(`_common/flows.yaml` + 활성 `<site>/flows.yaml`)이고 `defaults.mapping: legacy`를 고정한다. 두 계층을 서로 대체해서 인용하지 않는다.

### 7.1 결정성 우선 — LLM은 네 곳에만

데모에서 LLM이 담당하는 지점은 넷뿐이다.

1. 라우팅: planner의 `decide`
2. 자연어 제약 추출: `collect_*` 노드 1콜
3. 선택·승인 해석: `choose_*` 노드 1콜
4. 최종 문장 다듬기: `app.terminal`

반복, 누적, 중복 제거, 스키마 검증, 단위 환산, 산술, 랭킹, 승인 토큰 발급, mutation 실행, 실행 후 확인은 전부 결정적 경로(`action_contract` + `lua`/`remote`/`flow.map`)에 둔다.

이유는 두 가지다. 첫째, `action_unit` 한 스텝은 모델 호출 한 번이고 턴 지연을 지배한다. 둘째, 승인 토큰이나 가격 같은 값을 LLM이 만들어낼 수 있으면 승인·mutation 계약이 형식만 남는다.

### 7.2 공통 skeleton

이전 판의 선형 pseudo-pipeline을 실제 노드 kind로 다시 쓴 것이다.

| 단계 | 노드 kind | 실행 | 실패 처리 |
|---|---|---|---|
| 요청 수집 | `action_unit` (self-loop `ask`) | LLM 1콜 + passthrough | `ask`로 pause |
| 대상 확정 | `action_contract` | remote 또는 `lua` | `next.error` |
| 다중 대상 읽기 | `action_contract` + `flow.map` task mode | worker subflow × N, 모델 호출 0 | `next.partial` |
| 대상 재검증 | `action_contract` | remote | `next.error` |
| 정규화·랭킹 | `action_contract` | sandboxed `lua` | `next.error` |
| 결과 제시 | `action_contract` | `question` 방출 | `next.error` |
| 승인 | `action_unit` (self-loop `ask`) | LLM 1콜 | `ask`로 pause |
| 승인 해석·토큰 발급 | `action_contract` | `lua` | `next.error` |
| 대상 열기 | `action_contract` | remote, 재진입 | `navigating` |
| mutation | `action_contract` + mutation 계약 | remote | `navigating` / `error` |
| 완료 증빙 | `terminal` | 상태 기반 | 별도 error terminal |

이 순서는 새로 만든 것이 아니라 `_common/flows.yaml`의 `shopping_multi_store_total_cost`가 이미 강제받고 있는 그래프다.

```text
collect_request
→ prepare_identity ─┬─ discover_products → build_product_options → choose_product → resolve_product ─┐
                    └─ lock_requested_identity ───────────────────────────────────────────────────────┤
→ search_stores → verify_offers → normalize_rank → choose_offer → resolve_offer → open_selected_store ─┘
→ add_selected_offer → add_selected_offer_after_navigation → confirm_selected_offer_after_navigation
→ report_cart
```

새 데모는 이 skeleton의 단계 이름을 바꿔 재사용한다. 단계를 빼는 것은 허용되지만(예: 읽기 전용 데모는 mutation 이후 단계 없음), 순서를 바꾸거나 승인 단계를 건너뛰는 변형은 허용하지 않는다.

### 7.3 질문과 승인 (pause / resume)

- 질문에 `terminal`을 쓰지 않는다. terminal은 flow를 끝내므로 다음 메시지는 route entry부터 다시 시작하고 누적 상태를 잃는다. 질문 노드는 자기 자신을 가리키는 `next` 전이를 갖는 self-loop이어야 한다.
- 화면에 뜨는 필드는 `question`이다. `message`만 낸 노드는 pause 화면에 아무것도 띄우지 않는다.
- 재개는 planner가 `continue_current`를 반환할 때만 일어난다. planner 프롬프트가 항상 새 intent로 라우팅하면 진행 중 flow가 폐기된다.
- 승인·선택 노드에는 `messagePolicy: { currentUserText: active_node_only }`를 둔다. 같은 턴에 자동 전이로 들어왔을 때 원래 요청문을 승인으로 오독하는 것을 막는다. conformance test가 `choose_product`와 `choose_offer`에 대해 이 값을 강제한다.
- 승인 노드의 `inputSelector`에 비교 결과 전체를 넣지 않는다. 현재 강제되는 금지 목록은 `offers`, `comparison_text`, `ambiguous_offers`, `excluded_offers`다. 사용자에게 보여줄 표는 결정적 제시 도구가 `question`으로 렌더하고, 승인 노드는 선택 번호만 해석한다.
- self-loop은 사용자 질문 전용이다. 내부 다단계 반복에 self-loop을 쓰면 매 도구 호출마다 pause한다. 여러 도구를 한 턴에 실행하려면 순차 노드로 분리한다.
- 멈춘 self-loop 방어는 `fallback.maxStalledSteps` + `stalledNext`로 한다. 하드 캡에 부딪혀 예외로 끝내지 않는다.

### 7.4 mutation 계약

`effect: mutation`을 선언한 flowTool은 다음 네 가지를 전부 선언해야 한다. 이는 문서 권고가 아니라 `npm run check:flows`가 실패시키는 조건이다.

```yaml
effect: mutation
consent: required
idempotent: true
require: { <state_gate>: <expected> }   # 비어 있으면 실패
```

장바구니형 mutation은 단일 boolean이 아니라 3중 승인 게이트를 쓴다. 현재 `shopping_add_selected_store_offer`에 대해 정확히 이 세 키가 강제된다.

```yaml
require:
  cart_approval: user_selected_compared_offer
  identity_approval: locked_product_identity
  comparison_approval: current_comparison
```

운영 규칙:

1. 승인 토큰은 결정적 도구만 발급한다. LLM 결정 도구의 `parameters`에는 승인 토큰도 가격도 넣지 않는다. 허용 출력은 `next`, `question`, 선택 인덱스, 대상 비교 id 정도다.
2. mutation adapter는 실행 직전 대상 페이지를 다시 읽고, 불일치면 클릭하지 않고 구조화된 코드로 멈춘다. 현재 쓰이는 코드: `identity_changed`, `identity_revalidation_failed`, `stale_comparison`, `price_changed`, `currency_changed`, `quantity_unavailable`, `login_required`, `captcha_required`, `unavailable`.
3. 성공 판정은 사이트가 보여준 확인 값이다. 네비게이션이나 클릭 성공은 성공이 아니다.
4. 새 mutation 도구를 추가하는 변경은 `tools/flow-conformance.test.mjs`에 해당 도구의 mutation 단언을 추가하는 변경과 같은 커밋이어야 한다.

### 7.5 다중 대상 fan-out 계약

다중 사이트·다중 항목 읽기는 `flow.map` task mode로만 만든다. LLM이 순차 루프를 관리하는 노드는 legacy 경계이며 새 작업에 복제하지 않는다.

```yaml
execute:
  kind: runtime
  implementation: flow.map
  flow: <worker_flow>
  itemsArg: <array_arg>
  resultFrom: <worker_state_path>
  maxItems: <= 32
  concurrency: 1
  onItemError: collect        # task mode 필수
  task:
    keyFrom: <item 고유 키>
    resultSchema: { ... }     # 완료 항목 검증
    budget:                   # 네 필드 전부 필수
      maxNodes: 8
      maxModelCalls: 0
      maxRemoteCalls: 5
      timeoutMs: 120000
```

- caller 노드는 `next.done`, `next.empty`, `next.partial`을 모두 선언한다.
- worker는 `maxModelCalls: 0`으로 둔다. 항목마다 모델을 부르면 지연과 비용이 항목 수에 비례한다.
- **V1은 순차 실행이다.** 동시 조회로 홍보하지 않는다. 대신 항목별 진행 상태를 노출하고 부분 성공을 보존한다.
- `next: done`은 "모든 worker가 완료"라는 뜻이지 "도메인 결과가 있다"는 뜻이 아니다. 후보 0건 판정은 fan-in 쪽에서 값을 보고 내린다.
- 키는 항목 스키마의 required 속성이어야 하고 중복이 없어야 한다. 결과 총량 상한은 256 KiB다.

### 7.6 네비게이션 재진입 계약

사이트 이동은 호출 안에서 기다리지 않는다. 도구는 이동을 fire하고 즉시 반환하며, flow는 `navigating` 전이로 다음 노드에서 재개한다. 재시도 홉 수는 유한해야 한다. 현재 참조 구현은 `search → search_after_navigation → search_after_navigation_retry → normalize`이며 mutation 쪽도 `add_selected_offer → add_selected_offer_after_navigation → confirm_selected_offer_after_navigation → report_cart`로 같은 형태를 쓴다. 상세 계약은 [`NAVIGATION.md`](./NAVIGATION.md)에 있다.

### 7.7 selector와 증빙

- 모든 planner/노드는 정확한 leaf 경로만 선택한다. `$`, `global`, `flow`, `active`, `contexts` 같은 전체 스코프 선택은 컴파일 오류다. 절차는 [`FLOWS_YAML_SELECTOR_MIGRATION.md`](./FLOWS_YAML_SELECTOR_MIGRATION.md)를 따른다.
- terminal은 `respond`가 참조하는 경로를 전부 선택한다. 상태를 읽지 않는 terminal은 `inputSelector: []`를 명시한다.
- 현재 production flow가 실제로 남기는 증빙은 다음과 같다.

| 종류 | 필드 |
|---|---|
| 대상 동일성 | `identity_id`, `identity_fingerprint`, `identity_source_refs`, `canonical_query`, `locked_hard_constraints` |
| 비교 스냅샷 | `comparison_id`, `options_version`, `complete_count`, `incomplete_count` |
| 후보 | `site`, `product_id`, `url`, `price`/`currency`, `shipping_cost`, `total_base`, `cost_complete`, `rating`, `review_count` |
| 승인 | `identity_approval`, `comparison_approval`, `cart_approval` |
| 결과 | `cart_status`, `cart_confirmation`, `cart_url`, 실패 코드 |

- **관측 시각 필드는 현재 존재하지 않는다.** 이전 판의 `capturedAt` 요구는 어떤 flow나 `SCHEMA.md` 항목에도 구현되어 있지 않다. 데모에서 "언제 읽은 값"을 보여주려면 adapter 결과 스키마에 필드를 추가하는 신규 작업으로 잡아야 한다(§9).

### 7.8 예산

| 예산 | 범위 | 기본 / 상한 |
|---|---|---|
| `defaults.maxSteps` | 턴당 노드 실행 | 24 / 256 |
| `maxSelfSteps` | 노드 하나의 self-loop | 미설정 / 256 |
| `llm.maxCalls` | `action_unit` 한 노드 | `max(1, turns) + 1` |
| `execute.timeoutMs` | remote 호출 1회 | 문서 기본 / 120000 ms |
| `flow.map` 집계 | map 1회 | 노드 1024 · 모델 256 · remote 512 · 120000 ms |
| `task.budget` | map 항목 1개 | 네 필드 필수, 위 집계의 자식 |

데모 설계 규칙: 한 턴에 읽기·비교·승인·mutation을 모두 넣지 않는다. 사용자 질문(pause)을 자연스러운 경계로 삼아 각 턴의 노드 수를 24 아래로 유지한다.

### 7.9 오류 계약

현재 tracked overlay는 노드마다 `next.error`와 `fallback: { invalidNext, exhaustedNext }`를 명시하는 방식만 쓴다. v1에는 `__error` 자동 unwind와 `flow.onError`, 그리고 상태에서 값을 그대로 읽는 데이터 terminal(`respond: { from, fallback }`)도 있지만 production overlay에서는 아직 사용하지 않는다. 새 데모는 둘 중 하나를 고르고 한 flow 안에서 섞지 않는다. 섞으면 실패 경로가 두 갈래가 되어 증빙이 갈라진다.

---

## 8. 데모별 flow 설계

다섯 데모 모두 §7.2 skeleton의 인스턴스다. 각 절은 라우팅, 노드 그래프, 필요한 adapter, mutation 경계, 증빙을 정의한다. adapter 이름은 `SCHEMA.md`의 규칙(`AX_` + snake_case, 동사 우선, 다중 사이트 디스패처는 `_store_` 중위)을 따른다.

### 8.1 Demo 1 — Multi-store Best Buy (구현 완료)

유일하게 이미 production overlay에 존재하는 데모다. 나머지 데모의 기준선이므로 새로 설계하지 않고 계약만 고정한다.

| 단계 | 노드 | 도구 | 게이트 |
|---|---|---|---|
| 수집 | `collect_request` | `collect_total_cost_request` | self-loop `ask` |
| 동일성 | `prepare_identity` → `discover_products` → `build_product_options` → `choose_product` → `resolve_product` | `shopping_prepare_product_identity`, `shopping_discover_products`, `shopping_build_product_options`, `choose_product_identity`, `shopping_resolve_product_option` | `choose_product`는 `active_node_only` + 단일 도구 |
| 조회 | `search_stores` | `shopping_search_stores` (`flow.map` task mode → `shopping_search_one_store`) | worker 모델 0콜 |
| 검증 | `verify_offers` | `shopping_verify_product_offers` | 랭킹 이전 |
| 랭킹 | `normalize_rank` | `AX_rank_store_offers` | 결정적 |
| 승인 | `choose_offer` | `present_store_offers` + `choose_store_offer` | self-loop `ask`, payload 미주입 |
| 확정 | `resolve_offer` | `AX_resolve_store_offer` | 3개 승인 토큰 발급 |
| mutation | `open_selected_store` → `add_selected_offer` → `*_after_navigation` → `confirm_*` | `shopping_add_selected_store_offer` | 3중 `require` |
| 증빙 | `report_cart` | — | 상태 기반 terminal |

이미 실행 가능한 게이트가 강제하는 것: 동일성 확정이 조회보다 먼저, 검증이 랭킹보다 먼저, 승인 self-loop 존재, 승인 노드의 payload 차단, mutation 3중 게이트, worker `maxRemoteCalls >= 5`, 네비게이션 재시도 홉.

남은 작업은 §9의 gap 항목(관측 시각, FX 출처 노출)뿐이며 그래프 변경은 필요 없다.

### 8.2 Demo 2 — Recipe to Cart

Demo 1의 조회·랭킹·mutation 구간을 그대로 재사용하고 앞단만 교체한다.

라우팅: 새 intent `recipe_to_cart`, entry `recipe_to_cart.read_recipe`. `shopping_multi_store_total_cost`와 겹치지 않도록 route `description`에 "현재 레시피 페이지"를 명시하고 `priority`를 쇼핑 intent보다 높게 둔다.

| 단계 | 노드 | kind | 도구 |
|---|---|---|---|
| 레시피 읽기 | `read_recipe` | `action_contract` | 신규 `AX_read_recipe` (현재 탭, 읽기 전용) |
| 인분·보유 재료 수집 | `collect_plan` | `action_unit` self-loop | 신규 passthrough `collect_recipe_plan` |
| 재료→구매 단위 환산 | `build_shopping_list` | `action_contract` | 신규 `lua` 도구 (수량 합산, 중복 병합, 보유 재료 제외) |
| 품목별 조회 | `search_items` | `action_contract` | 신규 caller `recipe_search_items` (`flow.map` task mode, `keyFrom: ingredient_id`). worker flow는 기존 `shopping_search_one_store` 재사용 |
| 정규화·후보 선택 | `normalize_rank` | `action_contract` | 기존 `AX_rank_store_offers` |
| 대체품 승인 | `confirm_substitutions` | `action_unit` self-loop | 신규 결정적 제시 도구 + 선택 해석 도구 |
| 장바구니 담기 | `add_items` | `action_contract` | 기존 `shopping_add_selected_store_offer`를 품목 수만큼 순차 호출 |
| 품목 진행 | `next_item` | `action_contract` | 남은 품목 pop, 완료 시 증빙으로 전이 |
| 증빙 | `report_cart` | `terminal` | 품목별 성공/실패 |

worker 재사용 시 주의: 기존 worker의 map은 `keyFrom: site`이고 결과 스키마가 `site`와 `candidates`를 요구한다. 품목 축으로 돌리려면 caller 쪽 item 스키마에 `ingredient_id`를 required·고유 값으로 선언하고, `context`에 `{ query, site }`를 실어 보내며, `resultSchema`에 `ingredient_id`를 추가해야 한다. worker 그래프 자체는 바뀌지 않는다.

mutation 경계: 품목마다 개별 승인을 받지 않는다. 확정된 장바구니 목록 전체를 한 번 승인받되, `shopping_add_selected_store_offer`가 요구하는 세 토큰(`identity_approval`, `comparison_approval`, `cart_approval`)은 품목마다 결정적 resolver가 발급한다. 하나의 승인이 여러 품목의 게이트를 통과시키는 형태로 만들지 않는다. 품목 단위 실패는 부분 성공으로 보고한다.

주의: `flow.map` 안에서 mutation을 돌리지 않는다. map은 부작용 권한을 주지 않으며 롤백도 없다. 담기는 map 밖 순차 노드에서 수행한다.

### 8.3 Demo 3 — Job Application Copilot

가장 위험한 데모다. 제출은 되돌릴 수 없고 내용이 사용자 명의로 남는다.

라우팅: intent `job_application`, entry `job_application.read_posting`.

| 단계 | 노드 | kind | 비고 |
|---|---|---|---|
| 공고 읽기 | `read_posting` | `action_contract` | 신규 `AX_read_job_posting` |
| 근거 대조 | `match_profile` | `action_contract` | 결정적 대조. 조건별 `충족`/`부분 충족`/`근거 없음`과 근거 문장 id |
| 부족 정보 질문 | `collect_answers` | `action_unit` self-loop | 서술형 답변은 사용자 입력만 사용 |
| 문서 초안 | `draft_documents` | `action_unit` | 근거 없는 문장 생성 금지를 프롬프트가 아니라 `match_profile` 결과 범위로 제약 |
| 폼 채우기 | `fill_form` | `action_contract` | 기존 `AX_get_form`/`AX_set_form` 계열 |
| 전체 미리보기 | `preview_application` | `action_contract` | 제출될 전 필드를 `question`으로 렌더 |
| 제출 승인 | `confirm_submit` | `action_unit` self-loop | `active_node_only` |
| 제출 | `submit_application` | `action_contract` | 신규 mutation adapter |
| 증빙 | `report_submission` | `terminal` | 접수번호/확인 문구 |

제출 adapter의 게이트:

```yaml
effect: mutation
consent: required
idempotent: true
require:
  submit_approval: user_reviewed_full_application
  posting_approval: locked_job_posting
```

`posting_approval`은 `read_posting`이 발급하고, 공고 id가 바뀌면 무효가 된다. 같은 공고에 대한 재제출은 접수번호가 있으면 차단한다. 대량 자동 지원은 라우팅 단계에서 금지한다(한 턴에 하나의 공고).

금지: 기존 데모용 자동 폼 제출 경로를 복제하지 않는다. 그 경로에는 mutation·consent 선언이 없고, 미리보기와 승인 노드도 없다.

### 8.4 Demo 4 — Flexible Trip Optimizer

fan-out 축이 사이트가 아니라 **날짜 조합**이라는 점만 다르다.

| 단계 | 노드 | 비고 |
|---|---|---|
| 조건 수집 | `collect_trip` | 출발·도착·인원·예산·날짜 허용 범위 |
| 조합 생성 | `build_date_options` | 결정적 `lua`. `maxItems`(≤32) 안으로 조합 수를 잘라내고 자른 사실을 상태에 남긴다 |
| 조합별 조회 | `search_options` | `flow.map` task mode, `keyFrom: option_id` |
| 총액 정규화 | `normalize_total` | 수하물·세금·수수료·취소 조건 포함. 미확인 항목은 `null`로 두고 `cost_complete: false` |
| 제시·선택 | `choose_option` | self-loop, 상위 조합만 렌더 |
| 예약 폼 준비 | `prepare_booking` | 폼 채우기까지만 |
| 인계 | `handoff` | terminal. 결제 단계 진입 직전에 사용자에게 제어권 반환 |

이 데모에는 mutation adapter를 두지 않는다. 예약 확정·결제는 사용자 직접 조작이고, flow는 폼 준비까지만 한다. 따라서 `effect: mutation` 선언이 없어야 하며, 있으면 계약 위반이다.

`cost_complete`가 false인 조합을 완전한 조합보다 위에 올리지 않는다. 랭킹 순서는 Demo 1과 동일한 결정적 규칙(완전 비용 우선 → 총액 → 평점 → 리뷰 수 → 사이트 슬러그 → id)을 재사용한다.

### 8.5 Demo 5 — Post-purchase Concierge

읽기 fan-out과 준비 작업 위주이며, mutation은 반품 신청 한 곳뿐이다.

| 단계 | 노드 | 비고 |
|---|---|---|
| 주문 수집 | `collect_orders` | 사용자가 지정한 쇼핑몰/기간 |
| 주문·배송 조회 | `track_orders` | `flow.map` task mode, `keyFrom: order_id` |
| 상태 정규화 | `normalize_status` | 배송사 상태 문구를 공통 상태로 매핑, 원문과 출처 URL 보존 |
| 지연·기한 판정 | `assess_orders` | 결정적. 반품 기한, 예정일 초과, 중복 배송 |
| 조치 선택 | `choose_action` | self-loop. 반품/교환/문의 중 하나 |
| 신청서 준비 | `prepare_return` | 회수 주소·환불 금액·수수료 재확인 |
| 승인 | `confirm_return` | self-loop, `active_node_only` |
| 신청 | `submit_return` | mutation adapter, `require: { return_approval: user_reviewed_return_terms, order_approval: locked_order }` |
| 증빙 | `report_return` | 접수번호 |

반품 사유는 사용자가 고른 값만 전송한다. 모델이 사유를 추정해 채우지 않는다.

---

## 9. 신규 구현 필요 목록

데모별 설계가 요구하지만 현재 저장소에 없는 것들이다. "설계됨"과 "구현됨"을 섞지 않기 위해 분리한다.

| 항목 | 현재 상태 | 필요한 작업 |
|---|---|---|
| 관측 시각(`captured_at`) | 어떤 flow·adapter에도 없음 | 후보 결과 스키마에 필드 추가, 정규화 도구가 보존, terminal이 노출 |
| `AX_open_site` | flow에서 쓰이지만 `SCHEMA.md`에 항목 없음 | 스키마 항목 추가 |
| 레시피/공고/주문 reader | 없음 | `AX_read_recipe`, `AX_read_job_posting`, 주문·배송 reader adapter |
| 지원서 제출 mutation | 없음 | mutation 4키 + 접수번호 확인까지 포함한 adapter |
| 반품 신청 mutation | 없음 | 위와 동일 |
| 날짜 조합 fan-out | 없음 | 조합 생성 `lua` + task map worker flow |
| 플랫폼 도구(`AX_platform_*`) | 제안 상태, 미구현 | 탭·권한·다운로드가 필요한 데모의 선행 작업 |
| `kind: approval` 노드 | 제안 상태, v1 미검증 | 도입 전까지 승인은 self-loop + 결정적 토큰으로 구현 |

`AGENTIC_TASKS_IMPLEMENTATION_DESIGN.md`에 **Proposed**로 표시된 문법(scoped receipt, target tabRef, resumable map 등)은 v1 컴파일 대상이 아니다. 데모 설계에서 실행 가능한 것처럼 인용하지 않는다.

---

## 10. Chrome Extension 설계 원칙

### 10.1 Side Panel을 기본 UX로 사용

현재 페이지를 유지한 채 task 진행 상태, 사이트별 조회 상태, 비교표, 부족 정보 질문, mutation 승인, 완료 증빙을 표시한다. §7.5의 순차 실행 특성상 항목별 진행 표시가 특히 중요하다.

### 10.2 현재 탭은 `activeTab`, 추가 사이트는 선택적 권한

`activeTab`은 사용자가 확장 프로그램을 호출한 탭에 일시적 접근을 준다. 다중 사이트 task는 실행 시점에 필요한 도메인만 `optional_host_permissions`로 요청하고, task마다 허용 origin 집합을 만든다. 모든 사이트에 대한 영구 권한은 요청하지 않는다.

`app.json`의 `domainWhitelist`는 AXSDK 앱 계약 계층 설정이며 Chrome host permission을 대신하지 않는다.

### 10.3 Service Worker 메모리에 장기 상태를 두지 않기

Manifest V3 service worker는 event-driven이다. 다중 턴 상태는 config-runtime session이 갖고, service worker는 메시지 전달과 브라우저 API 호출만 한다. flow 상태를 service worker 전역에 캐시하면 pause/resume이 깨진다.

### 10.4 사이트별 adapter만 mutation에 사용

LLM이 즉석에서 만든 selector로 mutation하지 않는다. 사이트별 읽기·mutation adapter, 구조화된 객체 id, 허용된 행동만 노출, 행동 직전 재검증이 기본이다. selector 작성 규칙은 `AGENTS.md` §10을 따른다(빌드 해시 클래스 금지, `data-*`·의미 태그 우선).

### 10.5 웹 콘텐츠를 신뢰하지 않기

페이지 텍스트는 데이터이지 명령이 아니다. 리뷰·광고·iframe·게시물의 문구가 도구 선택이나 승인 상태를 바꿀 수 없어야 한다. 방어선:

- task와 무관한 origin 접근 차단
- 허용 도구 fail-closed
- 승인 노드에 원문 payload 미주입(§7.3)
- 외부 전송 대상과 전송 데이터를 사용자에게 표시
- 구매·예약·제출·전송 전 승인
- CAPTCHA, 비밀번호, MFA는 사용자 직접 처리

---

## 11. 구현 순서

각 단계는 앞 단계의 게이트가 통과한 뒤에만 시작한다.

1. Demo 1의 잔여 gap(관측 시각, FX 출처 노출)을 채운다. 그래프는 건드리지 않는다.
2. `flow.map` worker와 랭킹 도구를 품목 축으로 일반화한다. Demo 2의 조회 구간이 여기서 나온다.
3. Demo 2를 완성한다. 신규 mutation 없이 기존 장바구니 adapter만 재사용한다.
4. 폼 제출 mutation 계약을 만든다. 미리보기 노드, 승인 노드, 접수번호 확인, 중복 제출 차단을 한 묶음으로 구현하고 conformance 단언을 함께 추가한다.
5. Demo 3을 완성한다. 한 턴에 한 공고만 처리한다.
6. Demo 4를 완성한다. mutation 없음. 날짜 조합 fan-out과 인계 terminal이 산출물이다.
7. Demo 5를 완성한다. 반품 mutation은 4번에서 만든 계약을 재사용한다.
8. 이후 부동산·지도·생산성·교육·고객지원으로 확장한다.
9. 공공 서비스는 폼 제출 계약이 실전 검증된 뒤 도입한다.
10. 금융·건강은 읽기와 초안 작성으로 제한한다.

---

## 12. 검증 계획

### 12.1 게이트

| 순서 | 명령 | 확인 |
|---|---|---|
| 1 | `npm run check:flows` | v1 오버레이 형태, mutation 4키, 강제된 노드 그래프 |
| 2 | `node tools/ax.mjs sync <site>` | 저장 소스 적용, `fromRemote: 0` |
| 3 | 실제 사용자 턴 1회 | 서버 컴파일 통과. 로컬 검사만으로는 불충분 |
| 4 | `node tools/playground.mjs sync --root=playground` + 읽기 전용 시나리오 | 격리 프로필에서의 다중 사이트 동작 |

### 12.2 데모별 증빙

각 데모 실행은 다음을 남겨야 한다. assistant의 최종 문장은 증빙이 아니다.

1. 원 요청과 구조화된 제약
2. 접근한 origin과 허용 근거
3. 사이트별 remote call과 결과(부분 실패 포함)
4. 정규화된 비교 데이터와 제외 사유
5. 사용자에게 실제로 보여준 선택지
6. 승인 메시지와 발급된 승인 토큰
7. mutation payload와 실행 직전 재검증 결과
8. 사이트가 반환한 확인 값(주문번호·접수번호·장바구니 확인)
9. 실패하거나 확인할 수 없었던 항목

판정 대상 artifact: `summary.json`, `remote-calls.ndjson`, `tool-log.txt`, transcript, runtime/debug 상태.

### 12.3 이 문서 자체의 제약

`tools/flow-conformance.test.mjs`는 이 문서의 내용도 검사한다. 다음을 위반하면 `npm run check:flows`가 실패한다.

- `_common/flows.yaml`을 언급할 것
- `axsdk-sdk-js/packages/axsdk-react/apps/browser-extension/flows.yaml`을 언급할 것
- `legacy` 경계를 언급할 것
- 폐기된 browser-extension 경로를 언급하지 말 것

---

## 13. 주요 출처

### 저장소 내부 계약

- [`FLOWS.md`](./FLOWS.md) — flow document contract v1
- [`FLOW_CONFORMANCE.md`](./FLOW_CONFORMANCE.md) — 준수 계약과 게이트
- [`FLOWS_YAML_SELECTOR_MIGRATION.md`](./FLOWS_YAML_SELECTOR_MIGRATION.md) — selector 계약
- [`NAVIGATION.md`](./NAVIGATION.md) — 네비게이션 계약
- [`SCHEMA.md`](./SCHEMA.md) — `AX_*` 도구 스키마
- [`MULTI_STORE_TOTAL_COST_DESIGN.md`](./MULTI_STORE_TOTAL_COST_DESIGN.md) — 정규화·랭킹 규칙
- [`AGENTIC_TASKS_IMPLEMENTATION_DESIGN.md`](./AGENTIC_TASKS_IMPLEMENTATION_DESIGN.md) — 상위 목표 설계(Proposed 항목 포함)

### 외부 자료

- [Google: Chrome Gemini 3 Auto Browse](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)
- [Google: Architecting Security for Agentic Capabilities in Chrome](https://security.googleblog.com/2025/12/architecting-security-for-agentic.html)
- [OpenAI: Computer-Using Agent](https://openai.com/index/computer-using-agent/)
- [OpenAI: Introducing Operator](https://openai.com/index/introducing-operator/)
- [OpenAI: Agentic Commerce Protocol](https://developers.openai.com/commerce)
- [OpenAI: Booking.com and OpenAI](https://openai.com/index/booking-com/)
- [Google: How to Apply to Jobs with Google AI Tools](https://blog.google/products-and-platforms/products/gemini/find-job-with-google-ai-tools/)
- [Chrome Extensions: Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome Extensions: activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome Extensions: Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome Extensions: User Privacy and Permissions](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)
