---
layout: default
title: 개발과 디버깅
---

[← 처음으로](index.html)

# 개발과 디버깅

가장 짧고 정직한 개발 루프는 **loopback HTTP 서버 → URL 설치 → 실제 페이지에서 실제 대화**입니다.
프로덕션과 같은 설치·권한·브로커 경로를 지나므로, 페이지 콘솔에서 함수를 직접 부르는 것보다 낫습니다.

## 1. 로컬 릴리스 디렉터리 만들기

```text
release/
  manifest.json
  assets/<sha256>.js
```

[저작 안내](authoring.html)의 명령으로 코드의 SHA-256과 바이트 수를 계산하고 파일을 배치합니다.

## 2. 로컬 서버 열기

디렉터리의 부모에서 정적 서버를 띄웁니다. 아래 중 하나면 됩니다.

```bash
# Python
python -m http.server 8000 --bind 127.0.0.1

# Node가 있으면
npx http-server -a 127.0.0.1 -p 8000
```

설치 URL은 예를 들어 다음과 같습니다.

```text
http://127.0.0.1:8000/release/manifest.json
```

프로덕션 소스는 HTTPS만 허용하지만 **localhost / 127.0.0.1 / [::1] 의 HTTP는 개발용으로
허용됩니다.** 그 밖의 HTTP는 `insecure_source` 로 거부됩니다.

## 3. 설치하고 한 번 새로고침

1. 확장 설정 → Community scripts → manifest URL → **Look it up**
2. 요약과 출처 URL 확인 → **Install** → **Enable**
3. `execution.matches` 에 맞는 테스트 페이지를 **새로고침**
4. 에이전트를 시작하고 스크립트와 명령을 이름으로 지목해 요청

Enable 전에 이미 열린 문서에는 등록 코드가 없을 수 있습니다. `no_connected_document` 라면 먼저
새로고침합니다.

코드를 고친 뒤에는:

1. SHA-256을 다시 계산
2. 새 `assets/<sha256>.js` 생성
3. `manifest.artifact.ref` 와 `bytes` 수정
4. 가능하면 `script.version` 도 올림
5. 같은 manifest URL을 다시 **Look it up** → **Approve the update**
6. 테스트 페이지 새로고침

같은 버전이라도 manifest나 코드가 달라지면 update로 인식하지만, 사람과 캐시가 구분할 수 있도록
개발 버전도 `0.1.0-dev.1`, `0.1.0-dev.2` 처럼 올리는 편이 낫습니다.

## 4. 관측 가능한 곳

### 가장 신뢰할 수 있는 것 — 버튼 결과

커뮤니티 명령 버튼은 `running` 동안 잠기고 성공·거부·실패 결과를 그 자리에서 보여줍니다. 모델의
최종 문장보다 먼저 이 결과를 봅니다. 모델이 다른 intent로 라우팅한 문제와 스크립트 실행 실패는
서로 다른 문제입니다.

### 명령 자체가 진단을 반환하게 하기

스크립트가 던진 예외는 사용자에게 상세 스택 대신 `script_error` 로 보입니다. 비밀·페이지 데이터가
오류를 타고 모델로 새지 않게 한 경계입니다. 개발 중에는 예외를 **안전한 진단 값**으로 바꾸는 읽기
명령을 두는 편이 낫습니다.

```js
AXSDK.register({
  commands: {
    diagnose: async () => {
      try {
        const el = document.querySelector('[data-testid="target"]');
        return { ok: true, found: el !== null, url: location.href };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
  },
});
```

오류에 토큰·쿠키·폼 값·개인정보를 넣지 않습니다. `console.log` 는 브라우저와 실행 world에 따라
찾기 어려울 수 있으므로, 명령 결과를 주 관측점으로 씁니다.

### 페이지 DevTools

DOM과 selector는 페이지 DevTools의 Elements/Console에서 확인합니다. 다만 `AXSDK`는 일반 page
world가 아니라 Chrome의 **USER_SCRIPT world**에 있고, 등록한 command 함수도 전역으로 노출되지
않습니다. page 콘솔에서 `AXSDK.register` 를 다시 부르는 것은 실제 설치 경로를 재현하지 않습니다.

## 5. 자주 보는 설치 오류

| 코드 | 확인할 것 |
|---|---|
| `insecure_source` | manifest가 HTTPS인가? 개발이면 loopback HTTP인가? |
| `registry_unreachable` | URL 404, Pages 배포 실패, 네트워크 오류 |
| `document_invalid` | 닫힌 스키마의 모르는 키, 필수 키, 버전·world·autorun 값 |
| `document_too_large` | manifest가 512 KiB 초과 |
| `incompatible_runtime` | Chrome ≥ 138, runtime floor ≤ 1인지 |
| `artifact_unavailable` | manifest와 같은 디렉터리의 `assets/<hex>.js` 가 200인지 |
| `artifact_invalid` | UTF-8 바이트 수와 SHA-256, 256 KiB 상한 |
| `artifact_forbidden` | `eval`, `new Function`, 동적 `import`, WebAssembly 컴파일, script 삽입 |

## 6. 자주 보는 실행 오류

| 코드 | 확인할 것 |
|---|---|
| `script_not_installed` | 요청한 id가 설치 목록에 없음 |
| `script_disabled` | 설정 목록에서 Enable |
| `version_mismatch` | update 후 페이지 새로고침 |
| `command_undeclared` | manifest command 이름과 `AXSDK.register` 키가 같은가 |
| `arguments_invalid` | 필수 인자, 타입, 예상 밖 키; 인자는 최대 32 KiB |
| `effect_not_approved` | 현재 설치가 그 effect를 승인했는가; update를 다시 승인 |
| `consent_unavailable` | 외부 전송/장바구니 명령이 manifest에서 confirmation을 선언하지 않음 |
| `consent_denied` | 사용자가 호출별 동의를 거절함 |
| `no_connected_document` | matches, Enable, 페이지 새로고침 |
| `document_changed` | 동의 중 페이지가 이동함; 새 페이지에서 다시 요청 |
| `timeout` | 명령이 15초 안에 끝나는가; 긴 일을 한 번에 하지 말 것 |
| `output_too_large` | JSON 결과가 128 KiB 초과; 필요한 scalar만 반환 |
| `script_error` | 명령에서 예외; 안전한 diagnose 결과로 좁힐 것 |

## 7. 네트워크 디버깅

`AXSDK.net.fetch` 는 브라우저 `Response`가 아니라 `{ status, body }` 를 반환합니다.

```js
const answer = await AXSDK.net.fetch('https://api.example.com/health');
return { status: answer.status, body: answer.body.slice(0, 200) };
```

규칙:

- HTTPS, 기본 포트만
- GET 또는 POST만
- 쿠키·인증정보를 보내지 않음 (`credentials: 'omit'`)
- `cookie`, `authorization`, `host`, `origin`, `referer` 계열 헤더 거부
- 요청 body와 응답 body 각각 최대 128 KiB
- 매니페스트 선언 **그리고** 설치 시 호스트 승인 둘 다 필요

| 코드 | 뜻 |
|---|---|
| `net_host_undeclared` | `network.hosts` 에 없음 |
| `net_host_not_approved` | 선언했지만 Chrome host 권한 승인이 없음 |
| `net_url_invalid` | HTTP, 포트, URL 내 credentials 등 |
| `net_request_invalid` | 메서드·헤더·body 규칙 위반 |
| `net_too_large` | 응답 상한 초과 |
| `net_failed` | 실제 fetch/응답 읽기 실패 |

[→ GitHub Pages에 배포하기](hosting.html)
