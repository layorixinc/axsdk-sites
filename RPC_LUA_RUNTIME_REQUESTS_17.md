# RPC Lua 런타임 요청 17 — 원문 사용자 메시지를 노드에 노출, `beforeIntent` 훅이 memory 전용 턴을 멈춤

날짜: 2026-08-16 · 대상: agentv3 runtime · 작성: axsdk-sites
근거: 라이브 실측. 저장된 common flows 레이어 221,620 B(로컬 파일과 바이트 일치), `fromRemote: 0`.
관련: 요청 15/16(런타임 도구는 `parameters.properties`로 투영된다 — 이 문서의 R17-1이 그 규칙의 결과입니다)

**요청 2건**: R17-1(노출), R17-2(훅 결함 조사).

---

## 0. 배경 — 왜 이 두 건이 필요한지

사용자가 한 메시지에 **작업과 기억 요청을 함께** 담는 경우가 실패합니다.

```
"샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘."
```

플래너는 이 메시지를 분할하면서 **뒤에 오는 기억 절을 버립니다.** 실측:

| 표현 | memory intent | 저장 |
|---|---|---|
`견적 줘. 전화번호 기억해줘.` | 없음 (3/3) | 안 됨 |
`견적 줘. **그리고** 전화번호 기억해줘.` | 없음 | 안 됨 |
`**전화번호 기억해줘.** 그리고 견적 줘.` | **있음** | **됨** |

그 이전 단계에서는 memory intent가 나오긴 했지만 **값이 삭제된 상태**로 도착했습니다:

```
originalUserText: "샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘."
plannedUserText : "전화번호 기억해줘"        ← 번호가 없음
```

값이 없으므로 `plan_memory`는 필수 `operation`(6값 enum)에 맞는 답을 만들 수 없어 enum 밖 값을 냈고,
인자가 스크립트 전에 거부되어 사용자에게 `stage: tool_args`가 노출됐습니다. (이 마지막 증상은 우리 쪽
프롬프트에 "값이 없으면 `next="error"`, `operation="set"`"을 추가해 해결했습니다 — 라이브 확인.)

