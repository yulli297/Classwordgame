// =====================================================
//  한글날 초성 퀴즈 - 모둠 대항전 (고유어 / 한자어 모드)
//  Node.js + Express + Socket.io
//  6개 모둠이 한 방에서 번갈아 답을 쓰고, 사전에서 고유어(또는 한자어)로 확인된 단어만 정답으로 인정해요.
// =====================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// 접속 끊김 판정: 10초마다 확인, 15초 동안 응답 없으면 끊긴 것으로 봄
const io = new Server(server, { pingInterval: 10000, pingTimeout: 15000 });

const PORT = process.env.PORT || 3000;
const STDICT_KEY = (process.env.STDICT_KEY || '').trim(); // 표준국어대사전 키

// ===== 게임 설정 (여기 숫자만 바꾸면 규칙이 바뀌어요) =====
const CONFIG = {
  MAX_TEAMS: 6,          // 모둠 수 (번호 1~6)
  TURN_MS: 15000,        // 한 모둠 제한시간 (모둠원이 의논할 시간 포함, 15초)
  LAPS: 3,               // 아무도 안 틀리면 몇 바퀴 돌고 라운드 종료
  TOTAL_ROUNDS: 5,       // 전체 라운드 수
  LOSS_LIMIT: 2,         // 라운드 탈락 몇 번이면 패배
  POPUP_MS: 3500,        // 뜻 팝업 시간
  COUNTDOWN: 5,          // 게임 시작 카운트다운
  DICT_TIMEOUT_MS: 6000, // 사전 응답 기다리는 최대 시간 (한 번 물어볼 때)
  DEF_MAX: 80,           // 뜻 최대 글자 수
  LOBBY_GRACE_MS: 60000, // 대기실에서 잠깐 끊긴 모둠을 명단에 남겨 두는 시간
};
// 모드별 사전 필터(type2)와 안내 문구
const MODES = {
  native:  { label: '고유어', type2: 'native' },
  chinese: { label: '한자어', type2: 'chinese' },
};
const BLOCK_TYPES = ['방언', '북한어', '옛말', '지역어']; // 인정하지 않는 단어 종류

process.on('uncaughtException', e => console.error('[오류]', e));
process.on('unhandledRejection', e => console.error('[오류]', e));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/teacher', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
app.get('/health', (req, res) => res.send('ok'));

// ===== 한글 처리 =====
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const SPLIT = { 'ㄳ':'ㄱㅅ','ㄵ':'ㄴㅈ','ㄶ':'ㄴㅎ','ㄺ':'ㄹㄱ','ㄻ':'ㄹㅁ','ㄼ':'ㄹㅂ','ㄽ':'ㄹㅅ','ㄾ':'ㄹㅌ','ㄿ':'ㄹㅍ','ㅀ':'ㄹㅎ','ㅄ':'ㅂㅅ' };
function normalizeChosung(s) {
  return String(s || '').replace(/\s/g, '').split('').map(c => SPLIT[c] || c).join('');
}
function isValidChosung(s) {
  return s.length >= 1 && s.length <= 6 && s.split('').every(c => CHO.includes(c));
}
function choOf(ch) {
  const c = ch.charCodeAt(0) - 0xAC00;
  if (c < 0 || c > 11171) return null;
  return CHO[Math.floor(c / 588)];
}
function localCheck(word, cho) {
  if (!word) return '단어를 입력해주세요.';
  for (const ch of word) if (choOf(ch) === null) return '완성된 한글 글자로만 써주세요.';
  if (word.length !== cho.length) return `${cho.length}글자 단어를 써주세요.`;
  for (let i = 0; i < word.length; i++) if (choOf(word[i]) !== cho[i]) return '초성이 맞지 않아요.';
  return '';
}

