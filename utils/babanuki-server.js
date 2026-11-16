'use strict';

// Web版ババ抜きの対局サーバー（WebSocket）
//
// ・既存の Express サーバー（index.js の app.listen の戻り値）に相乗りする（utils/agent-bridge.js と同じ型）
// ・対局中のルーム状態はメモリ内のみ。再起動で消える前提で、確定した勝敗だけ
//   utils/babanuki-records.js に保存する（決定シートの吸収策どおり）
// ・人間同士は Discord ログイン必須。ログイン確認は web.js が発行する短命トークンを
//   verifyToken で検証するだけ（認証そのものは既存の Discord OAuth を流用）
// ・Bot 戦は未ログイン（ゲスト）でも遊べる。ゲストの結果は記録しない
// ・切断時は 60 秒の再接続猶予を置く（シートの「切断時の再接続で復帰」）。Bot 戦は即終了
//
// クライアント→サーバーのメッセージ:
//   { type: 'create', mode: 'bot'|'human', token?, name? }
//   { type: 'join', code, token?, name? }
//   { type: 'draw', position }
//   { type: 'rematch' }   // Bot戦=即開始 / 人間同士=申し込み、相手が送ると承諾になる
//   { type: 'rematch_decline' }
//   { type: 'leave' }
// サーバー→クライアントのメッセージ:
//   { type: 'created', code } / { type: 'waiting', code }
//   { type: 'state', seat, opponentName, view }  // view は utils/babanuki-core.js の publicView
//   { type: 'rematch_offer', fromName } / { type: 'rematch_declined' }
//   { type: 'opponent_disconnected', graceSec } / { type: 'opponent_left' }
//   { type: 'room_expired' }  // 待機ルームの有効期限切れ
//   { type: 'error', message }
//
// Discord コマンド（同一プロセス）からのルーム作成:
//   createRoom({ mode, hostId, hostName, hooks }) → room | null
//   ホストはまだ接続していない席（slots[0]）として記録され、ホスト本人がログイン済みで
//   join してきたらホスト席に着く。対局が始まらないまま WAITING_TTL_MS が過ぎると
//   ルームは破棄される（hooks.onExpire があれば呼ばれる）。
//   hooks.onStart は対局が初めて始まったときに1回だけ呼ばれる（自動投稿の編集用）。

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const core = require('./babanuki-core.js');
const records = require('./babanuki-records.js');
const { baseUrl } = require('./notify/common.js');

const WS_PATH = '/play/babanuki/ws';
const RECONNECT_GRACE_MS = 60_000;
const WAITING_TTL_MS = 10 * 60 * 1000; // Discord経由の待機ルームの有効期限（他ゲームの無操作タイムアウトと同程度）
const BOT_DELAY_MS = 900;
const MAX_ROOMS = 200;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい文字（I/L/O/0/1）は除く
const FALLBACK_BASE_URL = 'https://uyuyu-bot.onrender.com'; // commands/utility/info.js と同じ公式サイトURL

const rooms = new Map(); // code -> room

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
    try { ws.send(JSON.stringify(obj)); } catch { /* 切断直後の送信失敗は無視 */ }
  }
}

function destroyRoom(room) {
  if (room.graceTimer) clearTimeout(room.graceTimer);
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.waitingTimer) clearTimeout(room.waitingTimer);
  rooms.delete(room.code);
  for (const slot of room.slots) {
    if (slot && slot.ws) {
      slot.ws.babanuki = null;
    }
  }
}

// 待機ルームの有効期限切れ: 対局が始まっていないルームを畳む
function expireWaitingRoom(room) {
  room.waitingTimer = null;
  if (!rooms.has(room.code) || room.state) return;
  if (room.hooks && typeof room.hooks.onExpire === 'function') {
    Promise.resolve()
      .then(() => room.hooks.onExpire(room))
      .catch((e) => console.error('[Babanuki] onExpire フックでエラー:', e.message));
  }
  for (const slot of room.slots) {
    if (slot && !slot.bot && slot.ws) send(slot.ws, { type: 'room_expired' });
  }
  destroyRoom(room);
}

