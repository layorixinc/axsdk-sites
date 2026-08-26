# CWS 배포 기획 · 설계 — R1 임베드 출시, R2 원격 pack 업데이트

확정된 전략(사용자 지시, 2026-08-26):

- **R1 (첫 CWS 릴리스): 모든 pack을 확장 패키지에 임베드해서 배포한다. 원격 pack 취득 경로는 출시 대상이 아니다.**
- **R2 (다음 업데이트): 원격 community pack을 활성화한다.**

이 문서는 그 두 릴리스의 실행 설계다. 역할 분담:

| 문서 | 역할 |
|---|---|
| `CWS_LAUNCH_PLAN.md` | 정책 원문 대조와 차단 요인 등록부 (P0-1…P0-5, P1-*) |
| `CWS_PRODUCT_READINESS_REVIEW.md` | 사용자 여정 기준 준비도 판정 (2026-08-18 NO-GO + 08-22 부록) |
| `COMMUNITY_SCRIPT_IMPLEMENTATION_PLAN.md` | 커뮤니티/유저스크립트 채널의 Phase 등록부 |
| **이 문서** | R1·R2 실행 설계: 트랙, 변경 지점, 먼저 실패시킬 게이트, 완료 정의, 결정 대기 |

§1은 **오늘 다시 측정한 것**이다. 위 문서들은 4~8일 전 상태이고, 뒤집힌 서술은 §8에 모았다.

---

## 1. 오늘 실측 (2026-08-26)

### 1.1 pack 파이프라인 — 생산자와 소비자가 **테스트 안에서만** 연결되어 있다

| 측정 | 값 | 근거 |
|---|---|---|
| 데이터 모델 | `AgentPackManifestV2`(필수 asset `flow`+`taskScript`) · `ProviderPackManifestV2` · `PackReleaseEnvelope` · `CommandContractV1`(effect 5종, 비-read는 사용자 확인 강제) | `axsdk-packs/src/schemas.ts` 1,257줄 |
| 서명 | Ed25519, base64url 정확히 86자 | `schemas.ts:215-222` |
| 바이트 상한 | manifest 1 MiB · flow 512 KiB · script 2 MiB · release 16 MiB | `schemas.ts:28-32` |
| 매체 타입 | flow = `application/vnd.axsdk.flow-fragment+yaml`, script = `application/javascript` | `schemas.ts:707,736-737,785` |
| 생산자 | pack 2종: `layorix.shopping@1.0.0`(agent, flow+task+amazon provider), `example.store-x@1.0.0`(provider) | `tools/packs/first-party.ts` 431줄 |
| 생산자 원본 | `packs/shopping/flow.yaml` 4,887 B · `packs/shopping/src/task.js` 6,124 B · `packs/shopping/providers/amazon.js` 4,742 B · `packs/store-x/src/provider.js` 3,336 B | |
| 생산자 서명 | **빌드 플레이스홀더** `'A'×85+'Q'`, keyId `layorix-first-party-build`. 실제 Ed25519 서명자는 테스트만 주입 | `first-party.ts:22,270-272` |
| 생산자 출력 | **디스크에 쓰지 않는다.** 메모리 반환뿐이고 유일한 호출자는 자기 테스트 | `first-party.test.ts` |
| 소비자 취득 경로 | **네트워크 레지스트리 하나뿐** (`index.json`/`revocations.json`/`releases/<hex>.json`/`assets/<hex>`) | `packs/registry.ts:200,370-555` |
| 프로덕션 레지스트리 | `PACK_REGISTRIES = Object.freeze([])` — "Phase 2 deliberately ships no production root" | `packs/config.ts:17-19` |
| 태스크 실행 문서 | `PACK_TASK_EXECUTOR = undefined` → agent pack 태스크는 `no_executor_document`("The dedicated Pack task executor is not configured") | `packs/config.ts:25`, `background/service-worker.ts:371-377` |
| 임베드 pack 경로 | **없음.** 패키지에서 pack 바이트를 읽는 코드가 존재하지 않는다 | `src/packs/**` 전수 확인 |
| 검증·설치·합성·실행 | 서명→다이제스트→스키마→2단계 승인(설치는 `enabled:false`)→IndexedDB→재검증 합성→`chrome.userScripts` 아티팩트별 월드 | `registry.ts:222-533`, `installer.ts:131-176`, `composer.ts:93-138`, `broker-v2.ts:264-419` |

