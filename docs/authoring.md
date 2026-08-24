---
layout: default
title: 스크립트 저작하기
---

[← 처음으로](index.html)

# 스크립트 저작하기

릴리스 하나는 파일 **두 개**입니다.

```
my-script/1.0.0/
  manifest.json                 ← 선언
  assets/<sha256>.js            ← 코드. 파일명이 그 코드의 SHA-256
```

**아티팩트는 매니페스트 기준 상대 경로로 찾습니다.** 그래서 릴리스는 아무 디렉터리에 놓아도
자기 완결적입니다 — 설치할 사람은 `manifest.json` URL 하나만 알면 됩니다.

---

## 1. 스크립트

`AXSDK.register({ commands })` 를 한 번 호출합니다. 각 명령은 이름 붙은 함수입니다.

```js
AXSDK.register({
  commands: {
    read_heading: async () => ({
      heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    }),

    remember: async (input) => {
      await AXSDK.storage.set('note', input.note);
      return { stored: true };
    },

    recall: async () => ({
      note: await AXSDK.storage.get('note'),
      keys: await AXSDK.storage.list(),
    }),
  },
});
```

### 쓸 수 있는 API

전역 `AXSDK` 는 **freeze되어 있고 이 세 가지뿐**입니다.

| | |
|---|---|
| `AXSDK.register({ commands })` | 한 번만. 두 번 부르면 예외 |
| `AXSDK.storage.get/set/delete/list` | 확장 쪽 저장소. **스크립트당 64 KiB** |
| `AXSDK.net.fetch(url, init?)` | 매니페스트가 선언하고 사용자가 승인한 호스트만 |

명령 함수는 두 번째 인자로 현재 실행 컨텍스트를 받습니다.

```js
inspect: async (input, context) => ({
  url: context.url,
  scriptId: context.scriptId,
  version: context.version,
})
```

`AXSDK.net.fetch` 의 결과는 브라우저 `Response`가 아니라 `{ status, body }` 입니다. 자세한 제한은
[디버깅 안내](debugging.html)에 있습니다.

`document` 를 포함한 페이지 DOM은 그대로 쓸 수 있습니다. 스크립트는 격리된 world에서 돕니다.

**`AXSDK.storage` 는 페이지의 것이 아닙니다.** 확장 쪽에 있으므로 네비게이션을 넘겨 살아남고,
사이트가 `localStorage` 처럼 읽거나 지울 수 없습니다.

**핸드셰이크 전 호출은 큐에 쌓이지 않고 거부됩니다.** 저장했다고 믿는 스크립트가 저장하지 못한
것보다, 못 했다고 듣는 편이 낫기 때문입니다.

### 쓸 수 없는 것

설치 시점에 **거부되는** 구문들입니다. 코드를 더 받아오는 스크립트가 있으면 다른 모든 검사가
무의미해집니다.

```
eval(…)              new Function(…)        import(…)
WebAssembly.compile  WebAssembly.instantiate
document.createElement('script')            <script …>
```

---

## 2. 매니페스트

```json
{
  "schemaVersion": 1,
  "script": {
    "id": "example.reader",
    "name": "Example Reader",
    "summary": "무엇을 하는 스크립트인지 한 줄.",
    "version": "1.0.0",
    "publisherId": "your-handle",
    "sourceUrl": "https://github.com/you/your-repo",
    "license": "MIT"
  },
  "execution": {
    "matches": ["https://example.com/*"],
    "runAt": "document_idle",
    "world": "USER_SCRIPT",
    "autorun": false,
    "minimumChromeVersion": 138,
    "minimumRuntimeVersion": 1
  },
  "artifact": {
    "ref": "sha256:<64자리 소문자 hex>",
    "bytes": 1234,
    "mediaType": "application/javascript"
  },
  "commands": [
    {
      "name": "read_title",
      "description": "사용자가 읽을 설명. 요약 화면에 그대로 나옵니다.",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
      "effect": "read",
      "requiresUserConfirmation": false
    }
  ],
  "disclosures": {
    "pageData": ["읽는 것"],
    "localStorage": [],
    "backendData": [],
    "modelData": ["AXSDK 에이전트가 호출했을 때의 명령 결과"]
  },
  "release": { "publishedAt": "2026-01-01T00:00:00.000Z", "changelog": "첫 릴리스." },
  "review": { "status": "approved", "reviewerId": "your-handle", "reviewedAt": "2026-01-01T00:00:00.000Z" }
}
```

