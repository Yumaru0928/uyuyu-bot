'use strict';

// 対戦ゲーム（将棋・オセロ・四目並べ）の棋譜の保存
//
// ・保存の仕組みは utils/babanuki-records.js と同じ utils/json-store.js
// ・保存先は data ブランチの kifu-records.json。ローカル実行のときは data/kifu-records.json
// ・起動時は index.js が gameStores の一員として data ブランチから読み戻す
// ・保管は30日。新規保存のタイミングで、30日を過ぎていて誰のお気に入りにも
//   入っていない棋譜を削除する（遅延クリーンアップ）
// ・お気に入りと名前はユーザーごとに持つ（自分の付けた名前は自分にだけ見える）。
//   誰か1人でもお気に入りしていたら、その棋譜は自動削除されない
// ・棋譜コード（6文字）を知っていれば、参加していない人でも Web で棋譜を見られる
//
// 保存形式 (kifu-records.json):
// {
//   "version": 1,
//   "records": [ { "id": "内部ID", "code": "ABC123", "game": "shogi",
//                  "players": [ { "id": "...", "name": "...", "bot": false } ],  // 先手→後手の順
//                  "firstId": "先手のID", "winnerId": "勝者のID（引き分けは null）",
//                  "reason": "checkmate" など,
//                  "moves": [ ... ],   // 将棋=USI文字列 / オセロ={x,y} / 四目並べ=列番号
//                  "level": "normal" | null,  // Bot戦の強さ（人間同士は null）
//                  "createdAt": 1760000000000 } ],   // 新しい順
//   "favorites": { "<userId>": { "<kifuId>": { "name": "名前 or null", "at": 1760000000000 } } }
// }

const crypto = require('node:crypto');
const path = require('node:path');
const { createJsonStore } = require('./json-store');

const FORMAT_VERSION = 1;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 保管は30日
const NAME_MAX = 50; // お気に入りの名前の最大文字数
const GAMES = new Set(['shogi', 'othello', 'connect4']);

// 共有コード。ババ抜きの招待コード（utils/babanuki-server.js）と同じ文字セット・方式
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい文字（I/L/O/0/1）は除く

function sanitizePlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id ?? '');
  if (!id) return null;
  return { id, name: String(p.name ?? '').slice(0, 64), bot: Boolean(p.bot) };
}

function sanitizeMoves(game, moves) {
  if (!Array.isArray(moves)) return null;
  if (game === 'shogi') {
    return moves.every((m) => typeof m === 'string') ? moves.slice() : null;
  }
  if (game === 'othello') {
    const ok = moves.every(
      (m) => m && Number.isInteger(m.x) && Number.isInteger(m.y) && m.x >= 0 && m.x < 8 && m.y >= 0 && m.y < 8,
    );
    return ok ? moves.map((m) => ({ x: m.x, y: m.y })) : null;
  }
  // connect4
  const ok = moves.every((m) => Number.isInteger(m) && m >= 0 && m < 7);
  return ok ? moves.slice() : null;
}

function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.code !== 'string' || !r.code) return null;
  if (!GAMES.has(r.game)) return null;
  if (!Array.isArray(r.players)) return null;
  const players = r.players.map(sanitizePlayer).filter(Boolean);
  if (players.length !== 2) return null;
  const moves = sanitizeMoves(r.game, r.moves);
  if (!moves) return null;
  if (!Number.isFinite(r.createdAt)) return null;
  const ids = new Set(players.map((p) => p.id));
  return {
    id: r.id,
    code: r.code.toUpperCase(),
    game: r.game,
    players,
    firstId: ids.has(r.firstId) ? r.firstId : players[0].id,
    winnerId: r.winnerId === null || r.winnerId === undefined ? null : ids.has(r.winnerId) ? r.winnerId : null,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 32) : 'normal',
    moves,
    level: typeof r.level === 'string' ? r.level.slice(0, 16) : null,
    createdAt: r.createdAt,
  };
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('kifu-records.json の形式が正しくありません');
  }
  const out = { version: FORMAT_VERSION, records: [], favorites: {} };
  if (Array.isArray(raw.records)) {
    const seenCode = new Set();
    for (const r of raw.records) {
      const rec = sanitizeRecord(r);
      if (!rec || seenCode.has(rec.code)) continue;
      seenCode.add(rec.code);
      out.records.push(rec);
    }
  }
  const liveIds = new Set(out.records.map((r) => r.id));
  if (raw.favorites && typeof raw.favorites === 'object') {
    for (const [userId, favs] of Object.entries(raw.favorites)) {
      if (!favs || typeof favs !== 'object') continue;
      const cleaned = {};
      for (const [kifuId, f] of Object.entries(favs)) {
        if (!liveIds.has(kifuId) || !f || typeof f !== 'object') continue; // 実在しない棋譜へのお気に入りは捨てる
        cleaned[kifuId] = {
          name: typeof f.name === 'string' ? f.name.slice(0, NAME_MAX) : null,
          at: Number.isFinite(f.at) ? f.at : 0,
        };
      }
      if (Object.keys(cleaned).length > 0) out.favorites[userId] = cleaned;
    }
  }
  return out;
}

