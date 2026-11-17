'use strict';

// Web版ババ抜きの対局サーバー（WebSocket）v2: 最大4人の多人数対応
//
// ・既存の Express サーバー（index.js の app.listen の戻り値）に相乗りする（utils/agent-bridge.js と同じ型）
// ・対局中のルーム状態はメモリ内のみ。再起動で消える前提で、確定した順位だけ
//   utils/babanuki-records.js に保存する（決定シートの吸収策どおり）
// ・人間同士のルームは Discord ログイン必須。ログイン確認は web.js が発行する短命トークンを
//   verifyToken で検証するだけ（認証そのものは既存の Discord OAuth を流用）
// ・Bot 戦（1人＋Bot の即対戦）は未ログイン（ゲスト）でも遊べる。ゲストの結果は記録しない
// ・切断時は 60 秒の再接続猶予を置く。Bot 戦は即終了
//
// ルームの流れ:
//   待機（lobby）: ホストがリンクで人を集める（最大4人）。ホストは空き席への Bot 追加と
//                  対局開始（2人以上）ができる。参加者はいつでも退出できる。
//                  ホストが退出・切断したらルームは解散する。
//   対局（playing）: 時計回りに、次の未上がりプレイヤーから引く。Bot 席は自動で引く。
//                  対局中の退出・切断（猶予切れ）は対局を中断し、結果は記録しない
//                  （抜けた人のカードを場から外すとペアが成立しなくなり対局が詰むため、
//                   v1 の「相手が抜けたら対局終了」を多人数でも踏襲する最小解釈）。
//   終了（finished）: 順位を表示。再戦は「接続中の人間全員の承諾」で開始し、
//                  切断中の席は次の対局から外れる。人数が2人を下回ったら待機に戻る。
//
// クライアント→サーバーのメッセージ:
//   { type: 'create', mode: 'bot'|'human', token?, name? }
//        bot = 1人＋Bot の即対戦（従来どおり） / human = 待機ルームを開く
//   { type: 'join', code, token?, name? }
//   { type: 'add_bot' }              // 待機中・ホストのみ
//   { type: 'remove_bot', seat }     // 待機中・ホストのみ
//   { type: 'start' }                // 待機中・ホストのみ（2人以上で開始）
//   { type: 'draw', position }
//   { type: 'rematch' }   // Bot戦=即開始 / 人間ルーム=承諾（全員分そろうと開始）
//   { type: 'rematch_decline' }
//   { type: 'leave' }
// サーバー→クライアントのメッセージ:
//   { type: 'created', code }                          // Bot戦ルーム作成（この直後に state が来る）
//   { type: 'lobby', code, youSeat, isHost, canStart, players: [{ seat, name, bot, connected, isHost }] }
//   { type: 'state', seat, players: [{ name, bot, connected }], view }
//        seat と players の添字は対局内のプレイヤー番号（着席順）。view は core の publicView
//   { type: 'rematch_status', agreed: [name], waiting: [name] } / { type: 'rematch_declined', byName }
//   { type: 'player_disconnected', name, graceSec } / { type: 'player_back', name }
//   { type: 'game_aborted', message }  // 対局中の退出・切断で対局が中断した
//   { type: 'room_closed', message }   // 待機中にホストが抜けてルームが解散した
//   { type: 'room_expired' }           // 待機ルームの有効期限切れ
//   { type: 'error', message }
//
// Discord コマンド（同一プロセス）からのルーム作成:
//   createRoom({ mode, hostId, hostName, hooks }) → room | null
//   ホストはまだ接続していない席（slots[0]）として記録され、ホスト本人がログイン済みで
//   join してきたらホスト席に着く。対局が始まらないまま WAITING_TTL_MS が過ぎると
//   ルームは破棄される（hooks.onExpire があれば呼ばれる）。
//   hooks.onStart は対局が初めて始まったときに1回だけ呼ばれる（自動投稿の編集用）。
//   mode 'human' は待機ルーム（最大4人）、mode 'bot' はホスト専用の即Bot戦ルーム。

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const core = require('./babanuki-core.js');
const records = require('./babanuki-records.js');
const gachaCollection = require('./gacha-collection.js');
const { baseUrl } = require('./notify/common.js');

