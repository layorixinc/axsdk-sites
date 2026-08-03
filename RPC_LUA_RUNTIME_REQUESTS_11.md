# RPC Lua — 11차: R21 확인 · R22 앱 부트스트랩의 `translations: null`

날짜: 2026-07-27 · 대상: runtime / backend · 작성: axsdk-sites

---

## 1. 10차·R21 처리분 확인

- **R20 도메인 허용목록** — `https://axsdk.ai` / `https://www.11st.co.kr` / `https://www.amazon.com` 200.
- **R21 `defaults`/`tools`** — 고쳐진 것 확인. 세션 config를 두 앱에서 다시 비교했더니
  **`appID`/`sessionID`/`resolvedAt` 말고 다른 차이가 없다.** 샌드박스에 심지 않고 엔드포인트를 고친
  판단이 옳았다 — 그 경로로 배포될 앱 전부가 같은 자리에서 막혔을 것이다.
- **`contexts`는 우리 몫이 맞았다.** playground 문서에 `contexts:` 섹션이 없었다. 넣고 다시 밀었더니
  (`revision 22`) 세션 config에 실린다. `check:flows`에 "모든 배포 문서는 `contexts` 섹션을 선언한다"를
  추가했다 — 없으면 확장이 바인딩을 못 그리는데, 증상이 "플로우가 아무것도 못 만들었다"와 같아서다.
- **부재=유지** 규칙 확인했다. 문서만 바꾸는 푸시가 `defaults`/`tools`를 지우지 않는다.
- **S7(오류 상세)도 도착했다.** `stage`/`message`/`stack`이 실려서 이번 진단이 가능했다. 아래가 그 결과다.

---

## 2. R22 — 앱 부트스트랩이 `translations: null`을 준다 (P0)

R21이 고쳐진 뒤에도 샌드박스로는 바인딩이 뜨지 않는다. 이제 이유가 정확하다:

```
extension binding:render-failed {
  stage: "sdk-init",
  errorName: "TypeError",
  message: "Cannot convert undefined or null to object",
  stack: "at Object.keys(<anonymous>) | at bK (content.js:437) | at c.init (content.js:439) ..."
}
extension binding:session-skipped
```

`AXSDK.init` 안에서 `Object.keys(...)`가 `null`을 받는다. `GET /axsdk` 응답을 두 앱에서 전수 비교해
**null인 필드**를 모두 뽑았다:

| 앱 | null 필드 |
|---|---|
| `browser-extension` | `appUser.gender`, `appUser.age`, `app.description`, `app.toolsSchema`, `app.voiceConfig` |
| `axsdk-sites-sandbox` | `appUser.gender`, `appUser.age`, `app.toolsSchema`, **`app.translations`**, `app.voiceConfig` |

공통 null(`toolsSchema`, `voiceConfig`, `appUser.*`)은 양쪽 다 있고 프로덕션은 정상 동작하므로 무해하다.
**유일한 차이가 `app.translations`다.**

```
browser-extension : {"en":{"chatOnboarding":""},"ko":{"chatOnboarding":""}}
axsdk-sites-sandbox: null
```

`Object.keys(null)`이 정확히 저 메시지를 낸다.

**요청**: 앱 생성 경로가 `translations`를 비워 두지 않게 하거나(프로덕션처럼 빈 로케일 맵), 최소한
API가 `null` 대신 `{}`를 싣게 해 달라. R21과 같은 종류의 문제다 — 앱 하나에 값을 심는 것보다 **만드는
경로**를 고치는 편이 다음 사람을 구한다.

클라이언트가 `null`에 죽는 것 자체는 SDK 견고성이라 그쪽에 따로 냈다(S6). 둘 중 하나만 고쳐도 이 환경은
풀리지만, 둘 다 고칠 값어치가 있다고 본다.

---

## 3. 우리 쪽 상태

`npm run package:verify` — `revision 22`, 부분별 sha256 불일치 0. 문서 26.3 KiB(인라인 51.8 KiB).
게이트: `test:lua` 197 · `check:flows` 54 · `test:commerce` 24/24 + 17/17 · `test:playground` 47.

R22(또는 S6)가 풀리면 남은 것은 라이브 스윕뿐이다. Phase 3 이식은 그동안 오프라인으로 끝내 둔다.
