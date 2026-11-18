'use strict';

// Web版 三人麻雀の対戦履歴の保存
//
// ・仕組みは utils/kifu-store.js と同じ utils/json-store.js（30日保管・お気に入り・
//   6文字コード）。保存先は data ブランチの mahjong-history.json
// ・棋譜ストアは2人対戦専用の形式なので、麻雀は専用ストアを持つ
// ・記録の中身は「対局メタ＋各局の牌山と全アクション」で、再生は
//   utils/mahjong-replay.js がエンジンに流し込んで再現する
//
// 保存形式 (mahjong-history.json):
// {
//   "version": 1,
//   "records": [ { "id", "code", "createdAt",
//                  "length": "east"|"south",
//                  "players": [ { "id", "name", "bot" } ],  // 席（対局内の座席）順に3人
//                  "firstDealer": 2,
//                  "placements": [1,2,3], "finalScores": [...], "scores": [...],
//                  "rules": { ... },   // 再生に必要な正規化済みルール
//                  "rounds": [ { "wall": [108], "dealer", "honba", "kyotaku",
//                                "scores": [3], "label", "events": [...] } ] } ],
//   "favorites": { "<userId>": { "<recordId>": { "name", "at" } } }
// }

const crypto = require('node:crypto');
const path = require('node:path');
const { createJsonStore } = require('./json-store');

const FORMAT_VERSION = 1;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 保管は30日（棋譜と同じ）
const NAME_MAX = 50;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 棋譜と同じ文字セット

function sanitizePlayer(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id ?? '');
  if (!id) return null;
  return { id, name: String(p.name ?? '').slice(0, 64), bot: Boolean(p.bot) };
}

function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.t === 'd') {
    if (!Number.isInteger(ev.s) || !Number.isInteger(ev.tile)) return null;
    return { t: 'd', s: ev.s, tile: ev.tile, riichi: Boolean(ev.riichi), openRiichi: Boolean(ev.openRiichi) };
  }
  if (ev.t === 'c') {
    if (!Number.isInteger(ev.s) || !['pass', 'ron', 'pon', 'kan'].includes(ev.a)) return null;
    return { t: 'c', s: ev.s, a: ev.a };
  }
  if (ev.t === 'k') {
    if (!Number.isInteger(ev.s) || !Number.isInteger(ev.tile) || !['ankan', 'shouminkan'].includes(ev.kind)) return null;
    return { t: 'k', s: ev.s, tile: ev.tile, kind: ev.kind };
  }
  if (ev.t === 't' || ev.t === 'n' || ev.t === 'q') {
    if (!Number.isInteger(ev.s)) return null;
    return { t: ev.t, s: ev.s };
  }
  return null;
}

function sanitizeRound(r) {
  if (!r || typeof r !== 'object') return null;
  if (!Array.isArray(r.wall) || r.wall.length !== 108 || !r.wall.every((t) => Number.isInteger(t) && t >= 0 && t <= 35)) return null;
  if (!Array.isArray(r.scores) || r.scores.length !== 3 || !r.scores.every((n) => Number.isFinite(n))) return null;
  if (!Array.isArray(r.events)) return null;
  const events = r.events.map(sanitizeEvent);
  if (events.some((e) => e === null)) return null;
  return {
    wall: r.wall.slice(),
    dealer: Number.isInteger(r.dealer) ? r.dealer : 0,
    honba: Number.isInteger(r.honba) ? r.honba : 0,
    kyotaku: Number.isInteger(r.kyotaku) ? r.kyotaku : 0,
    scores: r.scores.slice(),
    label: typeof r.label === 'string' ? r.label.slice(0, 16) : '',
    events,
  };
}

