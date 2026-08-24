---
layout: default
title: GitHub Pages로 배포하기
---

[← 처음으로](index.html)

# GitHub Pages로 배포하기

GitHub Pages 하나로 **매뉴얼과 설치 가능한 스크립트 파일을 함께** 제공할 수 있습니다. 서버 코드,
데이터베이스, 서명 키, npm 배포는 필요 없습니다. 필요한 것은 다음입니다.

- 공개 GitHub 저장소
- `docs/` 디렉터리의 Markdown/정적 파일
- 저장소 관리자 권한으로 Pages를 한 번 켜기
- 설치용 manifest와 content-addressed JS 파일
- HTTPS로 열린 Pages URL

## 1. 저장소 구조

이 저장소는 이미 아래의 매뉴얼 파일을 갖고 있습니다.

```text
docs/
  _config.yml
  index.md
  using.md
  authoring.md
  debugging.md
  hosting.md
```

스크립트도 같은 Pages에 두려면 릴리스별로 추가합니다.

```text
docs/
  scripts/
    example.reader/
      1.0.0/
        manifest.json
        assets/
          <sha256>.js
```

`docs/scripts/...` 는 저장소 경로이고, 공개 URL에서는 `docs` 가 빠집니다.

```text
https://<owner>.github.io/<repo>/scripts/example.reader/1.0.0/manifest.json
```

이 저장소를 그대로 켜면 예상 URL은:

```text
매뉴얼: https://layorixinc.github.io/axsdk-sites/
manifest: https://layorixinc.github.io/axsdk-sites/scripts/<script-id>/<version>/manifest.json
```

## 2. GitHub에서 Pages 한 번 켜기

저장소에서:

1. **Settings**
2. 왼쪽 **Pages**
3. **Build and deployment → Source: Deploy from a branch**
4. Branch **main**, Folder **/docs**
5. **Save**

별도 workflow가 필요하지 않습니다. GitHub도 빌드 제어가 필요 없을 때는 branch source를 권장하고,
source folder로 `/docs` 를 지원합니다. 공식 문서:
[Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

이 설정은 저장소 관리자만 할 수 있고 **파일을 추가하는 것만으로 자동 활성화되지 않습니다.** 이후에는
`main` 의 `docs/` 변경을 push할 때마다 Pages가 다시 배포합니다. 실패하면 저장소의 **Actions** 에서
`pages build and deployment` 실행을 확인합니다.

## 3. 배포 확인

Pages URL에서 세 가지를 직접 엽니다.

```text
/
/scripts/example.reader/1.0.0/manifest.json
/scripts/example.reader/1.0.0/assets/<sha256>.js
```

확인 항목:

- 모두 HTTP 200
- Pages가 HTTPS로 열림
- manifest가 HTML 404 페이지가 아니라 JSON 본문
- asset이 JS 본문이고 바이트 수·SHA-256이 manifest와 일치
- manifest 안의 `sourceUrl` 이 실제 소스 저장소를 가리킴

GitHub Pages의 project site는 URL에 저장소 이름이 들어갑니다. `new URL('assets/…', manifestUrl)` 로
asset을 찾으므로, manifest 안에 `/axsdk-sites/` 를 하드코딩할 필요는 없습니다.

## 4. 문서만 공개하고 스크립트는 다른 곳에 둘 수도 있습니다

manifest와 asset은 같은 릴리스 디렉터리에 있으면 어디서든 됩니다.

- GitHub Pages: 권장. 정적·HTTPS·버전 경로가 단순함
- 다른 정적 호스팅: 가능. HTTPS와 원본 파일 URL이 필요함
- `raw.githubusercontent.com`: 파일은 열리지만 사용자가 읽을 랜딩 페이지와 릴리스 구조를 따로
  관리해야 하므로 Pages가 더 명확함

CORS 헤더는 이 설치 경로의 핵심 요건이 아닙니다. 확장 service worker가 host permission으로 읽고,
스크립트의 runtime network 권한과는 별개입니다.

## 5. 커스텀 도메인 — 선택 사항

없어도 됩니다. `https://<owner>.github.io/<repo>/` 가 이미 HTTPS입니다. 원한다면 Settings → Pages의
**Custom domain**에서 먼저 설정하고 DNS를 연결합니다. `CNAME` 파일만 넣는 것으로 설정이 끝나지는
않습니다. 공식 문서:
[Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

도메인을 바꾸면 사용자가 신뢰하는 출처 URL 자체가 바뀝니다. 기존 manifest URL을 오래 유지하거나,
새 URL을 별도 update로 안내합니다.

## 6. 릴리스 체크리스트

- [ ] `script.id` 는 이전 릴리스와 같고 `version` 은 올랐다
- [ ] `matches` 는 필요한 호스트만 담는다
- [ ] `network.hosts` 는 코드가 실제 호출하는 호스트만 담는다
- [ ] `external_send` / `cart_mutation` 은 `requiresUserConfirmation: true`
- [ ] disclosures와 description은 사용자가 판단할 만큼 구체적이다
- [ ] artifact가 256 KiB 이하이고 forbidden loader가 없다
- [ ] `assets/<sha256>.js`, `artifact.ref`, `artifact.bytes` 가 동일한 바이트를 가리킨다
- [ ] Pages의 manifest/asset URL을 새 창에서 직접 확인했다
- [ ] 실제 CWS 확장에서 Look it up → install/update → Enable → 페이지 새로고침 → 명령 실행을 확인했다
- [ ] 토큰·쿠키·개인정보·내부 URL을 저장소나 결과에 넣지 않았다

## 현재 이 저장소에서 사람이 해야 하는 마지막 일

파일은 이 변경으로 준비됩니다. 아직 파일 밖에서 필요한 일은 두 가지입니다.

1. 변경을 승인해 `main` 에 commit/push
2. GitHub 저장소 **Settings → Pages → main /docs** 를 Save

그 뒤에는 `https://layorixinc.github.io/axsdk-sites/` 가 매뉴얼 주소입니다.

[← 설치하고 확인하기](using.html) · [← 저작하기](authoring.html)
