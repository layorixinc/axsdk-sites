# RPC Lua — 9차: 모듈 전달 경로 (개발 루프가 여기서 막힌다)

날짜: 2026-07-27 · 대상: runtime / backend · 작성: axsdk-sites
8차 수정분 재확인 결과: **§2.1·§2.3 고쳐진 것 배포본에서 확인**. §2.2·§2.4 지적 수용 — 우리 측정이 경로를
잘못 잡았다. 아래는 그 다음에 부딪힌 **한 가지** 문제다.

---

## 1. 확인 완료 (배포본 실측)

| 8차 항목 | 재측정 |
|---|---|
| `execute.modules`만 (lua 없음) | `200` ✅ |
| 미지 키 | `400 ... has unknown keys: zzz_nonsense_key` ✅ |
| 둘 다 없음 | `400 ... unless execute.modules is declared` ✅ |
| 스칼라 반환 | `lua script must return a table, got string` ✅ |
| `configHash` | `GET /axsdk/v2/sessions/state` → `sha256:4950e4f78621` ✅ |

§2.2는 우리가 REST invoke를 `execute.modules`로 착각한 것이 맞다. 설계 문서에 두 경로의 차이를
명시했다(REST invoke = 모듈별 격리, `execute.modules` = 툴 단위 공유).

---

## 2. R19 — 클라이언트 세션에 모듈을 넣을 방법이 없다 (P0, 개발 루프 차단)

`execute.modules`는 동작한다. 그런데 **그 모듈을 실제로 도는 세션에 넣을 수단이 우리에게 없다.**

### 2.1 측정

**(a) 레지스트리는 세션 전용이다.** 세션 A에 올린 모듈은 세션 B에서 보이지 않는다.

```
POST /axsdk/v2/lua      (x-app-user-session-id: A)  name=probe.scope   → 200
GET  /axsdk/v2/lua      (A) → {"data":[{"name":"probe.scope",...}]}
GET  /axsdk/v2/lua      (B) → {"data":[]}
```

**(b) 세션 생성에 모듈을 실을 수 없다.** 둘 다 `200`이지만 레지스트리는 비어 있다 — 조용히 무시된다.

```
POST /axsdk/v2/sessions  { clientFlows, luaModules:       [...] } → 200, GET /v2/lua → {"data":[]}
POST /axsdk/v2/sessions  { clientFlows, clientLuaModules: [...] } → 200, GET /v2/lua → {"data":[]}
```

> 부수 발견: `POST /sessions`는 **미지 최상위 키를 조용히 통과시킨다.** flow 문서 쪽은 8차에서 400으로
> 바꿨는데 여기는 그대로다. 같은 이유로 같이 막아 주면 좋겠다 — 오타 난 키가 무시되면 저자는 자기가
> 뭘 틀렸는지 모른다.

**(c) 세션 id가 클라이언트에 노출되지 않는다.** 확장의 AX 컨텍스트에서 `_AXSDK.config`는
`baseUrl`/`appId`/`apiKey`를 주지만 세션 id는 없다. `chrome.storage.local`의 chat은 **binding** 키이고,
`ses_...`는 **`:debug-events` 싱크에만** 들어 있다 — 디버그 모드에서만 존재하는 진단용 데이터다.

### 2.2 그래서 무엇이 막히나

프로덕션 문서는 190.5 KiB(74%)다. 순수 레이어와 스토어프론트를 **인라인으로** 넣으면 넘친다. 그래서
Phase 2·3은 반드시 모듈로 나가야 하는데, 개발 중에 그 모듈을 검증할 방법이 없다:

- **앱 패키지** — `POST /axsdk/v2/apps/:appId/package`는 우리 **프로덕션 문서**를 덮어쓴다. 시험용 appId
  없이는 못 쓴다(8차에서 발급 약속을 받았다).
- **세션 레지스트리** — 확장이 만든 세션의 id를 알아야 하는데 계약상 알 수 없다. 진단 싱크를 긁는 것은
  디버그 모드 의존이고, 세션이 새로 만들어지면 그 순간 사라진다(업로드와 첫 턴 사이의 경합).

### 2.3 요청

**① 시험용 `appId` 발급** (8차 약속분). 이것만 와도 Phase 3은 진행된다 — 앱 패키지에 모듈을 올리고
Playground를 그 앱으로 돌리면 된다.

**② `clientFlows` 오버레이가 모듈도 실어야 한다.** 이쪽이 개발 루프의 진짜 해법이다. 오버레이는 이미
세션마다 문서를 나른다. 모듈은 **같은 문서의 나머지 반쪽**인데 지금은 다른 채널로만 갈 수 있다.

```jsonc
POST /axsdk/v2/sessions
{ "clientFlows": "<yaml>",
  "clientLuaModules": [ { "name": "_common.51_relevance", "source": "..." } ] }
```

세션 범위·세션 한도(512 KiB)·기존 해석 순서(앱 패키지 → 세션)를 그대로 쓰면 되고, 새 저장소가 필요 없다.
SDK 쪽은 이미 `clientFlows`를 보내고 있으니 필드 하나가 는다(우리가 SDK에 별도로 요청하겠다).

**③ 세션 id를 클라이언트에 노출** — ②가 되면 필요 없다. ②가 어렵다면 이것만이라도.

---

## 3. 우리 쪽 진행 (전부 TDD, 게이트 통과)

플랫폼 대기와 무관한 것만 진행했다.

| 산출물 | 내용 | 테스트 |
|---|---|---|
| 커머스 레이어 7분할 | 75.5 KiB 단일 파일 → 최대 17.3 KiB. 경계를 넘는 로컬 19개만 `C.*`로 승격, 호출부 무변경 | 197 + 라이브 35/35 |
| 빌더 `delivery: 'registry'` | 같은 `modules:` 선언에서 인라인 대신 **이름만** 내보내고 소스를 따로 넘긴다. 64 KiB 초과는 업로드가 아니라 **빌드**에서 실패 | 10 |
| `tools/rpc-modules.mjs` | 세션 레지스트리 업로더. 거부당하면 어느 모듈인지 + 그때까지 올라간 목록을 함께 던진다(부분 적재 세션은 "없는 함수"로 보인다) | 5 |
| `tools/rpc-allow.mjs` | `rpc.allow` 최소권한 감사. 대기 헬퍼를 `allow`에 적은 것(→ 폴링 op 지목), 안 부르는 권한, 없는 op | 11 + conformance |

`allow` 감사는 만들자마자 자기 결함을 하나 잡았다 — 모듈 선언을 보지 않아 authored 문서에서 진짜 권한
4개를 "미사용"으로 신고했다(빌드된 문서는 깨끗). 모듈 소스를 함께 읽도록 고쳤고, 읽을 수 없는 모듈은
**빈 것으로 가정하지 않고** `module_source_missing`으로 신고한다.

**게이트**: `test:lua` 197 · `check:flows` **44** · `test:commerce` 24/24 + 17/17 ·
`test:playground` 47 · `build:rpc` 51.5 KiB · 라이브 10개 스토어 35/35.