function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.code !== 'string' || !r.code) return null;
  if (!Array.isArray(r.players)) return null;
  const players = r.players.map(sanitizePlayer).filter(Boolean);
  if (players.length !== 3) return null;
  if (!Array.isArray(r.rounds) || r.rounds.length === 0) return null;
  const rounds = r.rounds.map(sanitizeRound);
  if (rounds.some((x) => x === null)) return null;
  if (!Number.isFinite(r.createdAt)) return null;
  return {
    id: r.id,
    code: r.code.toUpperCase(),
    createdAt: r.createdAt,
    length: r.length === 'south' ? 'south' : 'east',
    players,
    firstDealer: Number.isInteger(r.firstDealer) ? r.firstDealer : 0,
    placements: Array.isArray(r.placements) && r.placements.length === 3 ? r.placements.slice() : null,
    finalScores: Array.isArray(r.finalScores) ? r.finalScores : null,
    scores: Array.isArray(r.scores) && r.scores.length === 3 ? r.scores.slice() : null,
    rules: r.rules && typeof r.rules === 'object' ? r.rules : {},
    rounds,
  };
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mahjong-history.json の形式が正しくありません');
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
      for (const [recordId, f] of Object.entries(favs)) {
        if (!liveIds.has(recordId) || !f || typeof f !== 'object') continue;
        cleaned[recordId] = {
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
  file: 'mahjong-history.json',
  label: 'mahjong-history',
  localFile: process.env.MAHJONG_HISTORY_LOCAL_PATH || path.join(__dirname, '..', 'data', 'mahjong-history.json'),
  empty: () => ({ version: FORMAT_VERSION, records: [], favorites: {} }),
  sanitize,
  count: (d) => d.records.length,
});

function newCode(data) {
  const used = new Set(data.records.map((r) => r.code));
  for (let tries = 0; tries < 20; tries++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!used.has(code)) return code;
  }
  return null;
}

/** 期限切れ（30日超・誰のお気に入りでもない）を削除する */
function cleanup(data, now = Date.now()) {
  const favorited = new Set();
  for (const favs of Object.values(data.favorites)) {
    for (const recordId of Object.keys(favs)) favorited.add(recordId);
  }
  const kept = data.records.filter((r) => now - r.createdAt < RETENTION_MS || favorited.has(r.id));
  const removed = data.records.length - kept.length;
  if (removed > 0) data.records = kept;
  const liveIds = new Set(data.records.map((r) => r.id));
  for (const [userId, favs] of Object.entries(data.favorites)) {
    for (const recordId of Object.keys(favs)) {
      if (!liveIds.has(recordId)) delete favs[recordId];
    }
    if (Object.keys(favs).length === 0) delete data.favorites[userId];
  }
  return removed;
}

/**
 * 終局した対局を対戦履歴として保存する。
 * @param {object} p recordGame に渡す内容（id/code/createdAt はここで付ける）
 * @returns {object|null} 保存したレコード（コードを含む）
 */
function recordMatch(p) {
  const data = st.data;
  cleanup(data);
  const code = newCode(data);
  if (!code) return null;
  const rec = sanitizeRecord({
    id: crypto.randomUUID(),
    code,
    createdAt: Date.now(),
    length: p.length,
    players: p.players,
    firstDealer: p.firstDealer,
    placements: p.placements,
    finalScores: p.finalScores,
    scores: p.scores,
    rules: p.rules,
    rounds: p.rounds,
  });
  if (!rec) return null;
  data.records.unshift(rec);
  st.markDirty();
  return rec;
}

function getByCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  return st.data.records.find((r) => r.code === normalized) ?? null;
}

function getById(id) {
  return st.data.records.find((r) => r.id === id) ?? null;
}

/** 自分が参加した対局の一覧（新しい順）。Bot は参加者に数えない */
function listForUser(userId) {
  if (!userId) return [];
  return st.data.records.filter((r) => r.players.some((p) => p.id === userId && !p.bot));
}

function getFavorite(userId, recordId) {
  const fav = st.data.favorites[userId]?.[recordId];
  return fav ? { ...fav } : null;
}

function setFavorite(userId, recordId, favorite, name) {
  if (!userId || !getById(recordId)) return false;
  const data = st.data;
  if (!favorite) {
    if (data.favorites[userId]) {
      delete data.favorites[userId][recordId];
      if (Object.keys(data.favorites[userId]).length === 0) delete data.favorites[userId];
      st.markDirty();
    }
    return true;
  }
  const favs = data.favorites[userId] ?? (data.favorites[userId] = {});
  const cur = favs[recordId] ?? { name: null, at: 0 };
  if (typeof name === 'string') {
    const trimmed = name.trim().slice(0, NAME_MAX);
    cur.name = trimmed === '' ? null : trimmed;
  }
  cur.at = Date.now();
  favs[recordId] = cur;
  st.markDirty();
  return true;
}

module.exports = {
  RETENTION_MS,
  NAME_MAX,
  recordMatch,
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
