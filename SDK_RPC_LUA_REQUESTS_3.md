# SDK 요청 (3차) — 앱 패키지만으로 도는 클라이언트

날짜: 2026-07-27 · 대상: `../axsdk-sdk-js` (확장/코어) · 작성: axsdk-sites
근거: 전용 Playground 프로필(포트 9235) 실측. 확장 텔레메트리 원문 포함.

백엔드/런타임 쪽은 열렸다. 10차 회신으로 시험용 앱 `axsdk-sites-sandbox`가 사이트 origin에서 열리고,
앱 패키지가 `flowDocument` + `sitemap` + `luaModules`를 받는다. 우리 쪽 검증기도 붙였다 —
`npm run package:verify`가 빌드 산출물과 앱이 서빙 중인 것을 **부분별 sha256으로** 대조한다
(현재 `revision 15`, 불일치 0).

남은 것은 클라이언트다.

---

## S5 — `clientLuaModules`를 세션 생성에 실어 달라 (P0)

백엔드가 받는다(9차 채택, 10차 확인). 해석 순서는 **앱 패키지 → 오버레이 → 세션 레지스트리**이고,
빈 배열은 "비움", 부재는 "유지"로 구분된다.

지금 SDK는 `clientFlows`만 보낸다. 그래서 문서는 오버레이로 갈아끼울 수 있는데 **그 문서가 부르는
모듈은 갈아끼울 수 없다.** 개발 루프가 앱 패키지 푸시에만 의존하게 되고, 푸시는 앱 전체를 교체하므로
반복 주기가 길고 되돌리기가 무겁다.

요청: `clientFlows`를 보내는 그 자리에서 `clientLuaModules`도 보낼 수 있게 해 달라. 저장소는
`axsdk:flows`와 같은 모양이면 충분하다(키 `":"` = 공통, `":"+domain` = 사이트).

---

## S6 — `AXSDK.init`이 `app.translations: null`에 죽는다 (P0)

Playground 프로필의 앱 id를 시험용 앱으로 바꾸기만 하면 바인딩이 뜨지 않는다. **S7이 도착한 덕에**
원인이 정확해졌다:

```
extension binding:render-failed {
  stage: "sdk-init",
  errorName: "TypeError",
  message: "Cannot convert undefined or null to object",
  stack: "at Object.keys(<anonymous>) | at bK (content.js:437:31438) | at c.init (content.js:439:2596)"
}
extension binding:session-skipped
```

`GET /axsdk` 응답을 두 앱에서 전수 비교해 null 필드를 모두 뽑았다. 공통 null(`app.toolsSchema`,
`app.voiceConfig`, `appUser.gender/age`)은 프로덕션에도 있으니 무해하고, **유일한 차이가 하나다**:

```
browser-extension  app.translations = {"en":{"chatOnboarding":""},"ko":{"chatOnboarding":""}}
sandbox            app.translations = null
```

`Object.keys(null)`이 정확히 저 메시지다.

요청: `init`이 `translations`(그리고 같은 모양으로 순회하는 다른 선택 필드)를 **null 안전하게** 읽게 해
달라. 번역이 없는 앱은 번역이 없는 것이지 뜨지 못할 앱이 아니다. 지금은 `TypeError` 하나 남기고 세션
생성 자체를 건너뛰어서, 증상이 "플로우가 아무것도 못 만들었다"와 똑같이 보인다.

**자기 정정 2건** — 이 항목은 두 번 틀렸다가 여기까지 왔다:

1. 처음엔 "`clientFlows.stored`를 꺼서 패키지 권위 구성으로 만들었다"고 썼는데, `axsdk:extension:config`에
   `clientFlows` 객체를 써 넣은 것이었고 `build-axsdk-config.ts:61`은 그 키를 읽지 않는다
   (`remoteSiteFlowsEnabled` / `storedFlowsEnabled`). 편집은 무효였고 실제 변수는 **앱 id 하나**였다.
2. 다음엔 "앱 설정이 얇아서(`defaults`/`contexts` 부재)"라고 썼다. 백엔드가 배포 엔드포인트를 고쳐
   `defaults`/`tools`가 채워졌고, `contexts`는 우리 문서에 섹션이 없던 것이었다. 둘 다 해결된 뒤에도
   같은 실패가 남아서 부트스트랩 페이로드까지 내려가 위를 찾았다.

(백엔드에는 R22로 따로 냈다 — 앱 생성 경로가 `translations`를 비워 두지 않도록. 둘 중 하나만 고쳐도 이
환경은 풀리지만, 둘 다 값어치가 있다.)

---

## S7 — `binding:render-failed`의 진단 가능성 — **이미 도착했다. 감사**

요청하려던 것이 이미 들어와 있었다. 지금 이벤트는 이렇게 남는다:

```jsonc
{ "requestRevision": 1, "stage": "sdk-init", "errorName": "TypeError",
  "message": "Cannot convert undefined or null to object",
  "stack": "at Object.keys(<anonymous>) | at bK (content.js:437:31438) | at c.init (content.js:439:2596) | ..." }
```

그리고 렌더 실패 뒤에 `binding:session-skipped`가 따라온다 — "아무 일도 안 일어남"과 구별된다.

**이 둘이 S6를 풀었다.** `stage: "sdk-init"`이 구간을 잘라 줬고 `Object.keys`가 든 스택이 부트스트랩
페이로드를 뒤지게 했다. 그 전 라운드에서 우리가 원인을 두 번 틀린 이유가 정확히 이 정보의 부재였다.

남은 요청 하나만: `stack`의 프레임이 `content.js:437:31438`처럼 번들 좌표라 파일/함수를 짚을 수 없다.
소스맵이 붙거나, 최소한 던진 지점의 심볼 이름이 있으면 좋겠다(P3).

---

## 참고 — 우리 쪽에서 이미 한 것

- `tools/rpc-package.mjs` — 부분별 sha256 대조. 서버가 보고하는 형식(`sha256:` + 앞 12 hex)을 실측으로
  고정했고, 라이브 푸시 값과 일치를 테스트로 못 박았다. 첫 실행에서 우리 실수를 잡았다(저장소 `index.md`를
  Playground 워크스페이스의 것 대신 밀어 넣었던 것).
- `tools/rpc-modules.mjs` — 세션 레지스트리 업로더(S5가 오면 오버레이로 대체된다).
- `tools/rpc-allow.mjs` — `rpc.allow` 최소권한 감사.
- 빌더 `delivery: 'registry'` — 문서 51.8 → **26.3 KiB**.

게이트: `test:lua` 197 · `check:flows` **54** · `test:commerce` 24/24 + 17/17 · `test:playground` 47.
