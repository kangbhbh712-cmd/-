// 토론 프롬프트 구성. 모든 AI에게 같은 형식의 기록을 보여주고,
// "지금 누구 차례인지"만 바꿔서 각자의 발언을 받는다.

export const PARTICIPANT_NAMES = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
};

const VENDORS = {
  claude: 'Anthropic',
  gpt: 'OpenAI',
  gemini: 'Google',
};

export const MODES = {
  debate: {
    label: '자유 토론',
    rule: '각자 독립적인 관점에서 주장하고, 다른 참여자의 주장을 비판적으로 검토하는 토론입니다. 근거가 약한 주장은 분명하게 반박하세요.',
  },
  procon: {
    label: '찬반 토론',
    rule: '각 참여자는 배정된 입장을 끝까지 일관되게 대변합니다. 상대 입장의 약점을 공략하고, 자기 입장에 대한 반박에는 직접 재반박하세요.',
  },
  brainstorm: {
    label: '브레인스토밍',
    rule: '서로의 아이디어를 이어받아 발전시키고 결합하는 협업 토론입니다. 남의 아이디어를 개선하거나 새로운 방향을 제시하되, 실현 가능성의 문제도 짚어 주세요.',
  },
  consensus: {
    label: '합의 도출',
    rule: '의견 차이를 확인한 뒤 논의를 통해 모두가 받아들일 수 있는 결론을 만들어 가는 토론입니다. 어디까지 동의하고 어디서 갈리는지 명확히 하며 합의안을 좁혀 가세요.',
  },
};

const LENGTHS = {
  short: '2~4문장, 300자 안팎으로 짧고 날카롭게',
  medium: '한두 문단, 600자 안팎',
  long: '최대 서너 문단, 1200자 이내',
};

function formatTranscript(transcript) {
  if (!transcript.length) return '(아직 아무도 발언하지 않았습니다.)';
  return transcript
    .map((m) => {
      const label = m.speaker === 'user' ? '사회자(사용자)' : PARTICIPANT_NAMES[m.speaker] ?? m.speaker;
      return `[${label}]\n${m.text.trim()}`;
    })
    .join('\n\n');
}

function participantList(participants) {
  return participants
    .map((p) => {
      const stance = p.stance?.trim() ? ` — 입장/역할: ${p.stance.trim()}` : '';
      return `- ${PARTICIPANT_NAMES[p.id]} (${VENDORS[p.id]})${stance}`;
    })
    .join('\n');
}

/** 한 차례 발언용 프롬프트 */
export function buildTurnPrompt({ speaker, topic, mode, length, participants, transcript, round, totalRounds }) {
  const me = PARTICIPANT_NAMES[speaker];
  const myStance = participants.find((p) => p.id === speaker)?.stance?.trim();
  const modeInfo = MODES[mode] ?? MODES.debate;

  const system = [
    `당신은 ${me}(${VENDORS[speaker]})입니다. 지금 다른 AI들과 한 자리에 모여 토론하고 있습니다.`,
    '',
    `## 토론 주제\n${topic}`,
    '',
    `## 토론 방식: ${modeInfo.label}\n${modeInfo.rule}`,
    '',
    `## 참여자\n${participantList(participants)}`,
    myStance ? `\n당신(${me})의 입장/역할은 "${myStance}"입니다. 이 입장을 일관되게 지키세요.` : '',
    '',
    '## 발언 규칙',
    '- 반드시 한국어로 답하세요.',
    '- 다른 참여자의 이름을 직접 부르며 그들의 구체적인 주장에 반응하세요(동의, 반박, 보완).',
    '- 이미 나온 내용을 되풀이하지 말고, 새로운 논거·사례·반례를 더하세요.',
    '- 무조건 맞장구치지 마세요. 동의할 때도 이유를 밝히고, 허점이 보이면 지적하세요.',
    '- 사회자(사용자)가 질문하거나 요청한 것이 있으면 그것부터 답하세요.',
    `- 분량: ${LENGTHS[length] ?? LENGTHS.medium}.`,
    `- "[${me}]" 같은 이름표를 앞에 붙이지 말고 발언 본문만 쓰세요.`,
    '- 마크다운 제목(#)은 쓰지 말고, 필요하면 굵은 글씨나 짧은 목록 정도만 쓰세요.',
  ].join('\n');

  let cue;
  const hasOwnTurn = transcript.some((m) => m.speaker === speaker);
  if (!transcript.length) {
    cue = '당신이 첫 발언자입니다. 주제에 대한 당신의 입장과 핵심 근거를 밝히며 토론을 시작하세요.';
  } else if (!hasOwnTurn) {
    cue = '이번이 당신의 첫 발언입니다. 당신의 입장을 밝히면서, 앞선 발언에 대해서도 반응하세요.';
  } else if (round >= totalRounds) {
    cue = '마지막 라운드입니다. 지금까지의 논의를 반영해 최종 입장을 밝히고, 끝까지 남은 쟁점을 짚으세요.';
  } else {
    cue = '직전 발언들에 반응하며 토론을 이어가세요.';
  }

  const user = [
    '## 지금까지의 토론 기록',
    formatTranscript(transcript),
    '',
    '---',
    `(라운드 ${round}/${totalRounds}) 이제 ${me}, 당신의 차례입니다. ${cue}`,
  ].join('\n');

  return { system, user };
}

/** 토론 정리(판정)용 프롬프트 */
export function buildSummaryPrompt({ speaker, topic, mode, participants, transcript }) {
  const me = PARTICIPANT_NAMES[speaker];
  const modeInfo = MODES[mode] ?? MODES.debate;
  const tookPart = participants.some((p) => p.id === speaker);

  const system = [
    `당신은 ${me}(${VENDORS[speaker]})이며, 이번에는 토론의 정리자 역할을 맡았습니다.`,
    tookPart
      ? '당신도 토론에 참여했지만, 정리할 때는 자기 주장을 편들지 말고 모든 참여자를 공정하게 다루세요.'
      : '모든 참여자를 공정하게 다루세요.',
    '반드시 한국어로 쓰세요. 마크다운 굵은 글씨와 목록을 써도 좋습니다.',
  ].join('\n');

  const user = [
    `## 토론 주제\n${topic}`,
    `## 토론 방식\n${modeInfo.label}`,
    `## 참여자\n${participantList(participants)}`,
    '',
    '## 토론 기록',
    formatTranscript(transcript),
    '',
    '---',
    '위 토론을 다음 순서로 정리하세요.',
    '1. **핵심 쟁점** — 무엇을 두고 의견이 갈렸는지',
    '2. **참여자별 핵심 주장** — 각자 한두 줄로',
    '3. **합의된 점**',
    '4. **남은 이견**',
    '5. **종합 평가** — 어떤 논거가 가장 설득력 있었는지와 그 이유, 그리고 최종 결론',
  ].join('\n');

  return { system, user };
}
