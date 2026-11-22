// AI 라운드테이블 — 브라우저 쪽 진행 로직
// 발언 순서·라운드·일시정지·사회자 개입은 모두 여기서 관리하고,
// 서버(/api/turn)에는 "이 기록을 보고 누가 말할 차례인지"만 보낸다.

const NAMES = { claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', user: '사회자' };
const INITIALS = { claude: 'C', gpt: 'G', gemini: 'Ge', user: '나' };
const MODE_HINTS = {
  debate: '각자 관점을 펼치고 서로의 주장을 비판적으로 검토합니다.',
  procon: '참여자마다 찬성·반대 입장을 정해 끝까지 대변합니다.',
  brainstorm: '서로의 아이디어를 이어받아 발전시킵니다.',
  consensus: '이견을 좁혀 모두가 받아들일 결론을 만들어 갑니다.',
};
const MODE_LABELS = { debate: '자유 토론', procon: '찬반 토론', brainstorm: '브레인스토밍', consensus: '합의 도출' };
const PROCON_STANCES = ['찬성', '반대', '중립 — 양쪽 주장의 허점을 검증'];
const STORAGE_KEY = 'ai-roundtable:settings';

const $ = (sel) => document.querySelector(sel);
const els = {
  status: $('#status'),
  setup: $('#setup'),
  form: $('#setupForm'),
  topic: $('#topic'),
  mode: $('#mode'),
  modeHint: $('#modeHint'),
  participants: $('#participants'),
  rounds: $('#rounds'),
  judge: $('#judge'),
  setupError: $('#setupError'),
  stageTopic: $('#stageTopic'),
  roundInfo: $('#roundInfo'),
  feed: $('#feed'),
  emptyState: $('#emptyState'),
  composer: $('#composer'),
  userInput: $('#userInput'),
  sendBtn: $('#sendBtn'),
  pauseBtn: $('#pauseBtn'),
  resumeBtn: $('#resumeBtn'),
  skipBtn: $('#skipBtn'),
  stopBtn: $('#stopBtn'),
  moreBtn: $('#moreBtn'),
  summaryBtn: $('#summaryBtn'),
  exportBtn: $('#exportBtn'),
  resetBtn: $('#resetBtn'),
};

const state = {
  providers: {}, // id -> { model, suggestions, available }
  order: ['claude', 'gpt', 'gemini'],
  status: 'idle', // idle | running | paused | finished | stopped
  cfg: null, // 토론 시작 시점의 설정 스냅샷
  log: [], // { type: 'turn' | 'user' | 'summary', speaker, text, round, model }
  round: 1,
  turnIndex: 0,
  pendingUser: [],
  controller: null,
  pauseRequested: false,
  stopRequested: false,
  resumeWaiter: null,
  lastError: null,
  lastRoundShown: 0,
  busy: false,
};

// ---------------------------------------------------------------- 설정 화면

function participantEl(id) {
  return els.participants.querySelector(`.participant[data-id="${id}"]`);
}

function buildParticipants(saved = {}) {
  const tpl = $('#participantTpl');
  els.participants.innerHTML = '';
  for (const id of state.order) {
    const info = state.providers[id];
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = id;
    node.querySelector('.avatar').textContent = INITIALS[id];
    node.querySelector('.p-name').textContent = NAMES[id];

    const model = node.querySelector('.p-model');
    const listId = `models-${id}`;
    model.setAttribute('list', listId);
    model.value = saved.models?.[id] || info.model;
    model.placeholder = info.model;
    const datalist = document.createElement('datalist');
    datalist.id = listId;
    for (const s of info.suggestions) datalist.append(new Option(s, s));
    node.append(datalist);

    node.querySelector('.p-stance').value = saved.stances?.[id] ?? '';

    const enabled = node.querySelector('.p-enabled');
    if (!info.available) {
      enabled.checked = false;
      enabled.disabled = true;
      node.querySelector('.p-badge').textContent = 'API 키 없음';
      node.title = '.env 파일에 이 AI의 API 키를 넣고 서버를 다시 실행하세요.';
    } else {
      enabled.checked = saved.enabled?.[id] ?? true;
    }
    node.classList.toggle('off', !enabled.checked);
    enabled.addEventListener('change', () => {
      node.classList.toggle('off', !enabled.checked);
      saveSettings();
    });
    node.querySelector('.p-up').addEventListener('click', () => move(id, -1));
    node.querySelector('.p-down').addEventListener('click', () => move(id, 1));
    els.participants.append(node);
  }
  refreshOrderButtons();

  for (const opt of els.judge.options) {
    if (opt.value) opt.disabled = !state.providers[opt.value].available;
  }
}

function move(id, delta) {
  const i = state.order.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= state.order.length) return;
  [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
  const node = participantEl(id);
  const other = participantEl(state.order[i]);
  if (delta < 0) els.participants.insertBefore(node, other);
  else els.participants.insertBefore(other, node);
  refreshOrderButtons();
  saveSettings();
}

function refreshOrderButtons() {
  state.order.forEach((id, i) => {
    const node = participantEl(id);
    node.querySelector('.p-up').disabled = i === 0;
    node.querySelector('.p-down').disabled = i === state.order.length - 1;
  });
}

function readSettings() {
  const models = {};
  const stances = {};
  const enabled = {};
  for (const id of state.order) {
    const node = participantEl(id);
    models[id] = node.querySelector('.p-model').value.trim() || state.providers[id].model;
    stances[id] = node.querySelector('.p-stance').value.trim();
    enabled[id] = node.querySelector('.p-enabled').checked;
  }
  return {
    topic: els.topic.value.trim(),
    mode: els.mode.value,
    rounds: Math.min(Math.max(parseInt(els.rounds.value, 10) || 3, 1), 20),
    judge: els.judge.value,
    length: els.form.querySelector('input[name="length"]:checked')?.value ?? 'medium',
    order: [...state.order],
    models,
    stances,
    enabled,
  };
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readSettings()));
  } catch {
    /* 저장소를 쓸 수 없는 환경이면 무시 */
  }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function applyModeHint() {
  els.modeHint.textContent = MODE_HINTS[els.mode.value] ?? '';
}

