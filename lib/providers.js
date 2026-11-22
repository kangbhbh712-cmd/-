// 세 AI 제공자(Anthropic, OpenAI, Google)의 스트리밍 호출을 같은 모양으로 감싼다.
// 각 stream 함수는 { text } 또는 { notice } 객체를 차례로 내보내는 async generator다.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODELS = {
  claude: 'claude-opus-5-5',
  gpt: 'gpt-6.2-astra',
  gemini: 'gemini-4-carbon',
};

// 화면의 모델 입력칸에 보여 줄 추천 목록 (직접 입력도 가능)
const MODEL_SUGGESTIONS = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
  gpt: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-luna'],
  gemini: ['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen', 'gemini-3.1-pro-preview', 'gemini-3.8-flash'],
};

export const isMockMode = () => /^(1|true|yes)$/i.test(process.env.MOCK_MODE ?? '');

function defaultModel(id) {
  const env = { claude: 'CLAUDE_MODEL', gpt: 'OPENAI_MODEL', gemini: 'GEMINI_MODEL' }[id];
  return process.env[env]?.trim() || DEFAULT_MODELS[id];
}

function hasKey(id) {
  if (id === 'claude') return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (id === 'gpt') return Boolean(process.env.OPENAI_API_KEY);
  if (id === 'gemini') return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return false;
}

export function providerInfo() {
  return ['claude', 'gpt', 'gemini'].map((id) => ({
    id,
    model: defaultModel(id),
    suggestions: MODEL_SUGGESTIONS[id],
    available: isMockMode() || hasKey(id),
  }));
}

// ---- 클라이언트 (처음 쓸 때 한 번만 만든다) ----
const clients = {};
const anthropic = () => (clients.anthropic ??= new Anthropic());
const openai = () => (clients.openai ??= new OpenAI());
const gemini = () =>
  (clients.gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY }));

// ---- Claude ----
async function* streamClaude({ system, user, model, signal }) {
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: process.env.CLAUDE_EFFORT?.trim() || 'medium' },
  };
  // 안전 분류기가 응답을 거절하면 서버 쪽에서 다른 모델로 이어서 답하게 한다.
  if (!/^(0|false|no|off)$/i.test(process.env.CLAUDE_REFUSAL_FALLBACK ?? '')) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  const stream = anthropic().beta.messages.stream(params, { signal });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { text: event.delta.text };
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') yield { notice: 'Claude가 이 요청에 대한 답변을 거절했습니다.' };
  else if (final.stop_reason === 'max_tokens') yield { notice: '최대 출력 길이에 도달해 발언이 잘렸습니다.' };
}

// ---- GPT (OpenAI Responses API) ----
async function* streamGPT({ system, user, model, signal }) {
  const params = { model, instructions: system, input: user, stream: true };
  const effort = process.env.OPENAI_REASONING_EFFORT?.trim();
  if (effort) params.reasoning = { effort };

  const stream = await openai().responses.create(params, { signal });
  for await (const event of stream) {
    switch (event.type) {
      case 'response.output_text.delta':
        yield { text: event.delta };
        break;
      case 'response.refusal.delta':
        yield { text: event.delta };
        break;
      case 'response.incomplete':
        yield { notice: `응답이 중간에 끝났습니다 (${event.response?.incomplete_details?.reason ?? '이유 불명'}).` };
        break;
      case 'response.failed':
        throw new Error(event.response?.error?.message ?? 'OpenAI 응답 생성에 실패했습니다.');
      case 'error':
        throw new Error(event.message ?? 'OpenAI 스트림 오류');
    }
  }
}

// ---- Gemini ----
async function* streamGemini({ system, user, model, signal }) {
  const stream = await gemini().models.generateContentStream({
    model,
    contents: user,
    config: { systemInstruction: system, abortSignal: signal },
  });
  let finishReason;
  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) {
      throw new Error(`Gemini가 요청을 차단했습니다 (${chunk.promptFeedback.blockReason}).`);
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text && !part.thought) yield { text: part.text };
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
  }
  if (finishReason === 'MAX_TOKENS') yield { notice: '최대 출력 길이에 도달해 발언이 잘렸습니다.' };
  else if (finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finishReason)) {
    yield { notice: `Gemini 응답이 중단되었습니다 (${finishReason}).` };
  }
}