const st = createJsonStore({
  file: 'kifu-records.json',
  label: 'kifu-records',
  localFile: process.env.KIFU_LOCAL_PATH || path.join(__dirname, '..', 'data', 'kifu-records.json'),
  empty: () => ({ version: FORMAT_VERSION, records: [], favorites: {} }),
  sanitize,
  count: (d) => d.records.length,
});

/** 既存の棋譜と被らない6文字コードを作る。作れなければ null */
function newCode(data) {
  const used = new Set(data.records.map((r) => r.code));
  for (let tries = 0; tries < 20; tries++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!used.has(code)) return code;
  }
  return null;
}

/**
 * 期限切れの棋譜を削除する（新規保存のタイミングで呼ぶ）。
 * 30日を過ぎていても、誰か1人でもお気に入りしていたら消さない。
 * 消えた棋譜へのお気に入りは掃除する。
 */
function cleanup(data, now = Date.now()) {
  const favorited = new Set();
  for (const favs of Object.values(data.favorites)) {
    for (const kifuId of Object.keys(favs)) favorited.add(kifuId);
  }
  const kept = data.records.filter((r) => now - r.createdAt < RETENTION_MS || favorited.has(r.id));
  const removed = data.records.length - kept.length;
  if (removed > 0) data.records = kept;
  // 実在しない棋譜へのお気に入りを掃除する
  const liveIds = new Set(data.records.map((r) => r.id));
  for (const [userId, favs] of Object.entries(data.favorites)) {
    for (const kifuId of Object.keys(favs)) {
      if (!liveIds.has(kifuId)) delete favs[kifuId];
    }
    if (Object.keys(favs).length === 0) delete data.favorites[userId];
  }
  return removed;
}

/**
 * 終局した対局を棋譜として保存する。
 * @param {object} p
 * @param {'shogi'|'othello'|'connect4'} p.game
 * @param {Array<{id: string, name: string, bot?: boolean}>} p.players 先手→後手の順に2人
 * @param {string} p.firstId 先手のID
 * @param {string|null} p.winnerId 勝者のID（引き分けは null）
 * @param {string} p.reason 終局理由（'checkmate' | 'resign' | 'timeout' | 'score' など）
 * @param {Array} p.moves 着手列（将棋=USI文字列 / オセロ={x,y} / 四目並べ=列番号）
 * @param {string|null} [p.level] Bot戦の強さ
 * @returns {object|null} 保存したレコード（コードを含む）。形式が不正なら null
 */
function recordGame({ game, players, firstId, winnerId, reason, moves, level = null } = {}) {
  const data = st.data;
  cleanup(data); // 保存のタイミングで期限切れを掃除する
  const code = newCode(data);
  if (!code) return null;
  const rec = sanitizeRecord({
    id: crypto.randomUUID(),
    code,
    game,
    players,
    firstId,
    winnerId: winnerId ?? null,
    reason,
    moves,
    level,
    createdAt: Date.now(),
  });
  if (!rec) return null;
  data.records.unshift(rec);
  st.markDirty();
  return rec;
}

/** コードから棋譜を引く（大文字小文字は区別しない）。無ければ null */
function getByCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  return st.data.records.find((r) => r.code === normalized) ?? null;
}

/** ID から棋譜を引く。無ければ null */
function getById(id) {
  return st.data.records.find((r) => r.id === id) ?? null;
}

/** 自分が参加した対局の一覧（新しい順） */
function listForUser(userId) {
  if (!userId) return [];
  return st.data.records.filter((r) => r.players.some((p) => p.id === userId && !p.bot));
}

/** 自分のお気に入り状態 { name, at }。お気に入りでなければ null */
function getFavorite(userId, kifuId) {
  const fav = st.data.favorites[userId]?.[kifuId];
  return fav ? { ...fav } : null;
}

/**
 * お気に入りの設定・解除と、名前の変更。
 * @param {boolean} favorite true=お気に入りにする / false=外す（名前も消える）
 * @param {string} [name] 名前。省略時は今の名前を維持。空文字で名前だけ消す。最大50文字
 * @returns {boolean} 対象の棋譜が存在して更新できたら true
 */
function setFavorite(userId, kifuId, favorite, name) {
  if (!userId || !getById(kifuId)) return false;
  const data = st.data;
  if (!favorite) {
    if (data.favorites[userId]) {
      delete data.favorites[userId][kifuId];
      if (Object.keys(data.favorites[userId]).length === 0) delete data.favorites[userId];
      st.markDirty();
    }
    return true;
  }
  const favs = data.favorites[userId] ?? (data.favorites[userId] = {});
  const cur = favs[kifuId] ?? { name: null, at: 0 };
  if (typeof name === 'string') {
    const trimmed = name.trim().slice(0, NAME_MAX);
    cur.name = trimmed === '' ? null : trimmed;
  }
  cur.at = Date.now();
  favs[kifuId] = cur;
  st.markDirty();
  return true;
}

module.exports = {
  RETENTION_MS,
  NAME_MAX,
  recordGame,
  getByCode,
  getById,
  listForUser,
  getFavorite,
  setFavorite,
  cleanup,
  store: st,
  setSaveHandler: st.setSaveHandler,
  importRecords: st.importRecords,
  flush: st.flush,
};