// ===== 사전 확인 (표준국어대사전) =====
function toArr(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }
function cleanWord(w) { return String(w || '').replace(/[-^\s]/g, ''); }
function cleanDef(s) {
  let d = String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (d.length > CONFIG.DEF_MAX) d = d.slice(0, CONFIG.DEF_MAX) + '…';
  return d;
}
async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CONFIG.DICT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return (await res.text()).trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('응답 시간 초과');
    throw e;
  } finally { clearTimeout(t); }
}
// type2: 'native'(고유어) | 'chinese'(한자어) | 'all'(전체)
// 결과: {status:'ok', def} 또는 {status:'notfound'}. 연결 문제면 에러를 던짐
async function queryDict(word, type2) {
  const url = `https://stdict.korean.go.kr/api/search.do?key=${encodeURIComponent(STDICT_KEY)}&q=${encodeURIComponent(word)}&req_type=json&advanced=y&method=exact&type2=${type2}&num=30`;
  const text = await fetchText(url);
  if (!text) return { status: 'notfound' };
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('응답 형식 오류'); }
  if (!data || typeof data !== 'object') throw new Error('응답 형식 오류');
  if (data.error) throw new Error('API 오류 ' + JSON.stringify(data.error));
  const items = toArr(data.channel && data.channel.item);
  for (const it of items) {
    if (cleanWord(it.word) !== word) continue;
    for (const s of toArr(it.sense)) {
      if (BLOCK_TYPES.includes(String(s.type || '').trim())) continue;
      return { status: 'ok', def: cleanDef(s.definition) };
    }
  }
  return { status: 'notfound' };
}
// 모드에 맞는 단어인지 확인. 두 번 시도하고도 연결이 안 되면 down
async function lookup(word, mode) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await queryDict(word, MODES[mode].type2);
      if (r.status === 'ok') return r;
      // 모드에 안 맞는 건지, 사전에 아예 없는 건지 구분해서 안내하기 위해 한 번 더 물어봄
      let reason = 'none';
      try { reason = (await queryDict(word, 'all')).status === 'ok' ? 'mismatch' : 'none'; } catch (e) { /* 안내만 못 구분 */ }
      return { status: 'notfound', reason };
    } catch (e) { console.log(`[사전] 연결 실패 ("${word}", ${i + 1}번째):`, e.message); }
  }
  return { status: 'down' };
}
const wordCache = new Map();  // `${모드}:${단어}` -> 결과
const inflight = new Map();   // 지금 확인 중인 단어
let dictFails = 0;
async function checkWord(word, mode) {
  const key = mode + ':' + word;
  if (wordCache.has(key)) return { ...wordCache.get(key), cached: true };
  if (!inflight.has(key)) inflight.set(key, lookup(word, mode).finally(() => inflight.delete(key)));
  const r = await inflight.get(key);
  if (r.status === 'down') dictFails++;
  else wordCache.set(key, r);
  return r;
}

// ===== 게임 상태 =====
const teams = new Map(); // 모둠 번호 -> { num, token, socketId, connected, dropTimer }
let gameSeq = 0;
let chosungList = ['', '', '', '', ''];
let selectedMode = 'native'; // 교사가 대기실에서 고른 모드
let countdownTimer = null;
let game = freshGame();

function freshGame() {
  return {
    id: ++gameSeq, phase: 'lobby', round: 0, chosung: '', mode: selectedMode, members: [], stats: {},
    countdown: 0, endReason: '', room: newRoom(),
  };
}
function newRoom() {
  return {
    order: [], pos: -1, lap: 1, used: [], words: [], status: 'idle', current: null, typing: '',
    remaining: CONFIG.TURN_MS, deadline: 0, checking: false, popup: null, lastLoser: null, waiting: false,
    _turnTimer: null, _popupTimer: null,
  };
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function teamNums() { return [...teams.values()].map(s => s.num).sort((a, b) => a - b); }
function awayNums() { return [...teams.values()].filter(s => !s.connected).map(s => s.num).sort((a, b) => a - b); }
function isConnected(num) { const s = teams.get(num); return !!(s && s.connected); }
function aliveTeams() { return game.members.filter(n => !game.stats[n].defeated); }
function clearRoomTimers(room) {
  clearTimeout(room._turnTimer); clearTimeout(room._popupTimer);
  room._turnTimer = null; room._popupTimer = null;
}
function clearAllTimers() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  clearRoomTimers(game.room);
}
// 순위: 생존 > 라운드 탈락이 적은 순 > 맞힌 단어가 많은 순
function ranking() {
  return game.members.slice().sort((a, b) => {
    const x = game.stats[a], y = game.stats[b];
    return (x.defeated - y.defeated) || (x.losses - y.losses) || (y.correct - x.correct) || (a - b);
  });
}