// Discord コマンドからルームを作る。ホスト席（seat 0）は「ホストIDだけ記録された未接続の席」で、
// ホスト本人がサイトで Discord ログインして join すると着席する。戻り値は room（作れなければ null）
function createRoom({ mode = 'bot', hostId, hostName, hooks = null, ttlMs = WAITING_TTL_MS } = {}) {
  if (hostId == null || hostId === '') return null;
  if (rooms.size >= MAX_ROOMS) return null;
  const code = newCode();
  if (!code) return null;
  const m = mode === 'human' ? 'human' : 'bot';
  const room = {
    code,
    mode: m,
    slots: [{ ws: null, user: { id: String(hostId), name: sanitizeName(hostName), guest: false }, bot: false }, null],
    state: null,
    firstPlayer: 0,
    rematchOfferBy: null,
    graceTimer: null,
    botTimer: null,
    recorded: false,
    hostId: String(hostId),
    createdVia: 'discord',
    hooks,
    startedOnce: false,
    waitingTimer: null,
  };
  if (m === 'bot') {
    room.slots[1] = { ws: null, user: { id: records.BOT_ID, name: 'Bot', guest: false }, bot: true };
  }
  room.waitingTimer = setTimeout(() => expireWaitingRoom(room), ttlMs);
  room.waitingTimer.unref?.();
  rooms.set(code, room);
  return room;
}

// 招待リンクのURL。ベースURLは notify と同じ流儀（PUBLIC_BASE_URL / CALLBACK_URL）で、
// 取れなければ公式サイトのURL（commands/utility/info.js と同じ値）を使う
function inviteUrl(code) {
  return `${baseUrl() || FALLBACK_BASE_URL}/play/babanuki?room=${code}`;
}