// 찬반 토론을 고르면 비어 있는 입장 칸에 찬성/반대/중립을 채워 준다.
function onModeChange() {
  applyModeHint();
  const enabledIds = state.order.filter((id) => participantEl(id).querySelector('.p-enabled').checked);
  const stanceInputs = enabledIds.map((id) => participantEl(id).querySelector('.p-stance'));
  if (els.mode.value === 'procon') {
    if (stanceInputs.every((input) => !input.value.trim())) {
      stanceInputs.forEach((input, i) => (input.value = PROCON_STANCES[i] ?? ''));
    }
  } else {
    for (const id of state.order) {
      const input = participantEl(id).querySelector('.p-stance');
      if (PROCON_STANCES.includes(input.value.trim())) input.value = '';
    }
  }
  saveSettings();
}

// ---------------------------------------------------------------- 화면 갱신

const STATUS_TEXT = {
  idle: '대기 중',
  running: '토론 진행 중',
  paused: '일시정지',
  finished: '토론 종료',
  stopped: '중단됨',
};

function setStatus(status, text) {
  state.status = status;
  els.status.dataset.state = state.lastError && status === 'paused' ? 'error' : status;
  els.status.textContent = text ?? STATUS_TEXT[status];
  updateControls();
}

function updateControls() {
  const s = state.status;
  const active = s === 'running' || s === 'paused';
  const done = s === 'finished' || s === 'stopped';
  const hasLog = state.log.length > 0;

  els.pauseBtn.hidden = s !== 'running';
  els.pauseBtn.disabled = state.pauseRequested;
  els.resumeBtn.hidden = s !== 'paused';
  els.resumeBtn.textContent = state.lastError ? '다시 시도' : '계속';
  els.skipBtn.hidden = !(s === 'paused' && state.lastError);
  els.stopBtn.hidden = !(active || state.busy);
  els.moreBtn.hidden = !done || state.busy;
  els.moreBtn.textContent = state.cfg && state.round <= state.cfg.rounds ? '이어서 진행' : '한 라운드 더';
  els.summaryBtn.hidden = !done || !hasLog || state.busy;
  els.exportBtn.hidden = !hasLog || s === 'running';
  els.resetBtn.hidden = !done || state.busy;

  const canTalk = s !== 'idle' && !(done && state.busy);
  els.userInput.disabled = !canTalk;
  els.sendBtn.disabled = !canTalk;
  els.setup.classList.toggle('locked', s !== 'idle');

  if (state.cfg) {
    els.roundInfo.textContent = `${MODE_LABELS[state.cfg.mode]} · 라운드 ${Math.min(state.round, state.cfg.rounds)}/${state.cfg.rounds}`;
  } else {
    els.roundInfo.textContent = '';
  }
}

function nearBottom() {
  const f = els.feed;
  return f.scrollHeight - f.scrollTop - f.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) els.feed.scrollTop = els.feed.scrollHeight;
}

function addRoundDivider(round) {
  const div = document.createElement('div');
  div.className = 'round-divider';
  div.textContent = `라운드 ${round}`;
  els.feed.append(div);
}