function snapshot() {
  const r = game.room, now = Date.now();
  const mode = game.phase === 'lobby' ? selectedMode : game.mode;
  return {
    phase: game.phase, round: game.round, totalRounds: CONFIG.TOTAL_ROUNDS, laps: CONFIG.LAPS,
    lossLimit: CONFIG.LOSS_LIMIT, maxTeams: CONFIG.MAX_TEAMS, mode, modeLabel: MODES[mode].label,
    chosung: (game.phase === 'playing' || game.phase === 'roundEnd') ? game.chosung : '',
    countdown: game.countdown, endReason: game.endReason, dictFails,
    online: teamNums(), away: awayNums(), members: game.members, stats: game.stats,
    ranking: game.phase === 'gameOver' ? ranking() : [],
    room: {
      status: r.status, order: r.order, current: r.current, typing: r.typing, checking: r.checking,
      words: r.words, lap: r.lap, popup: r.popup, lastLoser: r.lastLoser, waiting: r.waiting,
      remaining: (r.status === 'live' && r.current != null && !r.checking && !r.popup)
        ? Math.max(0, r.deadline - now) : r.remaining,
    },
  };
}
function broadcast() { io.emit('state', snapshot()); }
function teacherInfo() {
  return { chosungList, hasKey: !!STDICT_KEY, maxTeams: CONFIG.MAX_TEAMS, totalRounds: CONFIG.TOTAL_ROUNDS };
}

// ===== 라운드 / 차례 진행 =====
function startRound(n) {
  const room = game.room;
  game.round = n;
  game.chosung = chosungList[n - 1];
  game.phase = 'playing';
  clearRoomTimers(room);
  Object.assign(room, newRoom());
  const alive = aliveTeams();
  if (alive.length <= 1) { room.status = 'done'; return endGame(''); }
  room.order = shuffle(alive.slice());
  room.status = 'live';
  advance(room);
}