// ---- 데모 모드: API 키 없이 화면을 시험해 볼 수 있는 가짜 응답 ----
const MOCK_LINES = {
  claude: [
    '저는 이 문제를 조금 더 신중하게 보고 싶습니다.',
    '앞의 주장에는 동의하는 부분도 있지만, 근거가 한 가지 사례에 기대고 있다는 점이 걸립니다.',
    '장기적인 영향까지 고려하면 결론이 달라질 수 있습니다.',
  ],
  gpt: [
    '실용적인 관점에서 보면 답은 비교적 분명합니다.',
    '비용과 효과를 따져 보면 지금 바로 실행할 수 있는 방안이 있습니다.',
    '다만 앞선 지적처럼 예외 상황에 대한 대비책은 필요합니다.',
  ],
  gemini: [
    '데이터를 보면 조금 다른 그림이 나옵니다.',
    '여러 지역의 사례를 비교하면 공통된 패턴과 중요한 차이가 함께 보입니다.',
    '그래서 저는 두 입장을 절충한 단계적 접근을 제안합니다.',
  ],
};

async function* streamMock({ speaker, user, signal }) {
  const lastSpeaker = [...user.matchAll(/^\[(Claude|GPT|Gemini|사회자\(사용자\))\]$/gm)].pop()?.[1];
  const opener = lastSpeaker ? `${lastSpeaker}의 말을 잘 들었습니다. ` : '';
  const isSummary = user.includes('위 토론을 다음 순서로 정리하세요');
  const text = isSummary
    ? '**핵심 쟁점** — (데모) 실행 속도와 신중함 사이의 균형이 쟁점이었습니다.\n\n**참여자별 핵심 주장**\n- Claude: 장기적 영향을 따지자\n- GPT: 지금 실행 가능한 방안부터\n- Gemini: 데이터에 기반한 단계적 접근\n\n**종합 평가** — 데모 모드이므로 실제 평가는 아닙니다.'
    : `${opener}${MOCK_LINES[speaker].join(' ')} (데모 모드 응답입니다. .env에 API 키를 넣으면 실제 AI가 답합니다.)`;

  for (const token of text.split(/(?<=\s)/)) {
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, 35));
    yield { text: token };
  }
}

const STREAMERS = { claude: streamClaude, gpt: streamGPT, gemini: streamGemini };

export function streamReply({ speaker, model, system, user, signal }) {
  if (isMockMode()) return streamMock({ speaker, user, signal });
  if (!hasKey(speaker)) {
    throw new Error(`${speaker} API 키가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }
  return STREAMERS[speaker]({ system, user, model: model || defaultModel(speaker), signal });
}

/** 제공자 SDK의 오류를 사용자에게 보여 줄 한국어 메시지로 바꾼다. */
export function describeError(err, { speaker, model }) {
  let raw = err?.error?.error?.message || err?.error?.message || err?.message || String(err);
  // Gemini SDK는 오류 본문 JSON을 문자열로 겹겹이 감싸서 주므로 안쪽 message까지 풀어 본다.
  for (let i = 0; i < 3; i++) {
    try {
      const inner = JSON.parse(raw)?.error?.message;
      if (typeof inner !== 'string') break;
      raw = inner;
    } catch {
      break;
    }
  }
  raw = raw.trim().slice(0, 400);
  let status = err?.status ?? err?.code;
  if (/API key not valid|API_KEY_INVALID/i.test(raw)) status = 401;
  const name = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini' }[speaker] ?? speaker;
  switch (status) {
    case 400:
      return `${name}: 잘못된 요청입니다 — ${raw}`;
    case 401:
    case 403:
      return `${name}: API 키가 올바르지 않거나 권한이 없습니다. (${raw})`;
    case 404:
      return `${name}: 모델 "${model}"을(를) 찾을 수 없습니다. 모델 이름을 확인하세요. (${raw})`;
    case 429:
      return `${name}: 요청 한도를 넘었거나 크레딧이 부족합니다. 잠시 후 다시 시도하세요. (${raw})`;
    default:
      if (typeof status === 'number' && status >= 500) return `${name}: 서버 오류(${status})입니다. 잠시 후 다시 시도하세요.`;
      return `${name}: ${raw}`;
  }
}