function addMessage({ speaker, kind = 'turn', model, round }) {
  els.emptyState.hidden = true;
  const stick = nearBottom();
  const msg = document.createElement('article');
  msg.className = `msg${kind === 'summary' ? ' summary' : ''}`;
  msg.dataset.speaker = speaker;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = INITIALS[speaker];

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = NAMES[speaker];
  meta.append(name);
  if (model) {
    const m = document.createElement('span');
    m.className = 'model';
    m.textContent = model;
    meta.append(m);
  }
  if (kind === 'summary') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '토론 정리';
    meta.append(tag);
  } else if (round && speaker !== 'user') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `R${round}`;
    meta.append(tag);
  }
  const body = document.createElement('div');
  body.className = 'body';
  bubble.append(meta, body);
  msg.append(avatar, bubble);
  els.feed.append(msg);
  scrollToBottom(stick);

  return {
    el: msg,
    setText(text, final = false) {
      const keep = nearBottom();
      body.innerHTML = text ? renderMarkdown(text) : final ? '' : '<span class="placeholder">생각하는 중…</span>';
      scrollToBottom(keep);
    },
    clearNotes() {
      bubble.querySelectorAll('.note').forEach((n) => n.remove());
    },
    note(text, isError = false) {
      const n = document.createElement('div');
      n.className = `note${isError ? ' error' : ''}`;
      n.textContent = text;
      bubble.append(n);
      scrollToBottom();
    },
  };
}

// ---------------------------------------------------------------- 마크다운(간단·안전)

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
}