**결론**: "모든 pack을 임베드한다"는 것은 스위치를 끄는 일이 아니라 **없는 바이트 소스를 새로 만드는 일**이다.
원격 경로는 이미 데이터로 닫혀 있다(레지스트리 목록이 비어 있음). 열려 있는 것은 검증 파이프라인이고,
그건 그대로 재사용해야 한다 — 임베드를 이유로 서명·다이제스트·승인을 우회하면 R2에서 두 개의 경로를 갖게 된다.

### 1.2 소비자 아티팩트 — 원격 코드 표면 (P0-1 / P0-3)

| 측정 | 값 | 근거 |
|---|---|---|
| Fengari 청크 | `dist/assets/fengari-DcdTLR6B.js` **227,867 B** (`32c634427bba`), 서비스워커가 line 2에서 정적 import | dist 스캔 |
| Fengari 인라인 사본 | `dist/widget.js` 2,687,118 B · `dist/assets/session-worker-mRH0tH28.js` 2,159,822 B | `FENGARI_VERSION` ×20 each |
| `raw.githubusercontent.com` | 위 3개 번들에 각 ×5, **그 외 dist 파일 0** | dist 전수 스캔 |
| 그 5회의 출처 | `axsdk-core/src/sites.ts:194,205,224,235` + `src/types/axsdk.ts:74` (원격 사이트 로더) | |
| 원격 스위치 기본값 | `remote_sites`·`remoteSiteFlowsEnabled`·`remoteLuaEnabled` 모두 **`true`** | `extension-cdp/src/shared/config.ts:70-76` |
| 설치기 강제 | 매 서비스워커 시작마다 위 셋을 `false`로 고정 (패키지 검증 성공 시) | `background/workspace-assets.ts:266-271,293-300`, `service-worker.ts:1147-1165` |
| 옵션 페이지 | 원격 Lua/플로우 체크박스 **노출 중** → 다음 워커 시작까지 사용자가 재무장 가능 | `options/options.html:55-56`, `options/main.ts:246-249` |
| `build:cws` | 워크스페이스 다이제스트·에셋·선언 모듈 검증 + manual-QA 마커 12종 스캔. **제거 프로파일 아님** | `scripts/cws-package.mjs:66-127` |

### 1.3 도메인 게이트 (P0-3a) — 구현됐고 **배선되지 않았다**

`ops/domain-gate.ts` + `domain-gate.test.ts`(**25개 테스트**)와 디스패처 분기(`dispatcher.ts:36,91-99`)는 있으나,
프로덕션 생성 지점 `background/service-worker.ts:1392-1413`은 `domainGate`를 넘기지 않는다. 패키지 전체에서
`domainGate` 문자열은 `dispatcher.ts`와 그 테스트에만 있다(직접 확인). 따라서 오늘 페이지 op를 제한하는 것은
**세션 탭 그룹 멤버십**(`dispatcher.ts:83-88`)과 위험 동작 동의뿐이며, Site Access를 좁힌 사용자에게도
`chrome.debugger` 경로는 모든 페이지에 도달한다.

### 1.4 릴리스 파이프라인 — 구현 완료, 백엔드 상태 불일치

오늘 `npm run release:cws` 실행 결과:

```
CWS workspace sha256:75f134d684fd…: 32 assets, 26 modules
Error: backend module drift: stale _common.61_rpc_storefront, … (21건), missing _common.75_rpc_community
```

게이트는 **의도대로 닫혔다** — ZIP도 사이드카도 쓰이지 않았다. releaseId는
`sha256(확장 파일 해시 + 워크스페이스 다이제스트 + 런타임 모듈 해시 + 백엔드{appId, revision, moduleHashes})`이므로,
백엔드 동기화 없이 재현 가능한 제출 ZIP은 존재할 수 없다. 백엔드를 쓰는 경로는
`tools/rpc-package.mjs push --modules-only` 하나뿐이고 프로덕션 쓰기는 승인 사항이다.

### 1.5 매니페스트와 없는 산출물

`src/manifest.json` = `dist/manifest.json` (1,603 B): name `AXSDK Assistant (CDP)`, version `0.1.0`,
`minimum_chrome_version 138`, 권한 7종(`storage`, `userScripts`, `debugger`, `offscreen`, `tabGroups`,
`declarativeNetRequestWithHostAccess`, `scripting`), `host_permissions` `http://*/*`+`https://*/*`, 아이콘 4종, 고정 `key`.