**스키마는 닫혀 있습니다.** 모르는 키가 하나라도 있으면 설치가 거부됩니다 — 무시하지 않습니다.

`review.status: "approved"` 와 `reviewerId` 는 UI에 표시되는 **자기 선언 메타데이터**입니다. URL 설치
경로는 서명을 확인하지 않으므로 검수자 신원을 인증하지 않습니다. `sourceUrl` 과 실제 공개 소스를
확인할 수 있게 적어야 합니다.

### `inputSchema` — 지원하는 부분만

루트는 항상 `{ \"type\": \"object\", \"properties\": {…}, \"additionalProperties\": false }` 입니다.
속성은 `string`, `number`, `boolean`, 이 타입의 `array`, 또는 `null`을 더한 nullable 타입을
지원합니다. 중첩 object나 구현하지 않은 JSON Schema 키에 의존하지 않습니다. 예상 밖 인자는
버리지 않고 거부하며, 전체 인자 상한은 32 KiB입니다.

### `effect` — 네 가지뿐

| | 뜻 |
|---|---|
| `read` | 읽기. 인자가 없으면 사전 실행 대상이 됩니다 |
| `page_write` | 페이지를 바꿈 |
| `external_send` | 외부로 보냄 |
| `cart_mutation` | 장바구니 등 상태 변경 |

`external_send` 와 `cart_mutation` 은 `requiresUserConfirmation: true` 가 필수이고, **호출할 때마다**
별도 동의를 받습니다. `read` 와 `page_write` 에는 이 추가 동의 규칙이 적용되지 않습니다.

### `network` — 선언한 호스트만

```json
"network": { "hosts": ["api.example.com", "*.cdn.example.com"] }
```

없으면 `AXSDK.net.fetch` 는 전부 거부됩니다. **이 블록이 있으면 그 릴리스의 읽기는 사전 실행에서
제외됩니다** — 요청하지 않은 턴이 외부로 나가지 않게 하기 위해서입니다.

### `matches`

Chrome 매치 패턴입니다. 호스트에 포트를 쓸 수 없고, 포트는 무시됩니다 — `http://127.0.0.1/x*` 는
`http://127.0.0.1:57310/x` 에 매칭됩니다.

---

## 3. 파일 배치

아티팩트 파일명은 **그 파일 내용의 SHA-256** 이고, 매니페스트가 같은 값을 선언해야 합니다.

```bash
# index.js의 다이제스트를 계산하고 content-addressed 파일을 만듭니다.
node -e "
const fs=require('node:fs'), c=require('node:crypto');
const b=fs.readFileSync('index.js');
const hex=c.createHash('sha256').update(b).digest('hex');
fs.mkdirSync('assets',{recursive:true});
fs.copyFileSync('index.js','assets/'+hex+'.js');
console.log(JSON.stringify({
  ref:'sha256:'+hex,
  bytes:b.length,
  mediaType:'application/javascript'
},null,2));
"
```

그 값을 매니페스트에 넣습니다.

```json
"artifact": { "ref": "sha256:<hex>", "bytes": <바이트 수>, "mediaType": "application/javascript" }
```

최종 배치:

```
my-script/1.0.0/manifest.json
my-script/1.0.0/assets/<hex>.js
```

설치할 사람에게 주는 URL은 `…/my-script/1.0.0/manifest.json` 입니다.

> 설치용 매니페스트에는 `artifact` 가 필요하고 **`artifactPath` 는 허용되지 않습니다.**
> 이 저장소의 fixture 원본에 보이는 `artifactPath: "index.js"` 는 전용 릴리스 컴파일러의 입력 형식일
> 뿐입니다. URL로 배포할 파일에 복사하면 닫힌 스키마 검사가 거부합니다.

## 4. 버전 올리기

`script.version` 을 올리고 새 디렉터리에 배치합니다. 같은 `script.id` 의 새 버전을 설치하면
갱신되고, **이전에 켜져 있었다면 켜진 상태가 유지됩니다.** 처음 설치는 항상 꺼진 상태입니다.

[→ 개발과 디버깅](debugging.html) · [→ 배포하기](hosting.html)
