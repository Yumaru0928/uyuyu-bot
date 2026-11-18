'use strict';

// Web版 三人麻雀の対局サーバー（WebSocket）
//
// ・ババ抜き（utils/babanuki-server.js）と同じ型: 既存の Express サーバーに相乗りし、
//   ルーム/ロビー/Discord ログイン（短命トークン検証）/再戦承諾の流れを踏襲する。
// ・対局進行そのものは utils/mahjong-game.js（純粋な状態機械）に委譲し、ここは
//   「誰の入力をいつ受けるか」の調停だけを行う:
//     - 手番が Bot 席なら遅延を置いて Bot に打たせる
//     - 鳴き応答ウィンドウでは Bot は即応答、人間は制限時間内に応答（過ぎたらパス扱い）
//     - 人間が切断した席は Bot が代行し（ツモ/ロン可・ポン等はパス）、再接続で復帰できる
//       （ババ抜きと違い、1人の切断で対局全体は止めない）
// ・ルームの流れ: 待機（lobby・3席）→ 対局（playing）→ 終了（finished・再戦承諾制）
// ・開始点 35000、東風戦/半荘戦はホストがロビーで選べる（既定は東風戦）
//
// クライアント→サーバー:
//   { type:'create', mode:'bot'|'human', length?, token?, name? }
//   { type:'join', code, token?, name? }
//   { type:'add_bot' } / { type:'remove_bot', seat } / { type:'set_length', length }
//   { type:'start' }
//   { type:'discard', tile, riichi? } / { type:'tsumo' } / { type:'kan', tile, kanKind }
//   { type:'call_response', action:'ron'|'pon'|'kan'|'pass' }
//   { type:'rematch' } / { type:'rematch_decline' } / { type:'leave' }
// サーバー→クライアント:
//   { type:'created', code }
//   { type:'lobby', code, youSeat, isHost, canStart, length, players:[...] }
//   { type:'state', seat, players:[{name,bot,connected}], view }
//   { type:'rematch_status', ... } / { type:'rematch_declined', byName }
//   { type:'player_disconnected', name } / { type:'player_back', name }
//   { type:'room_closed', message } / { type:'room_expired' } / { type:'error', message }

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const game = require('./mahjong-game.js');
const { baseUrl } = require('./notify/common.js');
const { UYUYU_EMOJIS } = require('./emojis.js');

const WS_PATH = '/play/mahjong/ws';
const RECONNECT_GRACE_MS = 60_000;
const WAITING_TTL_MS = 10 * 60 * 1000;
const BOT_DELAY_MS = 850;
const BOT_CALL_DELAY_MS = 450;
const CALL_TIMEOUT_MS = 20_000;
const ROUND_NEXT_MS = 8_000;
const MAX_ROOMS = 200;
const MAX_PLAYERS = 3;
const FINISHED_KEEP_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FALLBACK_BASE_URL = 'https://uyuyu-bot.onrender.com';

const rooms = new Map();

