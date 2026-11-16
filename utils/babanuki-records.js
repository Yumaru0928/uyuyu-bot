'use strict';

// Web版ババ抜きの勝敗記録（レートは付けない。v1 は勝敗だけ）
//
// ・保存の仕組みは utils/rating.js と同じ utils/json-store.js（メモリ保持 + まとめて保存 + GitHub 差し替え）
// ・保存先は data ブランチの babanuki-results.json。ローカル実行のときは data/babanuki-results.json
// ・起動時は index.js が gameStores の一員として data ブランチから読み戻す
// ・記録するのは Discord ログイン済みプレイヤー同士／対Bot戦の確定結果だけ（ゲストは記録しない）
//
// 保存形式 (babanuki-results.json):
// {
//   "version": 1,
//   "players": { "<userId>": { "name": "表示名", "wins": 3, "losses": 1, "updatedAt": 1760000000000 } },
//   "matches": [ { "at": 1760000000000, "winnerId": "...", "winnerName": "...",
//                  "loserId": "...", "loserName": "...", "vsBot": false } ]  // 新しい順・最大50件
// }

const path = require('node:path');
const { createJsonStore } = require('./json-store');

const FORMAT_VERSION = 1;
const MAX_MATCHES = 50;

const toCount = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.players || typeof raw.players !== 'object') {
    throw new Error('babanuki-results.json の形式が正しくありません');
  }
  const out = { version: FORMAT_VERSION, players: {}, matches: [] };
  for (const [userId, p] of Object.entries(raw.players)) {
    if (!p || typeof p !== 'object') continue;
    out.players[userId] = {
      name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
      wins: toCount(p.wins),
      losses: toCount(p.losses),
      updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
    };
  }
  if (Array.isArray(raw.matches)) {
    out.matches = raw.matches
      .filter((m) => m && typeof m === 'object' && Number.isFinite(m.at))
      .slice(0, MAX_MATCHES)
      .map((m) => ({
        at: m.at,
        winnerId: String(m.winnerId ?? ''),
        winnerName: String(m.winnerName ?? '').slice(0, 64),
        loserId: String(m.loserId ?? ''),
        loserName: String(m.loserName ?? '').slice(0, 64),
        vsBot: Boolean(m.vsBot),
      }));
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
 * 対局結果を記録する。
 * @param {object} p
 * @param {{id: string, name: string}} p.winner 勝者（Bot の場合は id='bot'）
 * @param {{id: string, name: string}} p.loser  敗者
 * @param {boolean} [p.vsBot] Bot 戦かどうか
 */
function recordMatch({ winner, loser, vsBot = false }) {
  const now = Date.now();
  const data = st.data;
  const apply = (player, won) => {
    if (!player || !player.id || player.id === BOT_ID) return; // Bot 自身の戦績は持たない
    const cur = data.players[player.id] ?? { name: '', wins: 0, losses: 0, updatedAt: 0 };
    cur.name = String(player.name || '').slice(0, 64);
    if (won) cur.wins += 1;
    else cur.losses += 1;
    cur.updatedAt = now;
    data.players[player.id] = cur;
  };
  apply(winner, true);
  apply(loser, false);
  data.matches.unshift({
    at: now,
    winnerId: String(winner?.id ?? ''),
    winnerName: String(winner?.name ?? '').slice(0, 64),
    loserId: String(loser?.id ?? ''),
    loserName: String(loser?.name ?? '').slice(0, 64),
    vsBot: Boolean(vsBot),
  });
  data.matches = data.matches.slice(0, MAX_MATCHES);
  st.markDirty();
}

/** ユーザーの戦績 { userId, name, wins, losses, updatedAt }。未対戦なら null */
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
  getProfile,
  recentMatches,
  store: st,
  setSaveHandler: st.setSaveHandler,
  importRecords: st.importRecords,
  flush: st.flush,
};