// 다음 모둠으로 (접속 끊긴 모둠은 건너뜀)
function advance(room) {
  clearRoomTimers(room);
  room.typing = ''; room.popup = null; room.checking = false; room.current = null;
  // 모두 끊겨 있으면 바퀴를 돌리지 않고 누군가 다시 들어올 때까지 기다림
  if (!room.order.some(isConnected)) { room.waiting = true; return; }
  room.waiting = false;
  while (true) {
    room.pos++;
    if (room.pos >= room.order.length) {
      room.pos = 0; room.lap++;
      if (room.lap > CONFIG.LAPS) { room.lap = CONFIG.LAPS; return endRound(room, null); }
    }
    const num = room.order[room.pos];
    if (isConnected(num)) return startTurn(room, num);
  }
}
function startTurn(room, num) {
  room.current = num; room.typing = ''; room.checking = false; room.popup = null;
  room.remaining = CONFIG.TURN_MS;
  runTimer(room);
}
function runTimer(room) {
  clearTimeout(room._turnTimer);
  room.deadline = Date.now() + room.remaining;
  const gid = game.id;
  room._turnTimer = setTimeout(() => {
    if (game.id !== gid || room.status !== 'live' || room.checking || room.popup || room.current == null) return;
    if (!isConnected(room.current)) {
      console.log(`[연결 끊김] ${room.current}모둠 차례 건너뜀`);
      advance(room);
    } else {
      console.log(`[시간초과] ${room.lap}바퀴 ${room.current}모둠 라운드 탈락`);
      endRound(room, room.current);
    }
    broadcast();
  }, room.remaining);
}
function pauseTimer(room) {
  clearTimeout(room._turnTimer); room._turnTimer = null;
  room.remaining = Math.max(0, room.deadline - Date.now());
  room.checking = true;
}
function resumeTimer(room) {
  room.checking = false;
  room.remaining = Math.max(2000, room.remaining); // 다시 쓸 시간 최소 2초는 보장
  runTimer(room);
}
function endRound(room, loser) {
  clearRoomTimers(room);
  room.current = null; room.typing = ''; room.checking = false; room.popup = null; room.waiting = false;
  room.lastLoser = loser;
  room.status = 'done';
  if (loser != null) {
    const st = game.stats[loser];
    st.losses++;
    if (st.losses >= CONFIG.LOSS_LIMIT) st.defeated = true;
  }
  if (game.round >= CONFIG.TOTAL_ROUNDS || aliveTeams().length <= 1) endGame('');
  else game.phase = 'roundEnd';
}
function endGame(reason) {
  clearAllTimers();
  const r = game.room;
  if (r.status === 'live') r.status = 'done';
  r.current = null; r.typing = ''; r.checking = false; r.popup = null; r.waiting = false;
  game.phase = 'gameOver';
  game.endReason = reason || '';
}