**두 저장소 어디에도 없는 것**: 스크린샷(1280×800), 타일(440×280), 마키(1440×960), 스토어 긴 설명,
개인정보 처리방침 URL, 지원/홈페이지 URL, 권한 7종 + 광범위 호스트 소명 문구, `_locales/en|ko`,
데이터 사용 공시문, `.env.example`, 소비자 로그인, 개발자 표면 분리.

---

## 2. R1의 정체성 — 헌장과 제품이 서로 다른 말을 한다

`build:cws`가 매번 검증하는 `community/release-policy.json`의 헌장은 이렇다:

> AXSDK installs, manages, and runs **user-selected community web-automation scripts** on websites explicitly authorized by the user.

같은 파일이 `executionApi: chrome.userScripts`, `artifacts.executionLanguage: javascript`,
`luaPublication: deterministic_javascript_before_review`, `remoteInterpreter: false`를 못 박는다
(`tools/community-release-policy.mjs:64-107`).

그런데 **R1은 정의상 "사용자가 고른 커뮤니티 스크립트"를 설치하지 않는다** — 모든 pack이 임베드되고 원격 취득이 없다.
R1의 단일 목적 문장은 **임베드된 1차 당사자 pack으로 웹사이트를 대신 조작하는 에이전트**를 서술해야 하고,
현재 헌장 문장은 **R2의 제품**을 서술한다. 제출 시점에 문장을 즉석에서 만들면 이 불일치가 그대로 심사자에게 간다.

권고: 헌장 파일을 **릴리스별로 분리**한다 — `community/release-policy.json`은 R2(커뮤니티 트랙) 정책으로 범위를 명시하고,
R1은 `store/single-purpose.md`에 자기 문장을 갖고 `check:listing`이 그 존재를 강제한다. 게이트를 느슨하게 하지 않고
두 릴리스가 각자 참인 문장을 갖는다. → **결정 D1**

---

## 3. R1 설계

각 트랙은 **먼저 실패하는 게이트**로 시작한다. 이 저장소에서 반복 확인된 이유 때문이다: 검증이 없으면 다음 사람이
되돌릴 수 있고, 통과할 수 없는 선언은 통과하지 않는다는 사실조차 아무도 모른다.

### T1 — 패키지 내장 pack 레지스트리 (R1의 핵심, 신규 메커니즘)

**먼저 RED**: "임베드된 pack 2종이 신규 프로필에서 설치·활성 가능하다"를 주장하는 테스트. 오늘은
`PACK_REGISTRIES = []`이므로 취득 자체가 불가능해 실패한다.

**설계**

1. **생산자를 디스크로 내보낸다.** `tools/packs/first-party.ts`의 메모리 산출물을 패키지 레이아웃으로 쓰는
   빌드 스크립트(`tools/build-pack-registry.mjs`)를 추가한다. 레이아웃은 `packs/registry.ts:152-158`이 이미 기대하는 모양:
   `pack-registry/index.json`, `revocations.json`, `releases/<hex>.json`, `assets/<hex>`.
2. **패키지 fetch 구현을 넣는다.** `packs/config.ts:17,22`가 유일한 진입점이다. `PACK_REGISTRIES`에 패키지
   레지스트리 1개(고정 origin + 패키지된 Ed25519 신뢰 루트)를 싣고, `PACK_REGISTRY_FETCH`를
   `chrome.runtime.getURL('pack-registry/…')`를 읽는 구현으로 바꾼다. **검증 우회는 없다**: 서명·다이제스트·스키마·
   2단계 승인·비활성 기본값·합성 재검증이 모두 그대로 돈다. 같은 모양이 이미 두 곳에서 증명돼 있다 —
   `packs/manual-qa.ts:209-213`(패키지된 서명 응답을 fetch로 서빙)과
   `background/workspace-assets.ts:193-247`(`chrome.runtime.getURL` + 에셋별 다이제스트 확인).
3. **실서명으로 바꾼다.** 플레이스홀더 `'A'×85+'Q'`는 R1에 나갈 수 없다. R1 서명 키의 보관 주체가 곧 R2의
   레지스트리 키 관리자다 → **결정 D4**. 결정이 늦으면 R1은 빌드 키로 서명하고 "이 패키지 내부 무결성 한정,
   R2에서 대체"라고 문서에 명시한다 — 다만 그 문장을 코드 주석이 아니라 릴리스 노트에 남긴다.
4. **워크스페이스 매니페스트에 얹지 않는다.** C3는 Lua 참조 그래프(`.txt` 에셋)이고 pack은 서명 봉투 + 자체 바이트 상한을
   가진 별개 주소 공간이다. 형제 디렉터리로 둔다.

