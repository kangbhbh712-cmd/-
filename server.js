// AI 라운드테이블 서버
// - public/ 의 정적 파일을 제공하고
// - POST /api/turn 으로 들어온 요청을 해당 AI에게 전달해 답변을 NDJSON으로 스트리밍한다.
// API 키는 서버에만 있고 브라우저로는 절대 보내지 않는다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTurnPrompt, buildSummaryPrompt, MODES } from './lib/prompts.js';
import { providerInfo, streamReply, describeError, isMockMode } from './lib/providers.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env 가 없으면 이미 설정된 환경 변수만 사용한다.
}

const PORT = Number(process.env.PORT) || 3000;
// 키가 들어 있는 서버이므로 기본적으로 내 컴퓨터에서만 접속 가능하게 둔다.
const HOST = process.env.HOST || '127.0.0.1';

const SPEAKERS = ['claude', 'gpt', 'gemini'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 브라우저에서 온 요청을 검사하고 필요한 값만 꺼낸다. */
function parseTurnRequest(body) {
  const speaker = body.speaker;
  if (!SPEAKERS.includes(speaker)) throw new Error('알 수 없는 참여자입니다.');

  const topic = str(body.topic, 4000).trim();
  if (!topic) throw new Error('토론 주제가 비어 있습니다.');

  const model = str(body.model, 100).trim();
  if (model && !/^[\w.\-:/@]+$/.test(model)) throw new Error('모델 이름 형식이 올바르지 않습니다.');

  const participants = (Array.isArray(body.participants) ? body.participants : [])
    .filter((p) => SPEAKERS.includes(p?.id))
    .map((p) => ({ id: p.id, stance: str(p.stance, 300) }));
  if (!participants.length) throw new Error('참여자가 없습니다.');

  const transcript = (Array.isArray(body.transcript) ? body.transcript : [])
    .slice(-400)
    .filter((m) => (SPEAKERS.includes(m?.speaker) || m?.speaker === 'user') && typeof m.text === 'string')
    .map((m) => ({ speaker: m.speaker, text: m.text.slice(0, 20000) }));

  const totalRounds = Math.min(Math.max(Number(body.totalRounds) || 1, 1), 50);
  const round = Math.min(Math.max(Number(body.round) || 1, 1), totalRounds);

  return {
    kind: body.kind === 'summary' ? 'summary' : 'turn',
    speaker,
    model,
    topic,
    mode: MODES[body.mode] ? body.mode : 'debate',
    length: ['short', 'medium', 'long'].includes(body.length) ? body.length : 'medium',
    participants,
    transcript,
    round,
    totalRounds,
  };
}

async function handleTurn(req, res) {
  let turn;
  try {
    turn = parseTurnRequest(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }

  const { system, user } = turn.kind === 'summary' ? buildSummaryPrompt(turn) : buildTurnPrompt(turn);

  // 브라우저가 연결을 끊으면(중단 버튼) AI 호출도 함께 취소한다.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    const stream = streamReply({ speaker: turn.speaker, model: turn.model, system, user, signal: abort.signal });
    for await (const piece of stream) {
      if (abort.signal.aborted) break;
      if (piece.text) send({ type: 'delta', text: piece.text });
      if (piece.notice) send({ type: 'notice', message: piece.notice });
    }
    if (!abort.signal.aborted) send({ type: 'done' });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error(`[${turn.speaker}]`, err?.status ?? '', err?.message ?? err);
      send({ type: 'error', message: describeError(err, turn) });
    }
  } finally {
    res.end();
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, '.' + relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      return sendJson(res, 200, { providers: providerInfo(), mock: isMockMode() });
    }
    if (req.method === 'POST' && req.url === '/api/turn') return await handleTurn(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했습니다.' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const ready = providerInfo()
    .map((p) => `${p.id}=${p.available ? p.model : '키 없음'}`)
    .join(', ');
  console.log(`AI 라운드테이블: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(isMockMode() ? '데모 모드(가짜 응답)로 실행 중입니다.' : `참여 가능: ${ready}`);
});