// ===== 소켓 이벤트 =====
io.on('connection', (socket) => {
  const on = (ev, fn) => socket.on(ev, (...args) => {
    try {
      const p = fn(...args);
      if (p && typeof p.catch === 'function') p.catch(e => console.error(`[오류] ${ev}`, e));
    } catch (e) { console.error(`[오류] ${ev}`, e); }
  });
  socket.emit('state', snapshot());

  // ---------- 모둠 ----------
  on('teamLogin', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const num = parseInt(data && data.num, 10);
    const token = String((data && data.token) || '');
    if (!Number.isInteger(num) || num < 1 || num > CONFIG.MAX_TEAMS) {
      return cb({ ok: false, msg: `1~${CONFIG.MAX_TEAMS} 사이의 모둠 번호를 입력해주세요.` });
    }
    let s = teams.get(num);
    if (s && s.connected && s.token !== token) {
      return cb({ ok: false, msg: '이미 접속 중인 모둠이에요. 우리 모둠 번호가 맞는지 확인해주세요.' });
    }
    if (!s) { s = { num }; teams.set(num, s); }
    clearTimeout(s.dropTimer); s.dropTimer = null;
    const oldId = s.connected ? s.socketId : null;
    s.token = token; s.socketId = socket.id; s.connected = true;
    socket.data.role = 'team'; socket.data.num = num;
    if (oldId && oldId !== socket.id) {
      const old = io.sockets.sockets.get(oldId);
      if (old) old.disconnect(true);
    }
    // 방 전체가 끊겨 멈춰 있었다면 다시 진행
    if (game.phase === 'playing' && game.room.status === 'live' && game.room.waiting) advance(game.room);
    cb({ ok: true, num });
    broadcast();
  });

  on('teamLogout', () => {
    const num = socket.data.num;
    if (game.phase === 'lobby' && num) {
      const s = teams.get(num);
      if (s && s.socketId === socket.id) { clearTimeout(s.dropTimer); teams.delete(num); }
      socket.data.role = null; socket.data.num = null;
      broadcast();
    }
  });

  on('typing', (text) => {
    const num = socket.data.num, room = game.room;
    if (game.phase !== 'playing' || room.status !== 'live' || room.current !== num || room.checking || room.popup) return;
    room.typing = String(text || '').slice(0, 20);
    io.emit('typing', { text: room.typing });
  });

  on('submitWord', async (raw, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const num = socket.data.num, room = game.room;
    const word = String(raw || '').replace(/\s/g, '');
    if (game.phase !== 'playing' || room.status !== 'live' || room.current !== num || room.checking || room.popup) {
      console.log(`[제출 무시] ${num}모둠 "${word}"`);
      return cb({ ok: false, msg: '' });
    }
    const mode = game.mode, label = MODES[mode].label;
    const tag = `[제출] ${room.lap}바퀴 ${num}모둠 "${word}" (${label})`;
    const err = localCheck(word, game.chosung);
    if (err) { console.log(`${tag} → ${err}`); return cb({ ok: false, msg: err }); }
    if (room.used.includes(word)) { console.log(`${tag} → 이미 제출된 단어`); return cb({ ok: false, msg: '이미 제출된 정답입니다.' }); }

    pauseTimer(room); // 사전 확인하는 동안 시간 멈춤
    broadcast();
    const gid = game.id, round = game.round;
    const t0 = Date.now();
    const r = await checkWord(word, mode);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${tag} → ${r.status === 'ok' ? '정답' : r.status === 'notfound' ? (r.reason === 'mismatch' ? `${label} 아님` : '사전에 없음') : '사전 연결 실패'} (${r.cached ? '기억해 둔 결과' : '사전'}, ${sec}초)`);
    if (game.id !== gid || game.round !== round || room.status !== 'live' || room.current !== num) {
      return cb({ ok: false, msg: '' });
    }

    if (r.status === 'down' || r.status === 'notfound') {
      let msg;
      if (r.status === 'down') msg = '사전 연결이 잠깐 느려요. 같은 단어를 다시 제출해 주세요.';
      else if (r.reason === 'mismatch') msg = `'${word}'은(는) ${label}가 아니에요. ${label} 단어를 써보세요!`;
      else msg = '사전에 없는 단어예요. 다시 써보세요!';
      cb({ ok: false, msg });
      if (!isConnected(num)) advance(room); else resumeTimer(room);
      return broadcast();
    }
    // 정답!
    room.used.push(word);
    room.words.push({ word, num });
    game.stats[num].correct++;
    room.typing = '';
    room.popup = { word, def: r.def, num };
    cb({ ok: true });
    broadcast();
    room._popupTimer = setTimeout(() => {
      if (game.id !== gid || room.status !== 'live') return;
      advance(room);
      broadcast();
    }, CONFIG.POPUP_MS);
  });

  // ---------- 교사 ----------
  on('teacherJoin', () => {
    socket.data.role = 'teacher';
    socket.join('teacher');
    socket.emit('teacherInfo', teacherInfo());
    socket.emit('state', snapshot());
  });

  on('saveChosung', (list) => {
    if (game.phase !== 'lobby' || !Array.isArray(list)) return;
    chosungList = list.slice(0, CONFIG.TOTAL_ROUNDS).map(normalizeChosung);
    while (chosungList.length < CONFIG.TOTAL_ROUNDS) chosungList.push('');
    socket.to('teacher').emit('teacherInfo', teacherInfo());
  });

  on('setMode', (mode) => {
    if (game.phase !== 'lobby' || !MODES[mode]) return;
    selectedMode = mode;
    game.mode = mode;
    broadcast();
  });

  on('startGame', (list, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (game.phase !== 'lobby') return cb({ ok: false, msg: '이미 게임이 진행 중이에요.' });
    const norm = (Array.isArray(list) ? list : []).slice(0, CONFIG.TOTAL_ROUNDS).map(normalizeChosung);
    if (norm.length < CONFIG.TOTAL_ROUNDS || !norm.every(isValidChosung)) {
      return cb({ ok: false, msg: `초성 ${CONFIG.TOTAL_ROUNDS}개를 모두 자음으로만 입력해주세요.` });
    }
    if (!STDICT_KEY) return cb({ ok: false, msg: '사전 키가 설정되지 않았어요. Render 환경변수 STDICT_KEY를 확인해주세요.' });
    const nums = teamNums(); // 시작 순간 잠깐 끊긴 모둠도 포함
    if (nums.length < 2) return cb({ ok: false, msg: '모둠이 2개 이상 접속해야 시작할 수 있어요.' });

    chosungList = norm;
    game.mode = selectedMode;
    game.members = nums;
    game.stats = {};
    nums.forEach(n => {
      game.stats[n] = { losses: 0, correct: 0, defeated: false };
      clearTimeout(teams.get(n).dropTimer); teams.get(n).dropTimer = null;
    });
    game.phase = 'assigning';
    game.countdown = CONFIG.COUNTDOWN;
    cb({ ok: true });
    broadcast();
    const gid = game.id;
    countdownTimer = setInterval(() => {
      try {
        if (game.id !== gid) { clearInterval(countdownTimer); countdownTimer = null; return; }
        game.countdown--;
        if (game.countdown <= 0) {
          clearInterval(countdownTimer); countdownTimer = null;
          startRound(1);
        }
        broadcast();
      } catch (e) { console.error('[오류] 카운트다운', e); }
    }, 1000);
  });

  on('nextRound', () => {
    if (game.phase !== 'roundEnd') return;
    startRound(game.round + 1);
    broadcast();
  });

  on('forceEnd', () => {
    if (game.phase === 'lobby' || game.phase === 'gameOver') return;
    endGame('선생님이 게임을 끝냈어요.');
    broadcast();
  });

  on('resetGame', () => {
    clearAllTimers();
    game = freshGame();
    for (const [num, s] of teams) if (!s.connected) { clearTimeout(s.dropTimer); teams.delete(num); }
    io.to('teacher').emit('teacherInfo', teacherInfo());
    broadcast();
  });

  // 사전 연결 + 고유어/한자어 판정 시험
  on('testDict', async (cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!STDICT_KEY) return cb(['표준국어대사전: 키가 설정되지 않았어요 (STDICT_KEY)']);
    // [단어, 모드, 정답이어야 하는지, 설명]
    const cases = [
      ['하늘', 'native', true, '고유어'], ['학교', 'chinese', true, '한자어'],
      ['학교', 'native', false, '한자어라서 고유어 모드에서는 탈락'], ['하늘', 'chinese', false, '고유어라서 한자어 모드에서는 탈락'],
    ];
    const out = [];
    for (const [w, m, expect, why] of cases) {
      try {
        const t0 = Date.now();
        const r = await queryDict(w, MODES[m].type2);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        const ok = (r.status === 'ok') === expect;
        out.push(`${ok ? '✅' : '❌'} "${w}" (${MODES[m].label} 모드) → ${r.status === 'ok' ? '정답 인정' : '정답 아님'} · ${why} · ${sec}초`);
      } catch (e) { out.push(`❌ "${w}" (${MODES[m].label} 모드) → 연결 실패 (${e.message})`); }
    }
    out.push(out.every(l => l.startsWith('✅')) ? '→ 모두 정상이에요!' : '→ ❌가 있으면 이 화면을 그대로 알려주세요.');
    cb(out);
  });

  // ---------- 접속 끊김 ----------
  on('disconnect', () => {
    if (socket.data.role !== 'team') return;
    const num = socket.data.num;
    const s = teams.get(num);
    if (!s || s.socketId !== socket.id) return;
    s.connected = false; s.socketId = null;
    if (game.phase === 'lobby') {
      clearTimeout(s.dropTimer);
      s.dropTimer = setTimeout(() => {
        const cur = teams.get(num);
        if (cur === s && !s.connected && game.phase === 'lobby') { teams.delete(num); broadcast(); }
      }, CONFIG.LOBBY_GRACE_MS);
    }
    broadcast();
  });
});

server.listen(PORT, () => console.log(`초성 퀴즈(모둠 대항전) 서버 실행 중: ${PORT}`));
