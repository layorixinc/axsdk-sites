# RPC Lua — 10차: 샌드박스 인수 결과

날짜: 2026-07-27 · 대상: runtime / backend · 작성: axsdk-sites
9차 처리분(샌드박스 앱 · 오버레이 모듈 · 미지 키 경고)에 대한 실측 확인이다.

---

## 1. 통과 — 앱 패키지로 모듈이 나간다

`axsdk-sites-sandbox`에 우리 Playground 산출물을 밀었다.

```
POST /axsdk/v2/apps/axsdk-sites-sandbox/package
→ 200 { revision: 9 → 10,
        hash: { flowDocument: sha256:5f8e2756cae7, sitemap: sha256:4325298a0077,
                luaModules: { _common.16_rpc_storefront: sha256:6946a067c56d,
                              _common.17_rpc_sites:      sha256:26a00eab048d } },
        luaModules: { bytes: 22064, count: 2, limit: 2097152 } }
```

**문서 51.5 KiB → 26.0 KiB.** 이행의 목적이 숫자로 확인됐다. sitemap 필수라는 사전 경고 덕분에 한 번에
통과했다 — 고맙다.

`luaModules`는 **배열이 아니라 name→source 맵**이다(`400 luaModules: object map of name to source
is required`). 메시지가 정확해서 바로 고쳤다. 우리 업로더는 세션 레지스트리용이라 `{name, source}`
단건 POST이고, 패키지는 맵이다 — 두 모양이 다르다는 것만 문서에 있으면 좋겠다.

미지 키 경고 방침(400 대신 warning)도 수용한다. 배포된 외부 SDK를 측정할 수 없다는 근거가 우리
`execute` 키와 폭발 반경이 다르다는 것도 맞다. 우리가 겪은 문제는 "무시된 걸 알 방법이 없다"였고
`warnings`면 해결된다.

---

## 2. R20 — 샌드박스 앱의 도메인 허용목록 (P0, 브라우저 검증 불가)

패키지는 올라갔는데 **그 앱으로는 브라우저가 세션을 못 만든다.**

Playground 프로필을 샌드박스로 겨누고 턴을 돌리자 확장 텔레메트리가 이렇게 남았다:

```
http  request   POST https://local.axsdk.ai/axsdk/v2/sessions
http  response  401
chat  session:ensure:failed  { errorName: "ApiError" }
```

origin을 바꿔가며 두 앱을 대조했다(`POST /axsdk/v2/sessions`, 같은 본문):

| origin | `browser-extension` | `axsdk-sites-sandbox` |
|---|---:|---:|
| `http://localhost:3334` | 200 | **200** |
| `https://axsdk.ai` | 200 | **401** |
| `https://www.11st.co.kr` | 200 | **401** |
| `https://www.amazon.com` | 200 | **401** |
| `chrome-extension://<확장 id>` | 401 | 401 |
| (origin 없음) | 401 | 401 |

401 본문: `AXSDK: domain not allowd: https://axsdk.ai`.

확장은 **페이지 origin**을 보낸다. `browser-extension`은 https 사이트 origin을 받아주고 샌드박스는
`http://localhost:3334`만 받는다. 그래서 샌드박스로는 **어떤 사이트에서도** 세션이 생기지 않고,
패키지 모듈이 실제 브라우저에서 도는지 확인할 방법이 없다.

**요청**: 샌드박스의 허용 도메인을 `browser-extension`과 같게 맞춰 달라. 그 한 줄이면 Phase 3 리허설이
끝까지 간다 — 지금은 패키지 푸시(HTTP)까지만 되고 실행(브라우저)이 막혀 있다.

---

## 3. 부수 발견 2건

### 3.1 `POST /axsdk/v2/sessions/message`가 세션 생성 라우트에 매칭된다 (P2)

턴을 HTTP로 돌리려고 이 경로를 불렀더니 **200에 세션 객체**가 돌아왔다. 우리는 턴이 접수된 줄 알고
결과를 기다렸고, `GET /axsdk/v2/sessions/messages`는 계속 `{"messages":[]}`였다. 존재하지 않는 경로가
**성공처럼 보이는 응답**을 준 것이라 오진에 시간을 썼다.

404로 떨어뜨리거나, 턴을 HTTP로 넣는 정식 경로를 알려 달라. (SSE 클라이언트가 유일한 방법이라면
그렇다고만 해도 된다.)

### 3.2 `GET /axsdk/v2/sessions/state`가 500을 한 번 냈다 (P3)

메시지 POST 직후 같은 세션에서 `500 INTERNAL_SERVER_ERROR`, 4초 뒤 재시도에서 200
(`configHash: sha256:b42b8de9c902`, `configRevision: 6`). 재현 조건을 좁히지는 못했다. `configRevision`이
R12 리비전으로 실제 값이 들어오는 것은 확인했다.

---

## 4. 오버레이 — API는 되고, SDK가 아직 안 보낸다

`POST /axsdk/v2/sessions { clientFlows, clientLuaModules }`는 200으로 받는다. 다만 확장/SDK가 이 필드를
보내지 않으므로 **브라우저 개발 루프는 아직 오버레이를 못 쓴다.** SDK 쪽 요청은 우리가 따로 낸다.
그래서 당분간 우리 개발 루프는 이렇게 간다:

- 스토어 오버레이(`ax sync` / `playground sync`) — 지금까지대로, `browser-extension`.
- 모듈 전달 — 샌드박스 앱 패키지. **R20이 풀리면** 브라우저 검증까지 이어진다.
- `browser-extension`에는 **패키지를 푸시하지 않는다.** `GET`으로 확인했듯 그 앱의 `flowDocument`와
  `sitemap`은 프로덕션 그 자체다.

---

## 5. 우리 쪽 상태

커밋 4개(`9f43005` 커머스 7분할 · `652704e` 모듈 전달 · `9024b87` `allow` 감사 · `fa3af43` 문서).
게이트: `test:lua` 197 · `check:flows` 44 · `test:commerce` 24/24 + 17/17 · `test:playground` 47 ·
라이브 10개 스토어 35/35.

Playground 파일럿 재확인(프로덕션 앱, 저장 오버레이):
`RPC SEARCH OK · found=22 · cards=24`, 실제 11번가 가격 포함, 24.9s.
