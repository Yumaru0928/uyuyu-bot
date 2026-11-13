'use strict';

// ゲーム共通のレート(Elo)管理（JSON保存版）
//
// ・保存の仕組み（メモリ保持 + まとめて保存 + GitHub への保存の差し替え）は utils/json-store.js
// ・保存先は data ブランチの ratings.json。ローカル実行のときは data/ratings.json
// ・起動時は index.js が data ブランチから読み戻して importRecords() に渡す（ai-messages.js と同じ型）
//
// 保存形式 (ratings.json):
// {
//   "version": 1,
//   "games": {
//     "othello": {
//       "players": { "<userId>": { "rating": 1520.35, "wins": 3, "losses": 1, "draws": 0, "updatedAt": 1760000000000 } },
//       "guilds":  { "<guildId>": ["<userId>", ...] }   // そのサーバーで対戦したことがある人
//     }
//   }
// }
//
// レートは「ゲームID × ユーザー」ごとに1つ（サーバーをまたいで共通）。
// サーバー内ランキングは、そのサーバーで対戦したことがある人だけを抜き出して並べる。

const path = require('node:path');
const { createJsonStore } = require('./json-store');

// ---------- 設定 ----------
const INITIAL_RATING = 1500;
const PROVISIONAL_GAMES = 10; // 最初の10戦は変動を大きく
const K_PROVISIONAL = 40;
const K_NORMAL = 24;
const FORMAT_VERSION = 1;

// ---------- データ ----------
const toCount = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
const round2 = (n) => Math.round(n * 100) / 100;

// 外から来たデータ（読み戻したJSONなど）を検証して、安全な形に整える。形式が違えば例外
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.games || typeof raw.games !== 'object') {
    throw new Error('ratings.json の形式が正しくありません');
  }
  const out = { version: FORMAT_VERSION, games: {} };
  for (const [game, g] of Object.entries(raw.games)) {
    if (!g || typeof g !== 'object') continue;
    const data = { players: {}, guilds: {} };
    for (const [userId, p] of Object.entries(g.players ?? {})) {
      if (!p || !Number.isFinite(p.rating)) continue;
      data.players[userId] = {
        rating: p.rating,
        wins: toCount(p.wins),
        losses: toCount(p.losses),
        draws: toCount(p.draws),
        updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
      };
    }
    for (const [guildId, list] of Object.entries(g.guilds ?? {})) {
      if (Array.isArray(list)) data.guilds[guildId] = [...new Set(list.map(String))];
    }
    out.games[game] = data;
  }
  return out;
}

// 保存（メモリ保持 + まとめて保存 + 保存先の差し替え）は utils/json-store.js
const st = createJsonStore({
  file: 'ratings.json',
  label: 'ratings',
  localFile: process.env.RATINGS_LOCAL_PATH || path.join(__dirname, '..', 'data', 'ratings.json'),
  empty: () => ({ version: FORMAT_VERSION, games: {} }),
  sanitize,
  count: (d) => Object.values(d.games).reduce((n, g) => n + Object.keys(g.players).length, 0),
});

const root = () => st.data;

function gameData(game, create = false) {
  let g = root().games[game];
  if (!g && create) g = root().games[game] = { players: {}, guilds: {} };
  return g;
}

// ---------- レート計算 ----------
const newPlayer = () => ({ rating: INITIAL_RATING, wins: 0, losses: 0, draws: 0, updatedAt: 0 });
const kFactor = (p) => (p.wins + p.losses + p.draws < PROVISIONAL_GAMES ? K_PROVISIONAL : K_NORMAL);

/**
 * 対戦結果を記録してレートを更新する。
 * @param {object} p
 * @param {string} p.game         ゲームID（utils/games.js のキー）
 * @param {string|null} p.guildId 対戦したサーバーID（DMなら null）
 * @param {string} p.userA        プレイヤーAのユーザーID
 * @param {string} p.userB        プレイヤーBのユーザーID
 * @param {'a'|'b'|'draw'} p.result 勝者
 * @returns {{a:{before:number,after:number,delta:number}, b:{before:number,after:number,delta:number}}}
 *          数値は表示用に四捨五入済み
 */
function recordMatch({ game, guildId = null, userA, userB, result }) {
  const g = gameData(game, true);
  const a = g.players[userA] ?? newPlayer();
  const b = g.players[userB] ?? newPlayer();

  const scoreA = result === 'a' ? 1 : result === 'b' ? 0 : 0.5;
  const expectedA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
  const newA = round2(a.rating + kFactor(a) * (scoreA - expectedA));
  const newB = round2(b.rating + kFactor(b) * ((1 - scoreA) - (1 - expectedA)));
  const now = Date.now();

  g.players[userA] = {
    rating: newA,
    wins: a.wins + (result === 'a' ? 1 : 0),
    losses: a.losses + (result === 'b' ? 1 : 0),
    draws: a.draws + (result === 'draw' ? 1 : 0),
    updatedAt: now,
  };
  g.players[userB] = {
    rating: newB,
    wins: b.wins + (result === 'b' ? 1 : 0),
    losses: b.losses + (result === 'a' ? 1 : 0),
    draws: b.draws + (result === 'draw' ? 1 : 0),
    updatedAt: now,
  };

  if (guildId) {
    const members = (g.guilds[guildId] ??= []);
    for (const id of [userA, userB]) if (!members.includes(id)) members.push(id);
  }

  st.markDirty();

  const view = (before, after) => {
    const rb = Math.round(before);
    const ra = Math.round(after);
    return { before: rb, after: ra, delta: ra - rb };
  };
  return { a: view(a.rating, newA), b: view(b.rating, newB) };
}

// ---------- 参照 ----------

// レートの高い順に並べた一覧（guildId があればそのサーバーで対戦した人だけ）
function sortedEntries(game, guildId = null) {
  const g = root().games[game];
  if (!g) return [];
  let ids = Object.keys(g.players);
  if (guildId) {
    const members = new Set(g.guilds[guildId] ?? []);
    ids = ids.filter((id) => members.has(id));
  }
  return ids
    .map((userId) => ({ userId, ...g.players[userId] }))
    .sort((x, y) => y.rating - x.rating || y.wins - x.wins || (x.userId < y.userId ? -1 : 1));
}

/** ユーザーの戦績 { userId, rating, wins, losses, draws, updatedAt }。未対戦なら null */
function getProfile(game, userId) {
  const p = root().games[game]?.players[userId];
  return p ? { userId, ...p } : null;
}

/** ランキング上位。guildId を渡すとそのサーバーで対戦した人だけ */
function getRanking(game, { guildId = null, limit = 10, offset = 0 } = {}) {
  return sortedEntries(game, guildId).slice(offset, offset + limit);
}

/** ユーザーの順位 { rank, total }。未対戦（サーバー指定時はそのサーバー未対戦）なら null */
function getRank(game, userId, guildId = null) {
  const me = root().games[game]?.players[userId];
  if (!me) return null;
  if (guildId && !(root().games[game].guilds[guildId] ?? []).includes(userId)) return null;

  const list = sortedEntries(game, guildId);
  return { rank: list.filter((r) => r.rating > me.rating).length + 1, total: list.length };
}

module.exports = {
  INITIAL_RATING,
  recordMatch, getProfile, getRanking, getRank,
  store: st,
  setSaveHandler: st.setSaveHandler,
  importRecords: st.importRecords,
  flush: st.flush,
};