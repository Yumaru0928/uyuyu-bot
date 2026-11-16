'use strict';

// Web版ババ抜きの勝敗記録（レートは付けない。勝敗と順位だけ）
//
// ・保存の仕組みは utils/rating.js と同じ utils/json-store.js（メモリ保持 + まとめて保存 + GitHub 差し替え）
// ・保存先は data ブランチの babanuki-results.json。ローカル実行のときは data/babanuki-results.json
// ・起動時は index.js が gameStores の一員として data ブランチから読み戻す
// ・記録するのは Discord ログイン済みプレイヤーの結果だけ（ゲスト・Bot 自身は戦績を持たない）
//
// v2（多人数対応）での記録ルール:
// ・勝ち = 最下位以外、負け = 最下位（2人対戦では v1 の勝敗と完全に一致する）
// ・あわせて「1位の回数（firsts）」と「参加回数（games）」も持つ
// ・対局ログには全員の順位（players）を残す。v1 の winner/loser フィールドも
//   1位と最下位から埋め続けるので、古い読み手でも壊れない（後方互換な拡張）
//
// 保存形式 (babanuki-results.json):
// {
//   "version": 1,
//   "players": { "<userId>": { "name": "表示名", "wins": 3, "losses": 1,
//                              "firsts": 2, "games": 4, "updatedAt": 1760000000000 } },
//   "matches": [ { "at": 1760000000000, "winnerId": "...", "winnerName": "...",
//                  "loserId": "...", "loserName": "...", "vsBot": false,
//                  "playerCount": 4,
//                  "players": [ { "id": "...", "name": "...", "place": 1, "bot": false } ] } ]
//              // 新しい順・最大50件。players / playerCount は v2 で追加（v1 の記録には無い）
// }

const path = require('node:path');
const { createJsonStore } = require('./json-store');

const FORMAT_VERSION = 1;
const MAX_MATCHES = 50;

const toCount = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);

function sanitizeMatch(m) {
  const out = {
    at: m.at,
    winnerId: String(m.winnerId ?? ''),
    winnerName: String(m.winnerName ?? '').slice(0, 64),
    loserId: String(m.loserId ?? ''),
    loserName: String(m.loserName ?? '').slice(0, 64),
    vsBot: Boolean(m.vsBot),
  };
  if (Array.isArray(m.players) && m.players.length > 0) {
    out.playerCount = m.players.length;
    out.players = m.players
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: String(p.id ?? ''),
        name: String(p.name ?? '').slice(0, 64),
        place: Number.isInteger(p.place) && p.place >= 1 ? p.place : null,
        bot: Boolean(p.bot),
      }));
  } else if (Number.isInteger(m.playerCount) && m.playerCount >= 2) {
    out.playerCount = m.playerCount;
  }
  return out;
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.players || typeof raw.players !== 'object') {
    throw new Error('babanuki-results.json の形式が正しくありません');
  }
  const out = { version: FORMAT_VERSION, players: {}, matches: [] };
  for (const [userId, p] of Object.entries(raw.players)) {
    if (!p || typeof p !== 'object') continue;
    const wins = toCount(p.wins);
    const losses = toCount(p.losses);
    out.players[userId] = {
      name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
      wins,
      losses,
      // v1 の記録には無いので補完する: v1 は2人対戦のみで wins は全て1位、
      // 参加回数は wins+losses と一致する
      firsts: Number.isInteger(p.firsts) && p.firsts >= 0 ? p.firsts : wins,
      games: Number.isInteger(p.games) && p.games >= 0 ? p.games : wins + losses,
      updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
    };
  }
  if (Array.isArray(raw.matches)) {
    out.matches = raw.matches
      .filter((m) => m && typeof m === 'object' && Number.isFinite(m.at))
      .slice(0, MAX_MATCHES)
      .map(sanitizeMatch);
  }
  return out;
}