**프롬프트로는 고치지 못했습니다.** 세 가지 표현(값을 담은 예시 / 명시적 ALWAYS 규칙 / 순서 편향을
직접 명시한 규칙)을 시도했고 하나도 움직이지 않았으며, 첫 번째는 기존 규칙("연락처는 견적
requestText에 남고 자동 저장되지 않는다")과 충돌해 **오히려 memory intent를 완전히 없앴습니다.**
모델을 탓하기 전에 전달을 검증했습니다: 저장된 flows 레이어는 새 규칙이 든 로컬 파일과 **바이트 일치**.

그래서 두 갈래로 갔고, 둘 다 런타임 쪽 사실에 막혔습니다.

---

## R17-1 — 노드가 원문 사용자 메시지를 볼 수 있게 노출해 주십시오

### 관측

매 턴 실행되는 우리 런타임 도구(`detect_cancellation`, `parameters.properties`에 `requestText`만 선언)에
비파괴 프로브를 넣어 인자 키를 전부 출력했습니다.

```
keys=requestText   original=nil   planned=nil   userText=nil
```

`originalUserText` / `plannedUserText` / `userText` / `messageSource`는 **도구 파트의 기록 envelope에는
존재합니다**(우리가 chat store 덤프에서 직접 읽었습니다). 그러나 스크립트의 `args`에는 없습니다.

이는 요청 16에서 확인해 주신 규칙의 정확한 결과이며 **결함이 아닙니다**: 런타임 도구는
`parameters.properties`로 투영되고, 선언되지 않은 상태는 투영에서 제외됩니다.

### 요청

**원문 사용자 메시지를 노드가 얻을 수 있는 경로를 하나 열어 주십시오.** 형태는 둘 중 어느 쪽이든
저희에게 동등합니다.

1. `inputSelector`가 선택할 수 있는 상태 필드 (예: `originalUserText`), 또는
2. 엔진이 채우는 **선언 가능한** 도구 property — 즉 `parameters.properties`에
   `originalUserText: { type: string }`을 선언하면 엔진이 넣어 주는 방식.

값은 **이미 존재합니다**(도구 호출 envelope에 있음). 새 데이터가 아니라 **노출**입니다.

### 왜 필요한가

플래너가 값을 지운 채 memory intent를 내는 경로가 남아 있는 한, 그 절이 도달한 노드가 원문에서 값을
복구할 수 있어야 합니다. 지금은 우리 문서 안에 그 방법이 없습니다 — 모델 노드도 같은 상태
(`inputSelector: [requestText]` = 플래너의 세그먼트)를 봅니다.

### 우선순위

**중간.** R17-2가 해결되면 우회로가 생기므로 차단 요인은 아닙니다. 다만 잘린-값 경로의 방어로는
이것이 정확한 도구입니다.

---

## R17-2 — `beforeIntent` 훅을 등록하면 memory 전용 턴이 아무 도구도 실행하지 않고 멈춥니다

### 관측 (여기가 차단 요인입니다)

`FLOWS.md` §13.1의 훅은 저희 문제에 정확히 맞는 기계장치입니다 — 결정적이고, 매 라우팅 턴에 돌며,
런타임이 **원문 메시지를 주입**합니다. 실측으로 확인했습니다:

```
keys=targetIntent,userMessages
userMessages: table #=1
  first=샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘.
targetIntent=request_service_quote
```

- `userMessages`는 **문자열 배열**이고 원문이 그대로 옵니다(선언은
  `{ type: array, items: { type: string } }`. `type: [array, object, string, "null"]`은
  `expected record, received array`로 거부되고, `items: { type: object }`는
  `userMessages.0: expected object, received string`으로 거부됩니다 — 문서에 한 줄 있으면 좋겠습니다).
- 훅은 trace **첫 자리**에서 실행됩니다(대상 flow의 `detect_cancellation`보다 먼저).

혼합 케이스는 **동작했습니다**:

```
capture_memory_clause  {"next":"save","memory":{"phone":"415-555-0199"},"confirmed":true}
write_captured_memory  {"next":"report"}
memory (비운 상태에서 시작) → {"g/phone":"415-555-0199"}      ← 2/2
```

**그런데 memory 전용 턴이 멈춥니다:**

```
send: "내 이메일 hong@test.com 기억해줘."
elapsed 200.0s · memory {} · 실행된 도구 0개
진단: "The turn ran no tool call at all — the send was accepted but the message never reached the chat store"
```

훅 등록 상태에서 전체 memory 스위트가 **6/10 → 2/10**, 소요 **23분**(멈춘 턴들이 각자 바운드를 태움).
훅을 제거하면 즉시 6/10으로 복귀합니다.

### 배제한 것

- **`consent: required`** — 훅에는 물어볼 사용자가 없으니 이것이라 의심해 제거했습니다. **변화 없음**
  (여전히 120초 무실행).
- **전달 문제 아님** — 같은 훅이 혼합 케이스에서는 정상 실행되고 저장까지 완료합니다.
- **컴파일 오류 아님** — `check:flows` 137/0, 문서가 로드되고 다른 flow는 정상.

### 우리 쪽 훅 구성(재현용 최소형)

```yaml
hooks:
  beforeIntent: [ record_memory ]

flows:
  record_memory:
    state: { userMessages: null, memory: null, confirmed: null }
    nodes:
      capture:                       # kind: action_contract, runtime lua, 순수 계산
        inputSelector: [ userMessages ]
        next: { save: write, skip: done }
      write:                         # kind: action_contract, runtime lua, rpc.allow [memory.set_bulk]
        inputSelector: [ memory, confirmed ]
        next: { report: done, error: done }
      done:                          # respond 없는 terminal
        kind: terminal
        inputSelector: []
```

### 질문

1. **훅 flow가 대상 intent와 같은 도메인을 건드리면(여기서는 둘 다 memory 쓰기) 금지되는 조합입니까?**
   그렇다면 문서에 명시해 주시면 저희가 설계를 바꿉니다.
2. `targetIntent == memory`일 때 훅과 대상 flow가 같은 op(`memory.set_bulk`)를 쓰는 것이 문제입니까?
3. "the message never reached the chat store"는 엔진이 턴을 기록하기 전에 실패했음을 뜻합니다 —
   훅 단계의 실패가 턴 자체를 삼킬 수 있는 경로가 있습니까? §13.1은 "A hook error never blocks the
   target flow (fire-and-continue)"라고 명시합니다.

### 우선순위

**높음.** 이것이 유일한 차단 요인입니다. 훅이 memory 전용 턴을 멈추지 않는다면 저희는 플랫폼 변경
없이 이 문제를 끝낼 수 있습니다 — 추출기는 이미 작성되어 오프라인 테스트 16개와 변이 검사를
통과했고(`AX_RPC_MEMORY.capture`), 혼합 케이스는 라이브에서 저장까지 확인했습니다.

---

## 현재 상태

- 훅 배선은 **되돌렸습니다**(회귀를 출하하지 않기 위해). 추출기와 테스트는 커밋되어 있고 어떤 flow도
  아직 호출하지 않습니다.
- memory 스위트 **6/10** — A/C/D가 위 원인으로 실패, B/E/F/G는 통과.
- 게이트: `test:lua` 525 · `check:flows` 137 · `test:playground` 80 · `test:scenarios` 77 ·
  `check:bundle` · `dead:lua` alive 39/dead 0.
- 우리 쪽에서 이번에 고친 것: 값 없는 저장이 enum 밖 `operation` 대신 `next="error"`로 정직하게
  실패하도록 프롬프트 수정(라이브 확인).
