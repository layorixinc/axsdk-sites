# 런타임 요청 21 — 모델의 harmony 래퍼가 사용자 답변으로 나갑니다

작성 2026-08-27 · SITES · 측정 환경: `browser-extension` revision 127, CDP 확장(패키지/스토어 모드 및
개발 오버레이 모드 양쪽), 모델은 `openai/gpt-oss-120b`.

## 한 문장

어시스턴트 메시지의 **텍스트 파트**에 모델의 채널 스캐폴딩이 그대로 실려 나옵니다 — 사용자가 답변과 함께
`<|channel|>commentary to=functions.<tool> <|constrain|>json<|message|>{…}` 를 읽습니다.

## 측정

두 개의 서로 다른 플로우, 두 개의 서로 다른 패키지에서 같은 모양이 나왔습니다.

**① 개발 오버레이 · 견적 수집 노드** (`npm run test:thumbtack:live`, 한 실행에서 `channel|` **52회**):

```
[house cleaning 94101 — collect] 11.1s
  tools: detect_cancellation(continue) -> recall_saved_contact(done)
         -> collect_request(collect) ×3 -> present_quote_collection(ask)
  reply: <|channel|>commentary to=functions.collect_quote_contact <|constrain|>json<|message|>
         { "next": "collect", "question": "이름, 성, 이메일, 전화번호를 알려주세요.",
           "submit_email": null, … } 이름, 성, 이메일, 전화번호를 알려주세요.
```

같은 실행의 다음 턴:

```
  reply: <|channel|>commentary to=functions.finish_quote_request <|constrain|>json<|message|>
         { "next": "done" } 죄송합니다. 브라우저 연결을 확인할 수 없어 결과를 가져올 수 없습니다.
```

즉 **정상 문장 앞에 래퍼가 붙습니다.** 도구는 정상적으로 실행되고 브랜치도 맞습니다 — 텍스트만 오염됩니다.

**② 스토어 패키지 · 앱 레이어 훅** (CWS 아티팩트 스모크, 사용자에게 나간 유일한 문장이었음):

```
refused "<|channel|>commentary to=functions.memory_record <|constrain|>json<|message|>
        { "intent": "site_intent_resolution", "next" …
```

이 경우는 우리 오버레이가 훅 플로우를 재정의해 앱 레이어의 모델 노드가 아예 돌지 않게 하여 우회했습니다
(그 후 같은 자리에서 정상 문장을 받았습니다). ①은 우회할 자리가 없습니다 — 우리 자신의 모델 노드입니다.

## 우리 문서 문제가 아님 (A/B로 확인)

플래너 프롬프트를 이번 주에 편집했으므로 그것이 원인인지 A/B를 돌렸습니다. 스캐폴딩 유출은 **모든 실행에서
동일하게** 나옵니다 — 편집 전 문서로 되돌린 실행에서도 한 실행에 52회입니다. (첫 측정 당시 우리 API 잔액이
소진되어 제공자가 거부하던 구간이 있었고, 그 구간의 스위트 점수는 철회했습니다. 유출 자체는 정상 상태에서도
재현됩니다.)
## 요청

사용자에게 가는 텍스트에서 채널 스캐폴딩을 제거해 주십시오. 우리가 볼 수 있는 지점에서 가능한 형태 셋 중
어느 것이든 됩니다:

1. 어시스턴트 텍스트 파트를 만들 때 harmony 마커(`<|channel|>`, `<|constrain|>`, `<|message|>`,
   `to=functions.…`)로 시작하는 구간을 잘라내고 **최종 채널의 내용만** 남긴다.
2. 모델이 도구 호출을 텍스트로 냈을 때는 **텍스트 파트를 만들지 않는다**(도구 호출로만 처리하거나, 파싱
   실패로 재시도한다).
3. 최소한, 파싱 실패 시 사용자에게는 중립적인 문장을 내고 원문은 디버그 이벤트로만 남긴다.

## 우리 쪽에서 한 것

- 공유 세션 드라이버가 매 턴에 `rawScaffolding`을 플래그합니다
  (`tools/harness/cdp-session.mjs`, `detectRawScaffolding` — 와이어 마커만 보고, 산문에 도구 이름이
  나오는 경우는 통과).
- CWS 아티팩트 스모크는 **어떤 턴이든** 답변에 스캐폴딩이 섞이면 실패합니다. 견적 라이브 스위트는 케이스별로
  실패 사유에 몇 건이 오염됐는지 적습니다.
- 스토어 패키지의 측정된 실행들에서는 오염이 관측되지 않았습니다(비교·정제·취소·카트·결제·거부 6턴).

## 참고

이 문서는 요청만 담습니다. 우리 쪽 재현 절차: `npm run test:thumbtack:live` (개발 오버레이) 또는
`npm run test:cws:artifact` (스토어 패키지)의 로그에서 `channel|`을 찾으면 됩니다.