**증거**: `build:cws`가 pack 레지스트리 파일 존재·해시·서명을 검증(신규 게이트) · 신규 프로필에서 pack 2종 설치→활성→
합성 flowDocument 생성 · `test:packs` 그린 · 아티팩트 스모크에서 임베드 pack이 실제 턴을 수행.

### T2 — pack 태스크 실행 문서

**측정된 제약**: agent pack의 `execution.role = 'task'`는 `PACK_TASK_EXECUTOR` **URL 문서**에서 실행된다
(`service-worker.ts:362-448`). 프로덕션은 `undefined`라서 임베드 pack을 넣어도 태스크는
`no_executor_document`로 거부된다. `chrome.userScripts`는 확장 오리진 문서에 주입되지 않으므로 실제 웹 문서가 필요하다.

**결정 필요(D2)**: (a) 우리 오리진의 정적 실행 문서를 배포하고 마커를 고정 검증할 것인가, (b) R1 pack을
provider/read 계열로 한정해 태스크 역할을 쓰지 않을 것인가. (b)는 `layorix.shopping`이 `taskScript`를 **필수 에셋으로
선언**하므로 pack 재설계를 뜻한다(`schemas.ts:736-737`).

**먼저 RED**: 임베드 agent pack의 명령 1개를 실행하는 테스트 — 오늘 `no_executor_document`로 실패한다.

### T3 — 원격 코드 표면 제거 + 마커 게이트

**먼저 RED**: `scripts/cws-package.mjs`의 마커 스캔(현재 manual-QA 12종)에 `raw.githubusercontent.com`을 추가한다.
오늘 dist에는 3번들 × 5회가 있으므로 `build:cws`가 즉시 실패한다.

**변경 지점**

1. 빌드 상수 `__AXSDK_REMOTE_SOURCES__ = false` (`vite.worker/pages/content/page.config.ts`의 `define`,
   기존 `packManualQaDefines` 패턴 그대로).
2. `src/shared/sdk-config.ts:42-57`의 런타임 분기를 그 상수로 → `sites:{source}`·`remote_lua`·`remote_widgets`·
   `clientFlows.remoteSites`가 죽고 `axsdk-core/src/sites.ts` 로더가 트리셰이킹된다. 셰이킹이 안 되면 코어에서
   사이트 로더를 별도 subpath export로 분리한다.
3. `src/shared/config.ts:70-76` 기본값 `false` (방어선 이중화).
4. `options.html:55-56` + `options/main.ts:246-249`의 원격 체크박스 제거.
5. **`PACK_REGISTRIES`가 R1에서 패키지 레지스트리 **하나만** 갖고 원격 origin을 갖지 않음**을 게이트로 고정
   (T1이 넣는 항목이 `chrome-extension://` 스킴임을 검사).
6. community 채널의 `from-url` 설치(`options/community.ts:22` → `community/from-url.ts`)는 R1 소비자 빌드에서 제외한다
   — R1에 "사용자가 URL로 스크립트를 설치"하는 표면이 있으면 §2의 단일 목적 문장이 다시 흔들린다.

**하지 않는 것**: Fengari 제거. R1의 내장 플로우 엔진이 그것으로 돈다. 마커 게이트에 `FENGARI_VERSION`을 넣는 것은
R2 이후 마이그레이션(§4.3)이 끝난 뒤다 — 통과 불가능한 게이트는 게이트가 아니다.

**심사 대응 문장**(리스팅·소명에 그대로 쓸 사실): 인터프리터는 **패키지에서 SHA-256으로 검증된 바이트만** 실행하고,
바이트 안에 원격 취득 경로가 없음을 빌드 게이트가 매번 증명한다.

### T4 — 도메인 게이트 배선 (P0-3a)

**먼저 RED**: 프로덕션 디스패처 생성이 도메인 게이트를 공급하는지 검사하는 테스트(오늘 실패).

**변경 지점**: `background/service-worker.ts:1392`에 `createDomainGate` + `domainAllowlistFor` +
`productSitesFromIndex` + `createNavigationInvalidatedDomainGate` + `createDebuggerLocationReader` 주입.
모두 구현되어 있고 호출자가 없다.

**증거**: Site Access = *On click*에서 미승인 도메인 op가 `domain_not_approved`로 거부되고 승인 도메인은 통과 ·
사용자에게 보이는 허용 목록 · `qa:real` 유지.

### T5 — 소비자 인증·온보딩 + 개발자/소비자 빌드 분리 (P0-2, Phase 8)