function newCode() {
  for (let tries = 0; tries < 20; tries++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function sanitizeName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s || 'ゲスト';
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function botSlot(name) {
  // Bot のアイコンは、うゆゆ絵文字からランダムに1つ選ぶ
  const e = UYUYU_EMOJIS[crypto.randomInt(UYUYU_EMOJIS.length)];
  const icon = e ? `https://cdn.discordapp.com/emojis/${e.id}.png?size=64` : null;
  return { ws: null, user: { id: 'BOT', name, guest: false }, bot: true, icon };
}

// 席のアイコンURL：Bot はうゆゆ絵文字、人間は Discord アバター（無ければデフォルトアバター）
function slotIcon(slot) {
  if (!slot) return null;
  if (slot.bot) return slot.icon || null;
  const u = slot.user || {};
  if (u.avatar && u.id) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`;
  if (u.id && /^\d+$/.test(String(u.id))) {
    const idx = Number((BigInt(u.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  return null;
}

function filledSeats(room) {
  const out = [];
  room.slots.forEach((slot, seat) => { if (slot) out.push(seat); });
  return out;
}

function destroyRoom(room) {
  for (const key of ['botTimer', 'callTimer', 'roundTimer', 'waitingTimer', 'finishedTimer']) {
    if (room[key]) clearTimeout(room[key]);
  }
  for (const t of room.graceTimers.values()) clearTimeout(t);
  room.graceTimers.clear();
  rooms.delete(room.code);
  for (const slot of room.slots) {
    if (slot && slot.ws) slot.ws.mahjong = null;
  }
}

function expireWaitingRoom(room) {
  room.waitingTimer = null;
  if (!rooms.has(room.code) || room.phase !== 'lobby') return;
  if (room.hooks && typeof room.hooks.onExpire === 'function') {
    Promise.resolve().then(() => room.hooks.onExpire(room)).catch((e) => console.error('[Mahjong] onExpire:', e.message));
  }
  for (const slot of room.slots) {
    if (slot && !slot.bot && slot.ws) send(slot.ws, { type: 'room_expired' });
  }
  destroyRoom(room);
}

function makeRoom({ mode, createdVia, hooks = null }) {
  return {
    code: null, mode, createdVia, hooks,
    slots: new Array(MAX_PLAYERS).fill(null),
    hostSeat: 0, hostId: null,
    length: 'east',
    phase: 'lobby', // 'lobby' | 'playing' | 'finished'
    match: null,
    playerSeats: [], // 対局の席番号（=スロット番号。三麻は3席固定でスロットと一致）
    firstDealer: 0,
    rematchOffers: new Set(),
    graceTimers: new Map(),
    botTimer: null, callTimer: null, roundTimer: null,
    waitingTimer: null, finishedTimer: null,
    startedOnce: false,
    callObj: null, // 応答ウィンドウの同一性チェック用（call オブジェクト参照）
  };
}

function createRoom({ mode = 'bot', hostId, hostName, hooks = null, ttlMs = WAITING_TTL_MS, length = 'east' } = {}) {
  if (hostId == null || hostId === '') return null;
  if (rooms.size >= MAX_ROOMS) return null;
  const code = newCode();
  if (!code) return null;
  const m = mode === 'human' ? 'human' : 'bot';
  const room = makeRoom({ mode: m, createdVia: 'discord', hooks });
  room.code = code;
  room.hostId = String(hostId);
  room.length = length === 'south' ? 'south' : 'east';
  room.slots[0] = { ws: null, user: { id: String(hostId), name: sanitizeName(hostName), guest: false }, bot: false };
  if (m === 'bot') {
    room.slots[1] = botSlot('Bot 1');
    room.slots[2] = botSlot('Bot 2');
  }
  room.waitingTimer = setTimeout(() => expireWaitingRoom(room), ttlMs);
  room.waitingTimer.unref?.();
  rooms.set(code, room);
  return room;
}

function inviteUrl(code) {
  return `${baseUrl() || FALLBACK_BASE_URL}/play/mahjong?room=${code}`;
}

function attach(server, { verifyToken = null } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* ignore */ }
    if (pathname !== WS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function resolveUser(msg) {
    if (msg && typeof msg.token === 'string' && verifyToken) {
      const user = verifyToken(msg.token);
      if (user) return { id: String(user.id), name: sanitizeName(user.name), guest: false, avatar: user.avatar || null };
    }
    return { id: null, name: sanitizeName(msg && msg.name), guest: true, avatar: null };
  }

  function broadcast(room, obj, exceptSeat = -1) {
    room.slots.forEach((slot, seat) => {
      if (!slot || slot.bot || !slot.ws || seat === exceptSeat) return;
      send(slot.ws, obj);
    });
  }

  function broadcastLobby(room) {
    const players = filledSeats(room).map((seat) => {
      const slot = room.slots[seat];
      return { seat, name: slot.user.name, bot: slot.bot, connected: Boolean(slot.ws), isHost: seat === room.hostSeat, icon: slotIcon(slot) };
    });
    room.slots.forEach((slot, seat) => {
      if (!slot || slot.bot || !slot.ws) return;
      send(slot.ws, {
        type: 'lobby', code: room.code, youSeat: seat,
        isHost: seat === room.hostSeat,
        canStart: filledSeats(room).length >= MAX_PLAYERS,
        length: room.length, players,
      });
    });
  }

  function broadcastState(room) {
    if (!room.match) return;
    const players = room.playerSeats.map((seat) => {
      const slot = room.slots[seat];
      return { name: slot.user.name, bot: slot.bot, connected: Boolean(slot.ws), icon: slotIcon(slot) };
    });
    room.playerSeats.forEach((seat) => {
      const slot = room.slots[seat];
      if (!slot || slot.bot || !slot.ws) return;
      send(slot.ws, { type: 'state', seat, players, view: game.publicView(room.match, seat) });
    });
  }

  function broadcastRematchStatus(room) {
    const agreed = [];
    const waiting = [];
    for (const seat of filledSeats(room)) {
      const slot = room.slots[seat];
      if (slot.bot || !slot.ws) continue;
      (room.rematchOffers.has(seat) ? agreed : waiting).push(slot.user.name);
    }
    broadcast(room, { type: 'rematch_status', agreed, waiting });
  }

  // ---- 対局の駆動 ----

  function seatIsAuto(room, seat) {
    const slot = room.slots[seat];
    return slot.bot || !slot.ws; // Bot 席 or 切断中の人間席は代行
  }

  function pump(room) {
    if (!rooms.has(room.code) || room.phase !== 'playing' || !room.match) return;
    const m = room.match;
    if (m.phase === 'gameEnd') { finishMatch(room); return; }
    if (m.phase === 'roundEnd') {
      if (!room.roundTimer) {
        room.roundTimer = setTimeout(() => {
          room.roundTimer = null;
          if (!rooms.has(room.code) || room.phase !== 'playing' || !room.match) return;
          game.startNextRound(room.match);
          broadcastState(room);
          pump(room);
        }, ROUND_NEXT_MS);
        room.roundTimer.unref?.();
      }
      return;
    }
    if (m.phase === 'call') { armCallWindow(room); return; }
    // phase === 'play'
    const seat = m.turn;
    if (seatIsAuto(room, seat)) {
      if (room.botTimer) return;
      room.botTimer = setTimeout(() => {
        room.botTimer = null;
        if (!rooms.has(room.code) || room.phase !== 'playing' || !room.match) return;
        if (room.match.phase !== 'play') { pump(room); return; }
        doBotPlay(room, room.match.turn);
        afterAction(room);
      }, BOT_DELAY_MS);
      room.botTimer.unref?.();
    }
  }

  function doBotPlay(room, seat) {
    const m = room.match;
    const act = game.botChoosePlay(m, seat);
    if (act.type === 'tsumo') game.applyTsumo(m, seat);
    else if (act.type === 'kan') game.applyKan(m, seat, act.tile, act.kanKind);
    else game.applyDiscard(m, seat, act.tile, { riichi: act.riichi });
  }

  // 鳴き応答ウィンドウの調停: Bot は短い遅延で応答、人間は制限時間まで待つ
  function armCallWindow(room) {
    const m = room.match;
    if (!m.call) return;
    if (room.callObj === m.call) return; // 同じウィンドウで二重に仕掛けない
    room.callObj = m.call;
    // Bot / 切断中席の応答
    for (const seat of Object.keys(m.call.options).map(Number)) {
      if (!seatIsAuto(room, seat)) continue;
      setTimeout(() => {
        if (!rooms.has(room.code) || !room.match || room.match.phase !== 'call' || room.match.call !== m.call) return;
        if (room.match.call.responses[seat] === undefined) {
          const opts = room.match.call.options[seat];
          // 代行はロンだけ拾い、鳴きはパス（切断中の席を勝手に開かせない）
          const action = room.slots[seat].bot ? game.botChooseCall(room.match, seat) : (opts.ron ? 'ron' : 'pass');
          game.applyCallResponse(room.match, seat, action);
          maybeResolveCall(room);
        }
      }, BOT_CALL_DELAY_MS).unref?.();
    }
    // 人間の制限時間
    if (room.callTimer) clearTimeout(room.callTimer);
    room.callTimer = setTimeout(() => {
      room.callTimer = null;
      if (!rooms.has(room.code) || !room.match || room.match.phase !== 'call') return;
      const call = room.match.call;
      for (const seat of Object.keys(call.options).map(Number)) {
        if (call.responses[seat] === undefined) game.applyCallResponse(room.match, seat, 'pass');
      }
      maybeResolveCall(room);
    }, CALL_TIMEOUT_MS);
    room.callTimer.unref?.();
  }

  function maybeResolveCall(room) {
    const m = room.match;
    if (!m || m.phase !== 'call' || !game.callSettled(m)) return;
    if (room.callTimer) { clearTimeout(room.callTimer); room.callTimer = null; }
    room.callObj = null;
    game.resolveCall(m);
    afterAction(room);
  }

  function afterAction(room) {
    if (!rooms.has(room.code)) return;
    broadcastState(room);
    pump(room);
  }

  function finishMatch(room) {
    room.phase = 'finished';
    room.rematchOffers.clear();
    broadcastState(room);
    if (room.finishedTimer) clearTimeout(room.finishedTimer);
    room.finishedTimer = setTimeout(() => {
      room.finishedTimer = null;
      if (rooms.has(room.code) && room.phase === 'finished') destroyRoom(room);
    }, FINISHED_KEEP_MS);
    room.finishedTimer.unref?.();
  }

  function startGame(room) {
    if (room.waitingTimer) { clearTimeout(room.waitingTimer); room.waitingTimer = null; }
    if (room.finishedTimer) { clearTimeout(room.finishedTimer); room.finishedTimer = null; }
    room.playerSeats = filledSeats(room);
    room.match = game.createMatch({ length: room.length });
    room.match.firstDealer = room.playerSeats.indexOf(room.firstDealer);
    if (room.match.firstDealer < 0) room.match.firstDealer = 0;
    room.match.dealer = room.match.firstDealer;
    room.phase = 'playing';
    room.rematchOffers.clear();
    room.callObj = null;
    game.startRound(room.match);
    broadcastState(room);
    pump(room);
    if (!room.startedOnce) {
      room.startedOnce = true;
      if (room.hooks && typeof room.hooks.onStart === 'function') {
        Promise.resolve().then(() => room.hooks.onStart(room)).catch((e) => console.error('[Mahjong] onStart:', e.message));
      }
    }
  }

  function abortIfAllHumansGone(room) {
    const anyHumanConnected = filledSeats(room).some((s) => !room.slots[s].bot && room.slots[s].ws);
    if (!anyHumanConnected && room.phase === 'playing') destroyRoom(room);
  }

  function afterSeatFreed(room) {
    if (room.phase === 'finished') {
      room.rematchOffers.clear();
      if (!room.slots[room.hostSeat]) {
        const nextHost = filledSeats(room).find((s) => !room.slots[s].bot);
        if (nextHost === undefined) { destroyRoom(room); return; }
        room.hostSeat = nextHost;
        room.hostId = room.slots[nextHost].user.id;
      }
      broadcastRematchStatus(room);
    } else if (room.phase === 'lobby') {
      broadcastLobby(room);
    }
  }

  function startGrace(room, seat) {
    stopGrace(room, seat);
    const timer = setTimeout(() => {
      room.graceTimers.delete(seat);
      if (!rooms.has(room.code)) return;
      const slot = room.slots[seat];
      if (!slot || slot.ws) return;
      if (room.phase === 'finished') {
        room.slots[seat] = null;
        afterSeatFreed(room);
      }
      // playing 中は席を Bot 代行のまま残す（対局は止めない）
    }, RECONNECT_GRACE_MS);
    timer.unref?.();
    room.graceTimers.set(seat, timer);
  }

  function stopGrace(room, seat) {
    const t = room.graceTimers.get(seat);
    if (t) { clearTimeout(t); room.graceTimers.delete(seat); }
  }

  function seatOf(ws) {
    const ref = ws.mahjong;
    if (!ref) return null;
    const room = rooms.get(ref.code);
    if (!room) return null;
    return { room, seat: ref.seat };
  }

  function tryStartRematch(room) {
    if (room.phase !== 'finished') return false;
    const connectedHumans = filledSeats(room).filter((s) => !room.slots[s].bot && room.slots[s].ws);
    if (connectedHumans.length === 0) return false;
    if (!connectedHumans.every((s) => room.rematchOffers.has(s))) return false;
    for (const seat of filledSeats(room)) {
      const slot = room.slots[seat];
      if (!slot.bot && !slot.ws) {
        stopGrace(room, seat);
        room.slots[seat] = null;
      }
    }
    // 空席は Bot で埋めて必ず3席にする
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (!room.slots[s]) room.slots[s] = botSlot(`Bot ${s + 1}`);
    }
    const seats = filledSeats(room);
    const prev = seats.indexOf(room.firstDealer);
    room.firstDealer = seats[(prev + 1) % seats.length];
    startGame(room);
    return true;
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.mahjong = null;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'create') {
        if (ws.mahjong) return send(ws, { type: 'error', message: 'すでにルームに入っています' });
        if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: '混み合っています。しばらくしてからお試しください' });
        const mode = msg.mode === 'human' ? 'human' : 'bot';
        const user = resolveUser(msg);
        if (mode === 'human' && user.guest) {
          return send(ws, { type: 'error', message: '人間同士の対戦には Discord ログインが必要です' });
        }
        const code = newCode();
        if (!code) return send(ws, { type: 'error', message: 'ルームを作れませんでした' });
        const room = makeRoom({ mode, createdVia: 'web' });
        room.code = code;
        room.hostId = user.id;
        room.length = msg.length === 'south' ? 'south' : 'east';
        room.slots[0] = { ws, user, bot: false };
        rooms.set(code, room);
        ws.mahjong = { code, seat: 0 };
        if (mode === 'bot') {
          room.slots[1] = botSlot('Bot 1');
          room.slots[2] = botSlot('Bot 2');
          send(ws, { type: 'created', code });
          startGame(room);
        } else {
          broadcastLobby(room);
        }
        return;
      }

      if (msg.type === 'join') {
        const user = resolveUser(msg);
        const code = String(msg.code ?? '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return send(ws, { type: 'error', message: 'そのルームは見つかりませんでした' });
        if (ws.mahjong && ws.mahjong.code !== code) {
          return send(ws, { type: 'error', message: 'すでに別のルームに入っています' });
        }
        if (room.mode !== 'human' && !(room.hostId && !user.guest && user.id === room.hostId)) {
          return send(ws, { type: 'error', message: 'そのルームには参加できません' });
        }
        if (user.guest) return send(ws, { type: 'error', message: '人間同士の対戦には Discord ログインが必要です' });

        const mySeat = room.slots.findIndex((s) => s && !s.bot && s.user.id === user.id);
        if (mySeat >= 0) {
          const slot = room.slots[mySeat];
          if (slot.ws && slot.ws !== ws && slot.ws.readyState === 1) {
            return send(ws, { type: 'error', message: 'すでに別の画面で参加しています' });
          }
          slot.ws = ws;
          slot.user.name = user.name;
          ws.mahjong = { code, seat: mySeat };
          stopGrace(room, mySeat);
          broadcast(room, { type: 'player_back', name: user.name }, mySeat);
          if (room.phase === 'playing' || room.phase === 'finished') {
            broadcastState(room);
            if (room.phase === 'finished') broadcastRematchStatus(room);
            pump(room);
          } else if (room.mode === 'bot') {
            startGame(room);
          } else {
            broadcastLobby(room);
          }
          return;
        }

        if (ws.mahjong) return send(ws, { type: 'error', message: 'すでにルームに入っています' });
        if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'そのルームは対局中です' });
        const emptySeat = room.slots.findIndex((s) => !s);
        if (emptySeat < 0) return send(ws, { type: 'error', message: 'そのルームは満員です' });
        room.slots[emptySeat] = { ws, user, bot: false };
        ws.mahjong = { code, seat: emptySeat };
        broadcastLobby(room);
        return;
      }

      const ctx = seatOf(ws);
      if (!ctx) {
        if (msg.type !== 'create' && msg.type !== 'join') {
          send(ws, { type: 'error', message: 'まずルームを作るか参加してください' });
        }
        return;
      }
      const { room, seat } = ctx;
      const slot = room.slots[seat];
      if (!slot || slot.ws !== ws) return;
      const m = room.match;

      if (msg.type === 'add_bot') {
        if (room.phase !== 'lobby' || room.mode !== 'human') return send(ws, { type: 'error', message: '今は Bot を追加できません' });
        if (seat !== room.hostSeat) return send(ws, { type: 'error', message: 'Bot の追加はホストだけができます' });
        const emptySeat = room.slots.findIndex((s) => !s);
        if (emptySeat < 0) return send(ws, { type: 'error', message: '席がいっぱいです' });
        const botCount = room.slots.filter((s) => s && s.bot).length;
        room.slots[emptySeat] = botSlot(`Bot ${botCount + 1}`);
        broadcastLobby(room);
        return;
      }

      if (msg.type === 'remove_bot') {
        if (room.phase !== 'lobby' || room.mode !== 'human') return send(ws, { type: 'error', message: '今は Bot を外せません' });
        if (seat !== room.hostSeat) return send(ws, { type: 'error', message: 'Bot の追加・取り外しはホストだけができます' });
        const target = room.slots[msg.seat];
        if (!target || !target.bot) return send(ws, { type: 'error', message: 'その席に Bot はいません' });
        room.slots[msg.seat] = null;
        broadcastLobby(room);
        return;
      }

      if (msg.type === 'set_length') {
        if (room.phase !== 'lobby') return;
        if (seat !== room.hostSeat) return send(ws, { type: 'error', message: '設定の変更はホストだけができます' });
        room.length = msg.length === 'south' ? 'south' : 'east';
        broadcastLobby(room);
        return;
      }

      if (msg.type === 'start') {
        if (room.phase !== 'lobby' || room.mode !== 'human') return send(ws, { type: 'error', message: '今は開始できません' });
        if (seat !== room.hostSeat) return send(ws, { type: 'error', message: '対局の開始はホストだけができます' });
        if (filledSeats(room).length < MAX_PLAYERS) {
          return send(ws, { type: 'error', message: '三麻は3席そろってから開始できます（Bot で埋めることもできます）' });
        }
        room.firstDealer = room.hostSeat;
        startGame(room);
        return;
      }

      if (msg.type === 'discard') {
        if (!m || room.phase !== 'playing') return;
        const r = game.applyDiscard(m, seat, msg.tile, { riichi: Boolean(msg.riichi) });
        if (!r.ok) return send(ws, { type: 'error', message: r.reason });
        afterAction(room);
        return;
      }

      if (msg.type === 'tsumo') {
        if (!m || room.phase !== 'playing') return;
        const r = game.applyTsumo(m, seat);
        if (!r.ok) return send(ws, { type: 'error', message: r.reason });
        afterAction(room);
        return;
      }

      if (msg.type === 'kan') {
        if (!m || room.phase !== 'playing') return;
        const r = game.applyKan(m, seat, msg.tile, msg.kanKind);
        if (!r.ok) return send(ws, { type: 'error', message: r.reason });
        afterAction(room);
        return;
      }

      if (msg.type === 'call_response') {
        if (!m || room.phase !== 'playing' || m.phase !== 'call') return;
        if (m.call.responses[seat] !== undefined) return;
        const r = game.applyCallResponse(m, seat, msg.action);
        if (!r.ok) return send(ws, { type: 'error', message: r.reason });
        broadcastState(room); // 応答したことを表示に反映（ボタンを消す）
        maybeResolveCall(room);
        return;
      }

      if (msg.type === 'rematch') {
        if (room.phase !== 'finished') return send(ws, { type: 'error', message: '対局が終わってから押してください' });
        if (room.mode === 'bot') {
          const seats = filledSeats(room);
          const prev = seats.indexOf(room.firstDealer);
          room.firstDealer = seats[(prev + 1) % seats.length];
          startGame(room);
          return;
        }
        room.rematchOffers.add(seat);
        broadcastRematchStatus(room);
        tryStartRematch(room);
        return;
      }

      if (msg.type === 'rematch_decline') {
        if (room.phase !== 'finished') return;
        const byName = slot.user.name;
        room.rematchOffers.clear();
        broadcast(room, { type: 'rematch_declined', byName });
        broadcastRematchStatus(room);
        return;
      }

      if (msg.type === 'leave') {
        ws.mahjong = null;
        slot.ws = null;
        if (room.phase === 'playing') {
          // 対局は止めない: 席は Bot 代行になり、リンクから戻ってこられる
          broadcast(room, { type: 'player_disconnected', name: slot.user.name }, seat);
          startGrace(room, seat);
          pump(room);
          abortIfAllHumansGone(room);
          return;
        }
        if (room.phase === 'lobby') {
          if (seat === room.hostSeat) {
            broadcast(room, { type: 'room_closed', message: 'ホストが退出したため、ルームは解散しました。' }, seat);
            destroyRoom(room);
          } else {
            room.slots[seat] = null;
            broadcastLobby(room);
          }
          return;
        }
        room.slots[seat] = null;
        room.rematchOffers.delete(seat);
        afterSeatFreed(room);
        return;
      }
    });

    ws.on('close', () => {
      const ctx = seatOf(ws);
      if (!ctx) return;
      const { room, seat } = ctx;
      const slot = room.slots[seat];
      if (!slot || slot.ws !== ws) return;
      slot.ws = null;
      ws.mahjong = null;

      if (room.mode === 'bot') { destroyRoom(room); return; }
      if (room.phase === 'lobby') {
        if (seat === room.hostSeat) {
          broadcast(room, { type: 'room_closed', message: 'ホストが退出したため、ルームは解散しました。' }, seat);
          destroyRoom(room);
        } else {
          room.slots[seat] = null;
          broadcastLobby(room);
        }
        return;
      }
      if (room.phase === 'playing') {
        broadcast(room, { type: 'player_disconnected', name: slot.user.name }, seat);
        startGrace(room, seat);
        pump(room);
        abortIfAllHumansGone(room);
        return;
      }
      startGrace(room, seat);
    });

    ws.on('error', (e) => console.error('[Mahjong] WebSocketエラー:', e.message));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
    }
  }, 30_000);
  heartbeat.unref?.();

  console.log(`[Mahjong] Web版三人麻雀の対局サーバーを ${WS_PATH} に用意しました。`);
  return wss;
}

module.exports = { attach, WS_PATH, rooms, createRoom, inviteUrl, WAITING_TTL_MS, MAX_PLAYERS };