function renderMarkdown(src) {
  let html = '';
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) html += `<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`;
    list = null;
  };
  for (const line of src.replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    let m;
    if (!t) {
      flushPara();
      flushList();
    } else if ((m = t.match(/^#{1,6}\s+(.*)$/))) {
      flushPara();
      flushList();
      html += `<h4>${inline(m[1])}</h4>`;
    } else if ((m = t.match(/^[-*•]\s+(.*)$/))) {
      flushPara();
      if (list?.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list?.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(m[1]);
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ' ' + t;
    } else {
      flushList();
      para.push(t);
    }
  }
  flushPara();
  flushList();
  return html;
}

// ---------------------------------------------------------------- 서버 호출

function transcript() {
  return state.log
    .filter((e) => e.type === 'turn' || e.type === 'user')
    .map((e) => ({ speaker: e.speaker, text: e.text }));
}

/** 한 AI의 발언을 스트리밍으로 받아 화면에 그린다. */
async function streamTurn({ kind, speaker }) {
  const cfg = state.cfg;
  const model = cfg.models[speaker];
  const round = Math.min(state.round, cfg.rounds);
  const view = addMessage({ speaker, kind, model, round: kind === 'turn' ? round : null });
  view.el.classList.add('streaming');
  view.setText('');

  const controller = new AbortController();
  state.controller = controller;
  let text = '';
  let finished = false;
  let frame = 0;
  const paint = () => {
    frame = 0;
    view.setText(text);
  };

  try {
    const res = await fetch('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        kind,
        speaker,
        model,
        topic: cfg.topic,
        mode: cfg.mode,
        length: cfg.length,
        participants: cfg.participants.map((id) => ({ id, stance: cfg.stances[id] })),
        transcript: transcript(),
        round,
        totalRounds: cfg.rounds,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `서버 오류 (HTTP ${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const evt = JSON.parse(line);
        if (evt.type === 'delta') {
          text += evt.text;
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (evt.type === 'notice') {
          view.note(evt.message);
        } else if (evt.type === 'error') {
          throw new Error(evt.message);
        } else if (evt.type === 'done') {
          finished = true;
        }
      }
    }
    if (!finished) throw new Error('서버와의 연결이 중간에 끊겼습니다.');
    if (!text.trim()) throw new Error(`${NAMES[speaker]}가 빈 응답을 보냈습니다.`);
    return { ok: true, text: text.trim(), model, round };
  } catch (err) {
    if (controller.signal.aborted) {
      view.note('중단되었습니다.');
      return { ok: false, aborted: true };
    }
    view.note(err.message || String(err), true);
    return { ok: false, error: err.message || String(err) };
  } finally {
    if (frame) cancelAnimationFrame(frame);
    view.setText(text, true);
    view.el.classList.remove('streaming');
    if (state.controller === controller) state.controller = null;
  }
}

// ---------------------------------------------------------------- 진행

function flushUserMessages() {
  while (state.pendingUser.length) {
    const { text, view } = state.pendingUser.shift();
    state.log.push({ type: 'user', speaker: 'user', text });
    view.clearNotes();
  }
}

function waitForResume() {
  return new Promise((resolve) => {
    state.resumeWaiter = resolve;
  });
}

function wake() {
  const fn = state.resumeWaiter;
  state.resumeWaiter = null;
  fn?.();
}

async function runDebate() {
  if (state.busy) return;
  state.busy = true;
  state.stopRequested = false;
  setStatus('running');

  const cfg = state.cfg;
  try {
    while (state.round <= cfg.rounds) {
      while (state.turnIndex < cfg.participants.length) {
        if (state.stopRequested) return;
        if (state.pauseRequested) {
          state.pauseRequested = false;
          setStatus('paused', state.lastError ? '오류로 멈춤' : undefined);
          await waitForResume();
          if (state.stopRequested) return;
          setStatus('running');
        }

        flushUserMessages();
        if (state.lastRoundShown !== state.round) {
          addRoundDivider(state.round);
          state.lastRoundShown = state.round;
        }

        const speaker = cfg.participants[state.turnIndex];
        setStatus('running', `${NAMES[speaker]} 발언 중`);
        const result = await streamTurn({ kind: 'turn', speaker });
        if (state.stopRequested) return;

        if (result.ok) {
          state.log.push({ type: 'turn', speaker, text: result.text, model: result.model, round: result.round });
          state.lastError = null;
          state.turnIndex++;
        } else {
          // 오류가 나면 멈추고 사용자에게 다시 시도/건너뛰기를 고르게 한다.
          state.lastError = result.error;
          state.pauseRequested = true;
        }
      }
      state.turnIndex = 0;
      state.round++;
    }

    flushUserMessages();
    if (cfg.judge) await runSummary();
  } finally {
    state.busy = false;
    state.pauseRequested = false;
    state.lastError = null;
    state.round = Math.min(state.round, cfg.rounds + 1);
    setStatus(state.stopRequested ? 'stopped' : 'finished');
  }
}

async function runSummary() {
  const cfg = state.cfg;
  const speaker = cfg.judge || cfg.participants[0];
  setStatus(state.status === 'running' ? 'running' : state.status, `${NAMES[speaker]}가 토론을 정리하는 중`);
  const result = await streamTurn({ kind: 'summary', speaker });
  if (result.ok) state.log.push({ type: 'summary', speaker, text: result.text, model: result.model });
}

async function requestSummary() {
  if (state.busy) return;
  state.busy = true;
  state.stopRequested = false;
  const prev = state.status;
  setStatus(prev);
  try {
    flushUserMessages();
    await runSummary();
  } finally {
    state.busy = false;
    setStatus(prev);
  }
}

function startDebate(event) {
  event.preventDefault();
  const s = readSettings();
  saveSettings();
  const participants = s.order.filter((id) => s.enabled[id] && state.providers[id].available);

  els.setupError.textContent = '';
  if (!s.topic) {
    els.setupError.textContent = '토론 주제를 입력하세요.';
    els.topic.focus();
    return;
  }
  if (participants.length < 2) {
    els.setupError.textContent = '토론하려면 참여자가 2명 이상 필요합니다. (.env의 API 키를 확인하세요)';
    return;
  }

  state.cfg = { ...s, participants, judge: s.judge && state.providers[s.judge].available ? s.judge : '' };
  state.log = [];
  state.round = 1;
  state.turnIndex = 0;
  state.pendingUser = [];
  state.lastRoundShown = 0;
  state.lastError = null;
  state.pauseRequested = false;

  els.feed.querySelectorAll('.msg, .round-divider').forEach((n) => n.remove());
  els.stageTopic.textContent = s.topic;
  runDebate();
}

function extendDebate() {
  if (!state.cfg || state.busy) return;
  if (state.round > state.cfg.rounds) {
    // 예정된 라운드를 다 마쳤으면 한 라운드를 추가하고, 중간에 멈췄으면 그 자리부터 잇는다.
    state.cfg.rounds += 1;
    state.round = state.cfg.rounds;
    state.turnIndex = 0;
  }
  runDebate();
}

function resetDebate() {
  if (state.log.length && !confirm('지금 토론 기록을 지우고 새 토론을 시작할까요?')) return;
  state.cfg = null;
  state.log = [];
  state.pendingUser = [];
  els.feed.querySelectorAll('.msg, .round-divider').forEach((n) => n.remove());
  els.emptyState.hidden = false;
  els.stageTopic.textContent = '주제를 정하고 토론을 시작하세요';
  setStatus('idle');
  els.topic.focus();
}

function sendUserMessage(event) {
  event.preventDefault();
  const text = els.userInput.value.trim();
  if (!text) return;
  els.userInput.value = '';
  autoGrow();
  const view = addMessage({ speaker: 'user' });
  view.setText(text, true);
  view.note('다음 발언 전에 전달됩니다');
  scrollToBottom(true);
  state.pendingUser.push({ text, view });

  if (state.status === 'finished' || state.status === 'stopped') {
    // 끝난 토론에 질문을 던지면 한 라운드를 더 진행해 답하게 한다.
    extendDebate();
  } else if (state.status === 'paused' && !state.lastError) {
    flushUserMessages();
  }
}

function exportMarkdown() {
  const cfg = state.cfg;
  const lines = [
    '# AI 라운드테이블 토론 기록',
    '',
    `- 주제: ${cfg.topic}`,
    `- 방식: ${MODE_LABELS[cfg.mode]}`,
    `- 참여자: ${cfg.participants
      .map((id) => `${NAMES[id]} (${cfg.models[id]}${cfg.stances[id] ? `, ${cfg.stances[id]}` : ''})`)
      .join(', ')}`,
    `- 저장 시각: ${new Date().toLocaleString('ko-KR')}`,
    '',
  ];
  let round = 0;
  for (const e of state.log) {
    if (e.type === 'turn' && e.round !== round) {
      round = e.round;
      lines.push(`## 라운드 ${round}`, '');
    }
    if (e.type === 'summary') lines.push(`## 토론 정리 — ${NAMES[e.speaker]}`, '', e.text, '');
    else if (e.type === 'user') lines.push(`> **사회자:** ${e.text.replace(/\n/g, '\n> ')}`, '');
    else lines.push(`### ${NAMES[e.speaker]}`, '', e.text, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.download = `토론-${stamp}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function autoGrow() {
  els.userInput.style.height = 'auto';
  els.userInput.style.height = `${Math.min(els.userInput.scrollHeight, 160)}px`;
}

// ---------------------------------------------------------------- 이벤트 연결

function bindEvents() {
  els.form.addEventListener('submit', startDebate);
  els.form.addEventListener('change', saveSettings);
  els.topic.addEventListener('input', saveSettings);
  els.mode.addEventListener('change', onModeChange);

  els.pauseBtn.addEventListener('click', () => {
    state.pauseRequested = true;
    els.status.textContent = '이번 발언이 끝나면 멈춥니다';
    updateControls();
  });
  els.resumeBtn.addEventListener('click', () => {
    state.lastError = null;
    wake();
  });
  els.skipBtn.addEventListener('click', () => {
    state.lastError = null;
    state.turnIndex++;
    wake();
  });
  els.stopBtn.addEventListener('click', () => {
    state.stopRequested = true;
    state.controller?.abort();
    wake();
  });
  els.moreBtn.addEventListener('click', extendDebate);
  els.summaryBtn.addEventListener('click', requestSummary);
  els.exportBtn.addEventListener('click', exportMarkdown);
  els.resetBtn.addEventListener('click', resetDebate);

  els.composer.addEventListener('submit', sendUserMessage);
  els.userInput.addEventListener('input', autoGrow);
  els.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });
}

async function init() {
  let config;
  try {
    const res = await fetch('/api/config');
    config = await res.json();
  } catch {
    els.setupError.textContent = '서버에 연결할 수 없습니다. `npm start`로 서버를 실행했는지 확인하세요.';
    return;
  }
  for (const p of config.providers) state.providers[p.id] = p;
  $('#mockBanner').hidden = !config.mock;

  const saved = loadSettings();
  if (Array.isArray(saved.order) && saved.order.length === 3 && state.order.every((id) => saved.order.includes(id))) {
    state.order = saved.order;
  }
  if (saved.topic) els.topic.value = saved.topic;
  if (saved.mode && MODE_HINTS[saved.mode]) els.mode.value = saved.mode;
  if (saved.rounds) els.rounds.value = saved.rounds;
  if (saved.judge !== undefined) els.judge.value = saved.judge;
  if (saved.length) {
    const radio = els.form.querySelector(`input[name="length"][value="${saved.length}"]`);
    if (radio) radio.checked = true;
  }
  buildParticipants(saved);
  if (els.judge.selectedOptions[0]?.disabled) els.judge.value = '';
  applyModeHint();

  const noneAvailable = config.providers.every((p) => !p.available);
  if (noneAvailable) {
    els.setupError.textContent = 'API 키가 하나도 설정되지 않았습니다. .env 파일을 만들거나 `npm run demo`로 데모 모드를 실행하세요.';
  }
  bindEvents();
  setStatus('idle');
}

init();