**먼저 RED**: (a) 신규 프로필에서 "설정 없이 시작"이 소비자 문장으로 안내되는지, (b) 소비자 dist에 Lua 콘솔·레코더·
API 키 입력이 **없는지**(T3의 마커 게이트 확장).

**변경 지점**: 소비자 로그인 경로(`src/shared/start-readiness.ts:8-10`의 "Sign in or configure"가 실제로 가리킬 곳),
명시적 준비 상태, 실패 시 재시도·설정·중지, `__AXSDK_CONSUMER__` 정의로 `options.html:41-44`(키/App ID)·
`:50-70`(원격 토글)·`:190-193`(Lua 콘솔)·`:203-206`(레코더) 차단. 인증 방식은 백엔드 지원 필요 → **결정 D3**.

### T6 — 리스팅·프라이버시 산출물 (P0-4, P1-8)

즉석 문구로 제출하지 않기 위해 제출물을 저장소 파일로 만든다:

| 파일 | 내용 |
|---|---|
| `store/single-purpose.md` | R1 단일 목적 문장(D1) |
| `store/listing.md` | 제품명, 짧은/긴 설명, 카테고리 |
| `store/permissions.md` | 권한 7종 + 광범위 호스트 소명 각 한 단락 (`debugger`가 핵심) |
| `store/privacy.md` | 확장 전용 수집·사용·공유·보관 표, 수신자(백엔드·모델), 삭제 수단, Limited Use 확약 |
| `store/assets/` | 스크린샷 1280×800, 타일 440×280, 마키 1440×960 |
| `_locales/en`, `_locales/ko` | 매니페스트 name/description을 `__MSG_*__`로 |

**먼저 RED**: `check:listing` — 위 파일·섹션과 매니페스트의 `homepage_url`·개인정보 URL 존재 검사. 오늘 전부 없음.

### T7 — 릴리스 아토믹성 종결 (P0-6)

1. 백엔드 모듈 동기화: `node tools/rpc-package.mjs push --app=$AXSDK_APP_ID --modules-only` — **승인 필요(D5)**.
   오늘 불일치 22건.
2. `release:cws` 그린 → `dist/axsdk-extension-cdp-cws.zip` + 사이드카.
3. `.env.example`(이름만) 커밋 — `tools/build-cws-release.mjs`는 `.env`를 요구한다.
4. 깨끗한 체크아웃에서 동일 releaseId 재현.

---

## 4. R2 설계 — 원격 community pack 활성화

R1이 나간 뒤 **켜는 일**이지, 새로 만드는 일이 아니다. 이미 구현·테스트된 것: 서명 레지스트리(Ed25519),
아티팩트 캐시(읽을 때 해시), 2단계 승인 설치(기본 비활성), 재조정기, 아티팩트별 `USER_SCRIPT` 월드,
포트 브로커(선언 명령 화이트리스트·호출별 동의·출력 상한), 취소 피드.

### 4.1 켜지는 것

1. `PACK_REGISTRIES`에 **원격 레지스트리 origin + 리뷰된 Ed25519 루트** 추가 (`packs/config.ts:17`).
   R1의 패키지 레지스트리는 그대로 남는다 — 1차 당사자 pack은 계속 패키지에서 온다.
2. 옵션 UI의 조회/새로고침/설치 흐름 활성화 (`options/packs.ts:283-290`의 "Installation stays closed" 해제).
3. 취소 피드 폴링과 원자적 롤백(`updates.automatic: false`, `atomicRollback: true` — 정책 파일이 이미 못 박음).

### 4.2 필요한 발행 인프라 (Phase 9, 오늘 RED)

서명 키 관리자, 리뷰어 소유권, 발행 CI, Tier 2 검증기. **구현이 아니라 결정에 막혀 있다**(D4).

### 4.3 그 다음 (선택) — Fengari 제거

사이트 특화 Lua **7파일 4,207줄**(`61_rpc_storefront` 956 · `62_rpc_sites` 942 · `65_rpc_quote` 1,082 ·
`67_rpc_cart` 463 · `64_rpc_thumbtack` 270 · `66_rpc_navigate` 269 · `68_rpc_checkout` 225)을 컴파일된 JS
pack 스크립트로 옮기면 인터프리터가 소비자 빌드에서 사라진다. 엔진 로직 7파일 1,602줄(memory·offers·widget·zip·
sitemap·pure·community)은 이전 대상이 아니다. 그때 `FENGARI_VERSION`을 마커 게이트에 넣는다.

