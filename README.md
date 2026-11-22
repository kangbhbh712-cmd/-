# AI 라운드테이블

Claude, GPT, Gemini를 한 화면에 모아 **서로 토론하게 하는** 웹앱입니다.
주제를 던지면 세 AI가 차례로 발언하면서 앞사람의 주장에 동의하거나 반박하고, 마지막에 한 AI가 토론을 정리합니다.

## 기능

- **토론 방식 네 가지**: 자유 토론, 찬반 토론(입장 자동 배정), 브레인스토밍, 합의 도출
- **참여자 설정**: 누가 참여할지, 발언 순서, 모델, 입장/역할(예: "회의론자", "경제학자")을 정할 수 있습니다
- **실시간 스트리밍**: 각 AI의 답변이 써지는 대로 보입니다
- **사회자 개입**: 토론 중에 입력창으로 질문하거나 방향을 바꾸면, 다음 발언자부터 그 말을 듣고 반응합니다
- **진행 제어**: 일시정지·계속, 중단, 이어서 진행, 한 라운드 더
- **토론 정리**: 지정한 AI가 핵심 쟁점·합의점·남은 이견·종합 평가를 정리합니다
- **기록 저장**: 토론 전체를 마크다운(.md) 파일로 내려받습니다
- **오류 처리**: 한 AI가 실패하면 토론이 멈추고 "다시 시도"나 "건너뛰기"를 고를 수 있습니다

## 준비물

- [Node.js](https://nodejs.org) 20.12 이상
- API 키 (최소 두 개)
  - Claude: https://console.anthropic.com/settings/keys
  - GPT: https://platform.openai.com/api-keys
  - Gemini: https://aistudio.google.com/apikey

## 실행 방법

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
# .env 파일을 열어 가지고 있는 API 키를 붙여 넣기
npm start
```

브라우저에서 http://localhost:3000 을 엽니다.

API 키 없이 화면만 먼저 보고 싶다면 `npm run demo`로 실행하세요. 가짜 응답으로 동작합니다.

## 기본 모델

| 참여자 | 기본 모델 | 바꾸는 방법 |
|---|---|---|
| Claude | `claude-opus-5-5` | `.env`의 `CLAUDE_MODEL` 또는 화면의 모델 입력칸 |
| GPT | `gpt-6.2-astra` | `.env`의 `OPENAI_MODEL` 또는 화면의 모델 입력칸 |
| Gemini | `gemini-4-carbon` | `.env`의 `GEMINI_MODEL` 또는 화면의 모델 입력칸 |

모델 입력칸을 누르면 추천 모델 목록이 나오고, 다른 이름을 직접 입력해도 됩니다.
비용을 아끼려면 `claude-sonnet-5-5`, `gpt-6-luna`, `gemini-3.8-flash`처럼 가벼운 모델을 고르세요.
"모델을 찾을 수 없습니다" 오류가 나면 해당 회사의 모델 목록에서 정확한 이름을 확인해 바꾸면 됩니다.

## 동작 방식

```
브라우저 (public/)                 서버 (server.js)                     AI
─────────────────                  ─────────────────                   ──────
발언 순서·라운드 관리   ── POST /api/turn ──▶  프롬프트 구성 (lib/prompts.js)
사회자 메시지 끼워 넣기                      공급자 호출 (lib/providers.js) ──▶ Claude / GPT / Gemini
화면에 스트리밍 표시   ◀── NDJSON 스트림 ───  답변을 조각조각 전달          ◀──
```

- 매 차례마다 지금까지의 **토론 기록 전체**와 "이제 ○○의 차례"라는 안내를 해당 AI에게 보냅니다. 그래서 각 AI는 다른 AI의 발언을 모두 보고 반응합니다.
- API 키는 서버(`.env`)에만 있고 브라우저로 보내지 않습니다. 서버는 기본적으로 내 컴퓨터(`127.0.0.1`)에서만 접속할 수 있습니다.
- Claude 호출에는 안전 분류기가 답변을 거절했을 때 서버 쪽 대체 모델이 이어서 답하는 옵션(`fallbacks: "default"`)이 켜져 있습니다. 끄려면 `.env`에 `CLAUDE_REFUSAL_FALLBACK=false`를 넣으세요.

## 비용 안내

한 차례 발언할 때마다 그때까지의 토론 기록 전체가 입력으로 들어가므로, 라운드가 늘어날수록 한 번의 호출에 드는 토큰도 늘어납니다.
3명 × 3라운드 토론이면 발언 9번과 정리 1번, 총 10번 호출합니다. 처음에는 라운드를 적게, 발언 길이를 "짧게"로 두고 시작해 보세요.

## 파일 구성

```
server.js           HTTP 서버, 정적 파일 제공, /api/turn 스트리밍
lib/prompts.js      토론 방식별 프롬프트와 정리용 프롬프트
lib/providers.js    Claude·GPT·Gemini SDK 호출과 오류 메시지 변환, 데모 모드
public/index.html   화면
public/app.js       토론 진행 로직(순서, 라운드, 일시정지, 사회자 개입, 저장)
public/style.css    스타일 (다크 모드 지원)
```