const WS_PATH = '/play/babanuki/ws';
const RECONNECT_GRACE_MS = 60_000;
const WAITING_TTL_MS = 10 * 60 * 1000; // Discord経由の待機ルームの有効期限（他ゲームの無操作タイムアウトと同程度）
const BOT_DELAY_MS = 900;
const MAX_ROOMS = 200;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const FINISHED_KEEP_MS = 10 * 60 * 1000; // 終了したルームを掃除するまでの猶予
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

function botSlot(name) {
  return { ws: null, user: { id: records.BOT_ID, name, guest: false }, bot: true };
}

function filledSeats(room) {
  const out = [];
  room.slots.forEach((slot, seat) => { if (slot) out.push(seat); });
  return out;
}

function destroyRoom(room) {
  if (room.botTimer) clearTimeout(room.botTimer);
  if (room.waitingTimer) clearTimeout(room.waitingTimer);
  if (room.finishedTimer) clearTimeout(room.finishedTimer);
  for (const t of room.graceTimers.values()) clearTimeout(t);
  room.graceTimers.clear();
  rooms.delete(room.code);
  for (const slot of room.slots) {
    if (slot && slot.ws) slot.ws.babanuki = null;
  }
}

// 待機ルームの有効期限切れ: 対局が始まっていないルームを畳む
function expireWaitingRoom(room) {
  room.waitingTimer = null;
  if (!rooms.has(room.code) || room.phase !== 'lobby') return;
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

function makeRoom({ mode, createdVia, hooks = null }) {
  return {
    code: null,
    mode, // 'bot' = 1人＋Botの即対戦 / 'human' = 待機ルーム（Bot追加可）
    slots: new Array(MAX_PLAYERS).fill(null), // 席（人間 / Bot / 空き）
    hostSeat: 0,
    hostId: null,
    createdVia,
    hooks,
    phase: 'lobby', // 'lobby' | 'playing' | 'finished'
    state: null,
    playerSeats: [], // 対局内のプレイヤー番号 → 席番号
    firstSeat: 0, // 次の対局で最初に引く席
    rematchOffers: new Set(), // 再戦に承諾した席
    graceTimers: new Map(), // 席 → 再接続猶予のタイマー
    botTimer: null,
    waitingTimer: null,
    finishedTimer: null,
    recorded: false,
    startedOnce: false,
  };
}

// Discord コマンドからルームを作る。ホスト席（seat 0）は「ホストIDだけ記録された未接続の席」で、
// ホスト本人がサイトで Discord ログインして join すると着席する。戻り値は room（作れなければ null）
function createRoom({ mode = 'bot', hostId, hostName, hooks = null, ttlMs = WAITING_TTL_MS } = {}) {
  if (hostId == null || hostId === '') return null;
  if (rooms.size >= MAX_ROOMS) return null;
  const code = newCode();
  if (!code) return null;
  const m = mode === 'human' ? 'human' : 'bot';
  const room = makeRoom({ mode: m, createdVia: 'discord', hooks });
  room.code = code;
  room.hostId = String(hostId);
  room.slots[0] = { ws: null, user: { id: String(hostId), name: sanitizeName(hostName), guest: false }, bot: false };
  if (m === 'bot') {
    room.slots[1] = botSlot('Bot');
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

  function broadcast(room, obj, exceptSeat = -1) {
    room.slots.forEach((slot, seat) => {
      if (!slot || slot.bot || !slot.ws || seat === exceptSeat) return;
      send(slot.ws, obj);
    });
  }

  function broadcastLobby(room) {
    const players = filledSeats(room).map((seat) => {
      const slot = room.slots[seat];
      return {
        seat,
        name: slot.user.name,
        bot: slot.bot,
        connected: Boolean(slot.ws),
        isHost: seat === room.hostSeat,
      };
    });
    room.slots.forEach((slot, seat) => {
      if (!slot || slot.bot || !slot.ws) return;
      send(slot.ws, {
        type: 'lobby',
        code: room.code,
        youSeat: seat,
        isHost: seat === room.hostSeat,
        canStart: filledSeats(room).length >= MIN_PLAYERS,
        players,
      });
    });
  }

  function broadcastState(room) {
    if (!room.state) return;
    const players = room.playerSeats.map((seat) => {
      const slot = room.slots[seat];
      return { name: slot.user.name, bot: slot.bot, connected: Boolean(slot.ws) };
    });
    room.playerSeats.forEach((seat, idx) => {
      const slot = room.slots[seat];
      if (!slot || slot.bot || !slot.ws) return;
      send(slot.ws, {
        type: 'state',
        seat: idx,
        players,
        view: core.publicView(room.state, idx),
      });
    });
  }

  function broadcastRematchStatus(room) {
    const agreed = [];
    const waiting = [];
    for (const seat of filledSeats(room)) {
      const slot = room.slots[seat];
      if (slot.bot || !slot.ws) continue; // Bot は常時承諾扱い、切断中の席は対象外
      (room.rematchOffers.has(seat) ? agreed : waiting).push(slot.user.name);
    }
    broadcast(room, { type: 'rematch_status', agreed, waiting });
  }

  function recordResult(room) {
    if (room.recorded || !room.state || room.state.placements === null) return;
    room.recorded = true;
    const results = room.playerSeats.map((seat, idx) => {
      const slot = room.slots[seat];
      return {
        id: slot.bot ? records.BOT_ID : slot.user.id,
        name: slot.user.name,
        place: room.state.placements[idx],
        bot: slot.bot,
        guest: !slot.bot && slot.user.guest,
      };
    });
    records.recordResult({ results, vsBot: results.some((r) => r.bot) });
    // ガチャ図鑑の条件ドロップ（uyuyu_take）用：1位が人間のログイン済みユーザーなら「本日の勝利者」として記録する
    const first = results.find((r) => r.place === 1);
    if (first && !first.bot && !first.guest) {
      try {
        gachaCollection.markWin(first.id);
      } catch (err) {
        console.error('[babanuki] ガチャ勝利記録エラー:', err);
      }
    }
  }

  function finishGame(room) {
    room.phase = 'finished';
    room.rematchOffers.clear();
    recordResult(room);
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
    let firstIdx = room.playerSeats.indexOf(room.firstSeat);
    if (firstIdx < 0) firstIdx = 0;
    room.state = core.createGame({ playerCount: room.playerSeats.length, firstPlayer: firstIdx });
    room.phase = 'playing';
    room.rematchOffers.clear();
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
    // 配った時点で決着している（実質あり得ないが）場合の保険
    if (room.state.placements !== null) finishGame(room);
  }

  function maybeBotTurn(room) {
    if (room.phase !== 'playing' || !room.state || room.state.placements !== null) return;
    const seat = room.playerSeats[room.state.turn];
    const slot = room.slots[seat];
    if (!slot || !slot.bot) return;
    if (room.botTimer) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (!rooms.has(room.code) || room.phase !== 'playing' || !room.state || room.state.placements !== null) return;
      const target = core.drawTarget(room.state);
      if (target === null) return;
      const pos = core.chooseBotPosition(room.state.hands[target].length);
      const result = core.drawCard(room.state, pos);
      if (!result.ok) return;
      if (room.state.placements !== null) finishGame(room);
      else {
        broadcastState(room);
        maybeBotTurn(room);
      }
    }, BOT_DELAY_MS);
    room.botTimer.unref?.();
  }

  function applyDraw(room, seat, position) {
    if (room.phase !== 'playing' || !room.state) return { ok: false, reason: '対局が始まっていません' };
    if (room.state.placements !== null) return { ok: false, reason: '対局は終了しています' };
    const idx = room.playerSeats.indexOf(seat);
    if (idx < 0 || room.state.turn !== idx) return { ok: false, reason: 'あなたの番ではありません' };
    const result = core.drawCard(room.state, position);
    if (!result.ok) return result;
    if (room.state.placements !== null) finishGame(room);
    else {
      broadcastState(room);
      maybeBotTurn(room);
    }
    return result;
  }

  // 対局中の中途離脱（退出／猶予切れ）: 対局を中断してルームを畳む（記録しない）
  function abortGame(room, leaverName) {
    broadcast(room, {
      type: 'game_aborted',
      message: `${leaverName} さんが抜けたため、対局を終了しました。結果は記録されません。`,
    });
    destroyRoom(room);
  }

  // 終了フェーズで席が空いたときの後始末（ホストの繰り上げ等）
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
      if (room.phase === 'playing') {
        abortGame(room, slot.user.name);
      } else if (room.phase === 'finished') {
        room.slots[seat] = null;
        afterSeatFreed(room);
      }
    }, RECONNECT_GRACE_MS);
    timer.unref?.();
    room.graceTimers.set(seat, timer);
  }

  function stopGrace(room, seat) {
    const t = room.graceTimers.get(seat);
    if (t) { clearTimeout(t); room.graceTimers.delete(seat); }
  }

  function seatOf(ws) {
    const ref = ws.babanuki;
    if (!ref) return null;
    const room = rooms.get(ref.code);
    if (!room) return null;
    return { room, seat: ref.seat };
  }

  // 再戦の開始条件を満たしたら次の対局を始める（接続中の人間全員の承諾制）
  function tryStartRematch(room) {
    if (room.phase !== 'finished') return false;
    const connectedHumans = filledSeats(room).filter((s) => !room.slots[s].bot && room.slots[s].ws);
    if (connectedHumans.length === 0) return false;
    if (!connectedHumans.every((s) => room.rematchOffers.has(s))) return false;
    // 切断中の人間の席は次の対局から外す
    for (const seat of filledSeats(room)) {
      const slot = room.slots[seat];
      if (!slot.bot && !slot.ws) {
        stopGrace(room, seat);
        room.slots[seat] = null;
      }
    }
    if (filledSeats(room).length < MIN_PLAYERS) {
      // 人数が足りなくなったら待機に戻る
      room.phase = 'lobby';
      room.state = null;
      room.playerSeats = [];
      room.rematchOffers.clear();
      broadcastLobby(room);
      return true;
    }
    // 先手は前回の先手の次の席へ回す
    const seats = filledSeats(room);
    const prev = seats.indexOf(room.firstSeat);
    room.firstSeat = seats[(prev + 1) % seats.length];
    startGame(room);
    return true;
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
        const room = makeRoom({ mode, createdVia: 'web' });
        room.code = code;
        room.hostId = user.id;
        room.slots[0] = { ws, user, bot: false };
        rooms.set(code, room);
        ws.babanuki = { code, seat: 0 };
        if (mode === 'bot') {
          room.slots[1] = botSlot('Bot');
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
        if (ws.babanuki && ws.babanuki.code !== code) {
          return send(ws, { type: 'error', message: 'すでに別のルームに入っています' });
        }
        if (room.mode !== 'human' && !(room.hostId && !user.guest && user.id === room.hostId)) {
          return send(ws, { type: 'error', message: 'そのルームには参加できません' });
        }
        if (user.guest) return send(ws, { type: 'error', message: '人間同士の対戦には Discord ログインが必要です' });

        // 自分の席がすでにあれば取り戻す（Discord経由のホスト席・再接続はここで処理する）
        const mySeat = room.slots.findIndex((s) => s && !s.bot && s.user.id === user.id);
        if (mySeat >= 0) {
          const slot = room.slots[mySeat];
          if (slot.ws && slot.ws !== ws && slot.ws.readyState === 1) {
            return send(ws, { type: 'error', message: 'すでに別の画面で参加しています' });
          }
          slot.ws = ws;
          slot.user.name = user.name;
          ws.babanuki = { code, seat: mySeat };
          stopGrace(room, mySeat);
          broadcast(room, { type: 'player_back', name: user.name }, mySeat);
          if (room.phase === 'playing' || room.phase === 'finished') {
            broadcastState(room);
            if (room.phase === 'finished') broadcastRematchStatus(room);
          } else if (room.mode === 'bot') {
            startGame(room); // Discord経由のBotルームはホストが入った時点で開始
          } else {
            broadcastLobby(room);
          }
          return;
        }

        if (ws.babanuki) return send(ws, { type: 'error', message: 'すでにルームに入っています' });
        if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'そのルームは対局中です' });
        const emptySeat = room.slots.findIndex((s) => !s);
        if (emptySeat < 0) return send(ws, { type: 'error', message: 'そのルームは満員です' });
        room.slots[emptySeat] = { ws, user, bot: false };
        ws.babanuki = { code, seat: emptySeat };
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

      if (msg.type === 'add_bot') {
        if (room.phase !== 'lobby' || room.mode !== 'human') return send(ws, { type: 'error', message: '今は Bot を追加できません' });
        if (seat !== room.hostSeat) return send(ws, { type: 'error', message: 'Bot の追加はホストだけができます' });
        const emptySeat = room.slots.findIndex((s) => !s);
        if (emptySeat < 0) return send(ws, { type: 'error', message: '席がいっぱいです' });
        const botCount = room.slots.filter((s) => s && s.bot).length;
        room.slots[emptySeat] = botSlot(botCount === 0 ? 'Bot' : `Bot ${botCount + 1}`);
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

      if (msg.type === 'start') {
        if (room.phase !== 'lobby' || room.mode !== 'human') return send(ws, { type: 'error', message: '今は開始できません' });
        if (seat !== room.hostSeat) return send(ws, { type: 'error', message: '対局の開始はホストだけができます' });
        if (filledSeats(room).length < MIN_PLAYERS) {
          return send(ws, { type: 'error', message: '対局には2人以上が必要です（Bot を追加することもできます）' });
        }
        room.firstSeat = room.hostSeat;
        startGame(room);
        return;
      }

      if (msg.type === 'draw') {
        const result = applyDraw(room, seat, msg.position);
        if (!result.ok) send(ws, { type: 'error', message: result.reason });
        return;
      }

      if (msg.type === 'rematch') {
        if (room.phase !== 'finished') {
          return send(ws, { type: 'error', message: '対局が終わってから押してください' });
        }
        if (room.mode === 'bot') {
          const seats = filledSeats(room);
          const prev = seats.indexOf(room.firstSeat);
          room.firstSeat = seats[(prev + 1) % seats.length];
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
        ws.babanuki = null;
        if (room.phase === 'playing') {
          const name = slot.user.name;
          slot.ws = null;
          abortGame(room, name);
          return;
        }
        if (room.phase === 'lobby') {
          slot.ws = null;
          if (seat === room.hostSeat) {
            broadcast(room, { type: 'room_closed', message: 'ホストが退出したため、ルームは解散しました。' }, seat);
            destroyRoom(room);
          } else {
            room.slots[seat] = null;
            broadcastLobby(room);
          }
          return;
        }
        // finished: 席を空けて、残りの人で再戦できるようにする
        slot.ws = null;
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
      ws.babanuki = null;

      if (room.mode === 'bot') {
        destroyRoom(room);
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
      if (room.phase === 'playing') {
        // 対局中: 再接続の猶予を置く。残りの人には切断を知らせる
        broadcast(room, {
          type: 'player_disconnected',
          name: slot.user.name,
          graceSec: Math.round(RECONNECT_GRACE_MS / 1000),
        }, seat);
        startGrace(room, seat);
        return;
      }
      // finished: 猶予内に再接続すれば再戦に参加できる。切れたら席を空ける
      startGrace(room, seat);
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

module.exports = { attach, WS_PATH, rooms, createRoom, inviteUrl, WAITING_TTL_MS, MAX_PLAYERS };