---

## 5. 실행 순서

```mermaid
graph LR
  T1[T1 내장 pack 레지스트리] --> T2[T2 태스크 실행 문서]
  T1 --> T3[T3 원격 표면 제거·게이트]
  T3 --> T5[T5 소비자 인증·빌드 분리]
  T3 --> T4[T4 도메인 게이트]
  D1[D1 단일 목적] --> T6[T6 리스팅·프라이버시]
  T2 --> T7[T7 백엔드 동기화·ZIP]
  T4 --> T7
  T5 --> T7
  T6 --> T7
  T7 --> SUB[R1 제출]
  ONE[One Stop 문의 발송] --> SUB
  SUB --> R2[R2 원격 pack 업데이트]
```

T1이 선행인 이유: R1의 정체성(§2)과 T3의 게이트 문구, T6의 소명 문장이 모두 "pack이 어디서 오는가"에 달려 있다.
T3·T4·T5·T6은 서로 독립이라 병렬로 간다.

## 6. 제출 체크리스트

- [ ] 단일 목적 문장(D1) · 짧은/긴 설명 · 카테고리
- [ ] 스크린샷 ≥1(1280×800) · 타일 440×280 · 마키 1440×960
- [ ] 권한 7종 + 광범위 호스트 소명(`debugger` 포함)
- [ ] 개인정보 처리방침 URL(확장 전용 서술) · 지원 URL · 데이터 사용 공시 · Limited Use 확약
- [ ] dist에 `raw.githubusercontent.com` 0회, `PACK_REGISTRIES`가 패키지 레지스트리 전용 — 게이트가 증명
- [ ] 임베드 pack 2종이 신규 프로필에서 설치→활성→실제 턴 수행
- [ ] 업로드 ZIP = `release:cws`가 검증·자기추출·재검증한 바이트, releaseId가 런타임 보고값과 동일
- [ ] `test:cws:artifact` 그린(신규 프로필, 패키지 소스만, 주문 없음)
- [ ] One Stop 문의 답변 수신

## 7. 결정 필요

| # | 결정 | 소유 | 막고 있는 것 |
|---|---|---|---|
| D1 | R1 단일 목적 문장을 임베드 에이전트로 확정하고, 커뮤니티 헌장은 R2 트랙 정책으로 범위 명시 | BIZ + EXT | T6, 제출 |
| D2 | pack 태스크 실행 문서: 우리 오리진 정적 문서 배포 vs R1 pack을 provider/read로 한정 | EXT | T2 |
| D3 | 소비자 인증 방식(백엔드 로그인·세션 발급) | BIZ + 백엔드 | T5 |
| D4 | pack 서명 키 관리자 · 리뷰어 소유권 (R1 실서명, R2 발행) | BIZ | T1, R2 |
| D5 | 프로덕션 백엔드 모듈 푸시 승인 (`--modules-only`, 22건) | 사용자 | T7 |
| D6 | `optional_host_permissions` 이전 여부 — 제출 전에 호스트를 좁힐 것인가 | EXT + BIZ | T6 소명 |
| D7 | One Stop 문의 2건 발송 시점 (`CWS_ONE_STOP_INQUIRIES.md`, 작성 완료) | BIZ | 제출 판단 근거 |

## 8. 이 문서가 뒤집은 기존 서술

| 서술 | 어디 | 오늘 측정 |
|---|---|---|
| Phase 4 "도메인 게이트가 디스패처 단일 생성 지점에 배선됨 · Complete" | `COMMUNITY_SCRIPT_IMPLEMENTATION_PLAN.md:404-407` | **배선 없음**, 프로덕션 호출자 0 (§1.3). 테스트 25개 주장은 정확 |
| 워크스페이스 "31 assets / 25 modules" | 준비도 리뷰 P0-1 | **32 assets / 26 modules** (`75_rpc_community` 추가) |
| RPC 모듈 "14 → 13" | 준비도 리뷰 P1-5 | `_common/rpc` 오늘 **14 파일** |
| P0-6 "revision 125, 21 stale" | 준비도 리뷰 P0-6 | 오늘 **21 stale + 1 missing = 22** (§1.4) |
| `build:cws`가 CWS 전용(제거) 프로파일 | 암시적 | 검증 전용, 제거하는 코드 없음 |
| pack 파이프라인이 출시 가능한 상태 | 암시적 | 생산자 출력이 **디스크에 없고** 서명이 플레이스홀더, 임베드 경로 없음, 태스크 실행 문서 미구성 (§1.1) |