const st = createJsonStore({
  file: 'babanuki-results.json',
  label: 'babanuki-results',
  localFile: process.env.BABANUKI_LOCAL_PATH || path.join(__dirname, '..', 'data', 'babanuki-results.json'),
  empty: () => ({ version: FORMAT_VERSION, players: {}, matches: [] }),
  sanitize,
  count: (d) => Object.keys(d.players).length,
});

const BOT_ID = 'bot';

/**
 * 対局結果を記録する（2人〜4人）。
 * @param {object} p
 * @param {Array<{id: string, name: string, place: number, bot?: boolean, guest?: boolean}>} p.results
 *        全員の結果。place は順位（1始まり）。Bot は id='bot' で渡す。
 * @param {boolean} [p.vsBot] Bot が参加した対局かどうか
 * @returns {boolean} 記録したかどうか（ログイン済みプレイヤーが1人もいなければ記録しない）
 */
function recordResult({ results, vsBot = false } = {}) {
  if (!Array.isArray(results) || results.length < 2) return false;
  const count = results.length;
  const normalized = results.map((r) => ({
    id: r && r.bot ? BOT_ID : String(r?.id ?? ''),
    name: String(r?.name ?? '').slice(0, 64),
    place: Number.isInteger(r?.place) && r.place >= 1 && r.place <= count ? r.place : count,
    bot: Boolean(r?.bot),
    guest: Boolean(r?.guest),
  }));
  // 記録対象（ログイン済み人間）がいない対局は、戦績も対局ログも残さない
  const recordable = normalized.filter((r) => !r.bot && !r.guest && r.id);
  if (recordable.length === 0) return false;

  const now = Date.now();
  const data = st.data;
  for (const r of recordable) {
    const cur = data.players[r.id] ?? { name: '', wins: 0, losses: 0, firsts: 0, games: 0, updatedAt: 0 };
    cur.name = r.name;
    cur.games += 1;
    if (r.place === 1) cur.firsts += 1;
    if (r.place >= count) cur.losses += 1; // 最下位だけを負けとする
    else cur.wins += 1;
    cur.updatedAt = now;
    data.players[r.id] = cur;
  }

  const first = normalized.find((r) => r.place === 1) ?? normalized[0];
  const last = normalized.find((r) => r.place === count) ?? normalized[normalized.length - 1];
  data.matches.unshift({
    at: now,
    winnerId: first.id,
    winnerName: first.name,
    loserId: last.id,
    loserName: last.name,
    vsBot: Boolean(vsBot),
    playerCount: count,
    players: normalized.map(({ id, name, place, bot }) => ({ id, name, place, bot })),
  });
  data.matches = data.matches.slice(0, MAX_MATCHES);
  st.markDirty();
  return true;
}

/**
 * 2人対戦用の従来API（v1 互換）。中身は recordResult に委譲する。
 * @param {object} p
 * @param {{id: string, name: string}} p.winner 勝者（Bot の場合は id='bot'）
 * @param {{id: string, name: string}} p.loser  敗者
 * @param {boolean} [p.vsBot] Bot 戦かどうか
 */
function recordMatch({ winner, loser, vsBot = false }) {
  return recordResult({
    results: [
      { id: winner?.id, name: winner?.name, place: 1, bot: winner?.id === BOT_ID },
      { id: loser?.id, name: loser?.name, place: 2, bot: loser?.id === BOT_ID },
    ],
    vsBot,
  });
}

/** ユーザーの戦績 { userId, name, wins, losses, firsts, games, updatedAt }。未対戦なら null */
function getProfile(userId) {
  const p = st.data.players[userId];
  return p ? { userId, ...p } : null;
}

/** 最近の対局結果（新しい順） */
function recentMatches(limit = 10) {
  return st.data.matches.slice(0, limit);
}

module.exports = {
  BOT_ID,
  recordMatch,
  recordResult,
  getProfile,
  recentMatches,
  store: st,
  setSaveHandler: st.setSaveHandler,
  importRecords: st.importRecords,
  flush: st.flush,
};