function attach(server, { verifyToken = null } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* 不正なURLは無視 */ }
    if (pathname !== WS_PATH) return; // 他の upgrade（/agent など）は触らない
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // トークンがあれば Discord ログイン済みの本人として、無ければゲストとして扱う
  function resolveUser(msg) {
    if (msg && typeof msg.token === 'string' && verifyToken) {
      const user = verifyToken(msg.token);
      if (user) return { id: String(user.id), name: sanitizeName(user.name), guest: false };
    }
    return { id: null, name: sanitizeName(msg && msg.name), guest: true };
  }

  function broadcastState(room) {
    room.slots.forEach((slot, seat) => {
      if (!slot || slot.bot || !slot.ws) return;
      const opp = room.slots[1 - seat];
      send(slot.ws, {
        type: 'state',
        seat,
        opponentName: opp ? opp.user.name : '',
        view: core.publicView(room.state, seat),
      });
    });
  }

  function recordResult(room) {
    if (room.recorded || !room.state || room.state.winner === null) return;
    room.recorded = true;
    const winnerSlot = room.slots[room.state.winner];
    const loserSlot = room.slots[1 - room.state.winner];
    if (!winnerSlot || !loserSlot) return;
    // 記録するのはログイン済みプレイヤーの結果だけ（ゲスト・Bot 自身は戦績を持たない）
    const involved = [winnerSlot, loserSlot].filter((s) => !s.bot && !s.user.guest);
    if (room.mode === 'human' && involved.length < 2) return;
    if (room.mode === 'bot' && involved.length < 1) return;
    records.recordMatch({
      winner: { id: winnerSlot.bot ? records.BOT_ID : winnerSlot.user.id, name: winnerSlot.user.name },
      loser: { id: loserSlot.bot ? records.BOT_ID : loserSlot.user.id, name: loserSlot.user.name },
      vsBot: room.mode === 'bot',
    });
  }

  function startGame(room) {
    if (room.waitingTimer) { clearTimeout(room.waitingTimer); room.waitingTimer = null; }
    room.state = core.createGame({ firstPlayer: room.firstPlayer });
    room.rematchOfferBy = null;
    room.recorded = false;
    broadcastState(room);
    maybeBotTurn(room);
    if (!room.startedOnce) {
      room.startedOnce = true;
      if (room.hooks && typeof room.hooks.onStart === 'function') {
        Promise.resolve()
          .then(() => room.hooks.onStart(room))
          .catch((e) => console.error('[Babanuki] onStart フックでエラー:', e.message));
      }
    }
  }

  // 必要な席がそろっていれば対局を始める（Discord経由のルームはホストと相手の到着順が不定なため）
  function maybeStart(room) {
    if (room.state) return false;
    const host = room.slots[0];
    if (!host || !host.ws) return false;
    if (room.mode === 'human') {
      const opp = room.slots[1];
      if (!opp || !opp.ws) return false;
    }
    startGame(room);
    return true;
  }

  function maybeBotTurn(room) {
    if (room.mode !== 'bot' || !room.state || room.state.winner !== null) return;
    if (room.state.turn !== 1) return; // Bot は常に seat 1
    if (room.botTimer) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (!rooms.has(room.code) || !room.state || room.state.winner !== null) return;
      const pos = core.chooseBotPosition(room.state.hands[0].length);
      const result = core.drawCard(room.state, pos);
      if (!result.ok) return;
      if (room.state.winner !== null) recordResult(room);
      broadcastState(room);
    }, BOT_DELAY_MS);
  }

  function applyDraw(room, seat, position) {
    if (!room.state) return { ok: false, reason: '対局が始まっていません' };
    if (room.state.winner !== null) return { ok: false, reason: '対局は終了しています' };
    if (room.state.turn !== seat) return { ok: false, reason: 'あなたの番ではありません' };
    const result = core.drawCard(room.state, position);
    if (!result.ok) return result;
    if (room.state.winner !== null) recordResult(room);
    broadcastState(room);
    maybeBotTurn(room);
    return result;
  }

  function seatOf(ws) {
    const ref = ws.babanuki;
    if (!ref) return null;
    const room = rooms.get(ref.code);
    if (!room) return null;
    return { room, seat: ref.seat };
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.babanuki = null;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'create') {
        if (ws.babanuki) return send(ws, { type: 'error', message: 'すでにルームに入っています' });
        if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: '混み合っています。しばらくしてからお試しください' });
        const mode = msg.mode === 'human' ? 'human' : 'bot';
        const user = resolveUser(msg);
        if (mode === 'human' && user.guest) {
          return send(ws, { type: 'error', message: '人間同士の対戦には Discord ログインが必要です' });
        }
        const code = newCode();
        if (!code) return send(ws, { type: 'error', message: 'ルームを作れませんでした' });
        const room = {
          code,
          mode,
          slots: [{ ws, user, bot: false }, null],
          state: null,
          firstPlayer: 0,
          rematchOfferBy: null,
          graceTimer: null,
          botTimer: null,
          recorded: false,
          hostId: null,
          createdVia: 'web',
          hooks: null,
          startedOnce: false,
          waitingTimer: null,
        };
        rooms.set(code, room);
        ws.babanuki = { code, seat: 0 };
        if (mode === 'bot') {
          room.slots[1] = { ws: null, user: { id: records.BOT_ID, name: 'Bot', guest: false }, bot: true };
          send(ws, { type: 'created', code });
          startGame(room);
        } else {
          send(ws, { type: 'waiting', code });
        }
        return;
      }

      if (msg.type === 'join') {
        const user = resolveUser(msg);
        const code = String(msg.code ?? '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return send(ws, { type: 'error', message: 'そのルームは見つかりませんでした' });

        // Discordコマンドで作られたルームのホスト席: ホスト本人がログイン済みで接続したら着席する
        // （Bot戦ルームにも入れるのはホスト本人だけ）
        if (room.hostId && !user.guest && user.id === room.hostId) {
          const slot = room.slots[0];
          if (slot.ws && slot.ws !== ws && slot.ws.readyState === 1) {
            return send(ws, { type: 'error', message: 'すでに別の画面で参加しています' });
          }
          if (ws.babanuki && ws.babanuki.code !== code) {
            return send(ws, { type: 'error', message: 'すでに別のルームに入っています' });
          }
          slot.ws = ws;
          slot.user.name = user.name;
          ws.babanuki = { code, seat: 0 };
          if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
          const opp = room.slots[1];
          if (opp && opp.ws) send(opp.ws, { type: 'opponent_back' });
          if (room.state) broadcastState(room);
          else if (!maybeStart(room)) send(ws, { type: 'waiting', code });
          return;
        }

        if (room.mode !== 'human') return send(ws, { type: 'error', message: 'そのルームには参加できません' });
        if (user.guest) return send(ws, { type: 'error', message: '人間同士の対戦には Discord ログインが必要です' });

        // 再接続: 自分の席が残っていれば取り戻す
        const mySeat = room.slots.findIndex((s) => s && !s.bot && s.user.id === user.id);
        if (mySeat >= 0) {
          const slot = room.slots[mySeat];
          if (slot.ws && slot.ws !== ws && slot.ws.readyState === 1) {
            return send(ws, { type: 'error', message: 'すでに別の画面で参加しています' });
          }
          if (ws.babanuki && ws.babanuki.code !== code) {
            return send(ws, { type: 'error', message: 'すでに別のルームに入っています' });
          }
          slot.ws = ws;
          slot.user.name = user.name;
          ws.babanuki = { code, seat: mySeat };
          if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
          const opp = room.slots[1 - mySeat];
          if (opp && opp.ws) send(opp.ws, { type: 'opponent_back' });
          if (room.state) broadcastState(room);
          else if (!maybeStart(room)) send(ws, { type: 'waiting', code });
          return;
        }

        if (ws.babanuki) return send(ws, { type: 'error', message: 'すでにルームに入っています' });
        if (room.slots[1]) return send(ws, { type: 'error', message: 'そのルームは満員です' });
        room.slots[1] = { ws, user, bot: false };
        ws.babanuki = { code, seat: 1 };
        // Discord経由のルームでホストがまだ来ていない場合は、ホストの到着を待つ
        if (!maybeStart(room)) send(ws, { type: 'waiting', code });
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

      if (msg.type === 'draw') {
        const result = applyDraw(room, seat, msg.position);
        if (!result.ok) send(ws, { type: 'error', message: result.reason });
        return;
      }

      if (msg.type === 'rematch') {
        if (!room.state || room.state.winner === null) {
          return send(ws, { type: 'error', message: '対局が終わってから押してください' });
        }
        if (room.mode === 'bot') {
          room.firstPlayer = 1 - room.firstPlayer; // 再戦では先手・後手を入れ替える
          startGame(room);
          return;
        }
        const opp = room.slots[1 - seat];
        if (!opp || !opp.ws) return send(ws, { type: 'error', message: '相手が接続していません' });
        if (room.rematchOfferBy === 1 - seat) {
          room.firstPlayer = 1 - room.firstPlayer;
          startGame(room);
        } else if (room.rematchOfferBy === seat) {
          // 自分の申し込み済み。二重送信は無視
        } else {
          room.rematchOfferBy = seat;
          send(opp.ws, { type: 'rematch_offer', fromName: room.slots[seat].user.name });
          send(ws, { type: 'rematch_sent' });
        }
        return;
      }

      if (msg.type === 'rematch_decline') {
        if (room.rematchOfferBy === 1 - seat) {
          room.rematchOfferBy = null;
          const opp = room.slots[1 - seat];
          if (opp && opp.ws) send(opp.ws, { type: 'rematch_declined' });
        }
        return;
      }

      if (msg.type === 'leave') {
        const opp = room.slots[1 - seat];
        destroyRoom(room);
        if (opp && opp.ws) send(opp.ws, { type: 'opponent_left' });
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
      ws.babanuki = null;

      if (room.mode === 'bot') {
        destroyRoom(room);
        return;
      }
      // 対局開始前（相手待ち）の切断はルームを畳む
      if (!room.state) {
        const opp = room.slots[1 - seat];
        destroyRoom(room);
        if (opp && opp.ws) send(opp.ws, { type: 'opponent_left' });
        return;
      }
      // 対局中: 再接続の猶予を置く。相手には切断を知らせる
      const opp = room.slots[1 - seat];
      if (opp && opp.ws) {
        send(opp.ws, { type: 'opponent_disconnected', graceSec: Math.round(RECONNECT_GRACE_MS / 1000) });
      }
      if (room.graceTimer) clearTimeout(room.graceTimer);
      room.graceTimer = setTimeout(() => {
        room.graceTimer = null;
        const other = room.slots[1 - seat];
        destroyRoom(room);
        if (other && other.ws) send(other.ws, { type: 'opponent_left' });
      }, RECONNECT_GRACE_MS);
      room.graceTimer.unref?.();
    });

    ws.on('error', (e) => console.error('[Babanuki] WebSocketエラー:', e.message));
  });

  // 生存確認（プロキシのアイドル切断対策も兼ねる。agent-bridge と同じ流儀）
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
    }
  }, 30_000);
  heartbeat.unref?.();

  console.log(`[Babanuki] Web版ババ抜きの対局サーバーを ${WS_PATH} に用意しました。`);
  return wss;
}

module.exports = { attach, WS_PATH, rooms, createRoom, inviteUrl, WAITING_TTL_MS };
