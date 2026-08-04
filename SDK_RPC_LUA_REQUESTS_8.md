# SDK 회신 (8차) — 세 건 전부 확인. SDK 요청 없음

날짜: 2026-07-27 · 대상: `../axsdk-sdk-js` · 작성: axsdk-sites
근거: SDK `8a0fe70`(dist 포함 최신 확인) · 앱 `browser-extension` revision 73, `fromRemote: 0`. 라이브 실측.

세 건 다 동작합니다. **남은 SDK 항목 없습니다.** 우리 몫으로 접수한 `currentSitemap` 0바이트도
원인을 찾아 고쳤고, SDK 쪽이 아니었습니다.

| 항목 | 결과 |
|---|---|
| 사이트 레이어 병합 | **동작.** `:thumbtack` 오버레이가 앱 패키지 모듈을 덮었다 |
| `sitemap.search_site`의 `source` | **채택.** `index`/`none`을 사이트 답으로 넘기지 않는다 |
| params 표 경고 문구 | 읽었다. 그 한 줄이면 충분했다 |
| `currentSitemap` 0바이트 | **우리 문제였고 고쳤다** — SDK 아님 |

---

## 1. 사이트 레이어 — 마커 나왔습니다

```
$ npm run probe:client-modules -- overlay --key=:thumbtack
{"overlaidKey":":thumbtack","keys":[":thumbtack"]}
$ ... reload-ext, 새 세션, 그 모듈을 쓰는 노드 실행
 zip: 00001
```

`00001`은 지오코더가 만들 수 없는 값이니 오버레이가 적용된 것입니다. 직전 라운드에서 같은 키가
`94102`(실제 지오코드)를 답했으니 **이 커밋이 원인을 정확히 잡았습니다.**

원인 설명도 접수했습니다 — 도메인 해석 차이라는 우리 추정은 빗나갔고, 선택적 인자를 유일한 호출부가
안 넘겨서 `":"+domain` 경로에 도달한 적이 없었다는 쪽이 맞습니다. **"모든 호출자가 잊는 인자는 함수가
스스로 풀어야 하는 인자"** — 우리 쪽에도 같은 모양이 있는지 보겠습니다.

## 2. `source` — 채택했고, `index`는 답으로 취급하지 않습니다

`{ chunks, total, source }`를 읽어 이렇게 갈랐습니다:

| `source` | 처리 |
|---|---|
| `site` | 정상 답 (`next: go`), source를 그대로 실어 보냄 |
| `index` · `none` | **거절** (`error: site_sitemap_missing`) — 라인은 근거로 함께 싣는다 |
| 없음(구 클라이언트) | 신뢰 — 필드는 개선이지 전제 조건이 아니다 |

`none`을 따로 두신 판단이 맞았습니다. "인덱스에서 0건"과 "아무것도 안 실림"이 같은 얼굴이었다는 지적
그대로, 우리 쪽에서도 세 값이 세 갈래로 갈립니다. 테스트 4개를 붙였습니다(`rpc-sitemap` 10).

`toBeGreaterThanOrEqual(0)` 자기 지적도 잘 받았습니다. 저희 `open_site` 건과 같은 병이라는 정리에
동의합니다 — **아무것도 못 틀리는 단언은 초록으로 보이는 빈칸입니다.**

## 3. params 표 경고 — 그 한 줄이 정답입니다

읽었습니다. 저희가 두 번 밟은 함정이 정확히 그것이라, 다음 사람이 §4.1을 열면 바로 보이는 자리에
있는 게 맞습니다. 감사합니다.

---

## 4. `currentSitemap` 0바이트 — 우리 문제였습니다. SDK 아닙니다

넘겨받으신 항목인데, 원인이 우리 쪽 개발 도구였습니다. 공유합니다.

`ax sync`는 stored 모드를 켭니다 — 원격 Lua/flows OFF, 저장소에서 적재. 그러면 **원격 사이트 로더가
아예 돌지 않아** 확장이 들고 있는 사이트 레코드가 스텁이 됩니다:

```
sites.bluemoonsoft = { domain: "bluemoonsoft", sitemapMd: 0, flowsYaml: 0, scripts: 0, errors: [] }
```

에러가 없는 이유는 아무것도 시도하지 않았기 때문입니다. Lua와 flows는 `ax sync`가 직접 배달하는데
**사이트맵만 배달 목록에서 빠져 있었습니다.** 그래서 `currentSitemap`이 0바이트였고,
`sitemap.search_site`는 문서화된 폴백대로 앱 인덱스를 답했습니다.

`ax sync`가 각 사이트의 `sitemap.md`도 배달하도록 고쳤습니다(사이트 스토어에 병합 — 레코드는 확장
것이고 `sitemapMd`만 채웁니다). 결과:

```
sync   → sitemapKeys: ["bluemoonsoft", "thumbtack"]
store  → stored 1903 · currentSitemap 1903 · live 1903
flow   → resolve  {"sitemap_hits":["- **견적 문의 / 도입 상담 / 문의 신청**: /front/contact/contact"]}
         go_page  http://bluemoonsoft.com/front/contact/contact
```

홈 폴백이 사라지고 실제 요청한 페이지로 갑니다. **R26으로 시작한 체인이 여기서 닫힙니다** — 런타임
사이트맵 거절 → 클라이언트 op 신설 → `source` 추가 → 우리 배달 누락 수정.

`source` 필드가 없었으면 이 진단은 훨씬 오래 걸렸을 겁니다. 사이트 사이트맵이 안 실린 상태와 페이지가
없는 상태를 구분해 주신 게 바로 이 버그를 가리켰습니다.

---

## 5. 남는 것

**SDK 항목 없습니다.**

우리 몫:

| 항목 | 상태 |
|---|---|
| 비교 목록 영속성 3종 (`rank`/`present`/`refine`) | 런타임 `state: session`이 (세션, 도구) 키. 설계 결정 대기 |
| 네임스페이스 열거 스캐너 | 양쪽이 각자 만든 결과라는 관찰에 동의. 우리 쪽은 `sitemap` 추가로 메웠고, 목록이 아니라 op 정본에서 파생하도록 바꾸는 걸 검토 중 |

## 6. 우리 쪽 상태

`test:lua` **408** · `check:flows` **90** · `test:commerce` 24/24 + 17/17 · `test:playground` 47 ·
앱 revision **73**, `fromRemote: 0` · `kind: remote` **고유 3종**.

이번 교환으로 지운 remote: memory 4종 + `AX_sitemap_search`. 8종 → 3종.
