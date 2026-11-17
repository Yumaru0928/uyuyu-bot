'use strict';

// うゆゆガチャの図鑑（所持記録）と「本日の対戦勝利者」の記録
//
// ・保存の仕組みは utils/babanuki-records.js と同じ utils/json-store.js
// ・保存先は data ブランチの gacha-collection.json。ローカル実行のときは data/gacha-collection.json
// ・起動時は index.js が gameStores の一員として data ブランチから読み戻す
// ・対戦の勝利記録は「その日（JST）に勝ったか」を uyuyu_take の条件判定に使うためのもの。
//   対戦3作の settle() が人間の勝者について markWin() を呼ぶ。勝った日付だけを持つ軽い記録。
//
// 保存形式 (gacha-collection.json):
// {
//   "version": 1,
//   "users": { "<userId>": { "items": { "<emojiName>": 所持数 }, "total": 総所持数,
//                            "updatedAt": 1760000000000 } },
//   "wins":  { "<userId>": "2026-11-17" }   // 最後に対戦で勝った日（JST の日付キー）
// }

const path = require('node:path');
const { createJsonStore } = require('./json-store');
const { jstDateKey } = require('./gacha');
const { GACHA_ALL } = require('./emojis.js');

const FORMAT_VERSION = 1;
const KNOWN_NAMES = new Set(GACHA_ALL.map((e) => e.name));

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('gacha-collection.json の形式が正しくありません');
  }
  const out = { version: FORMAT_VERSION, users: {}, wins: {} };
  if (raw.users && typeof raw.users === 'object') {
    for (const [userId, u] of Object.entries(raw.users)) {
      if (!u || typeof u !== 'object') continue;
      const items = {};
      let total = 0;
      if (u.items && typeof u.items === 'object') {
        for (const [name, n] of Object.entries(u.items)) {
          if (!KNOWN_NAMES.has(name)) continue;
          if (Number.isInteger(n) && n > 0) {
            items[name] = n;
            total += n;
          }
        }
      }
      out.users[userId] = {
        items,
        total,
        updatedAt: Number.isFinite(u.updatedAt) ? u.updatedAt : 0,
      };
    }
  }
  if (raw.wins && typeof raw.wins === 'object') {
    for (const [userId, day] of Object.entries(raw.wins)) {
      if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) out.wins[userId] = day;
    }
  }
  return out;
}

const st = createJsonStore({
  file: 'gacha-collection.json',
  label: 'gacha-collection',
  localFile: process.env.GACHA_LOCAL_PATH || path.join(__dirname, '..', 'data', 'gacha-collection.json'),
  empty: () => ({ version: FORMAT_VERSION, users: {}, wins: {} }),
  sanitize,
  count: (d) => Object.keys(d.users).length,
});

function ensureUser(data, userId) {
  const cur = data.users[userId] ?? { items: {}, total: 0, updatedAt: 0 };
  data.users[userId] = cur;
  return cur;
}

/**
 * 絵文字を1個入手させる。
 * @returns {{ isNew: boolean, count: number }} isNew は図鑑に初めて登録されたとき true
 */
function addItem(userId, name) {
  if (!userId || !KNOWN_NAMES.has(name)) return { isNew: false, count: 0 };
  const data = st.data;
  const user = ensureUser(data, userId);
  const before = user.items[name] ?? 0;
  user.items[name] = before + 1;
  user.total += 1;
  user.updatedAt = Date.now();
  st.markDirty();
  return { isNew: before === 0, count: before + 1 };
}

/**
 * 複数個まとめて入手させる（ガチャ10連用）。
 * @param {string[]} names
 * @returns {{ newNames: string[], counts: Record<string, number> }}
 *   newNames: この一括で初めて登録された絵文字名（重複なし）
 *   counts:   対象絵文字の入手後の所持数
 */
function addItems(userId, names) {
  const newNames = [];
  const counts = {};
  if (!userId || !Array.isArray(names)) return { newNames, counts };
  const data = st.data;
  const user = ensureUser(data, userId);
  let changed = false;
  for (const name of names) {
    if (!KNOWN_NAMES.has(name)) continue;
    const before = user.items[name] ?? 0;
    if (before === 0 && !newNames.includes(name)) newNames.push(name);
    user.items[name] = before + 1;
    user.total += 1;
    counts[name] = before + 1;
    changed = true;
  }
  if (changed) {
    user.updatedAt = Date.now();
    st.markDirty();
  }
  return { newNames, counts };
}

/** ユーザーの所持状況 { items: {name: count}, total, kinds }（未登録なら空） */
function getCollection(userId) {
  const u = st.data.users[userId];
  if (!u) return { items: {}, total: 0, kinds: 0 };
  return { items: { ...u.items }, total: u.total, kinds: Object.keys(u.items).length };
}

/** 対戦で勝利したことを今日（JST）の日付で記録する */
function markWin(userId, date = new Date()) {
  if (!userId) return;
  const day = jstDateKey(date);
  if (st.data.wins[userId] === day) return;
  st.data.wins[userId] = day;
  st.markDirty();
}

/** 今日（JST）対戦で勝ったかどうか */
function wonToday(userId, date = new Date()) {
  return st.data.wins[userId] === jstDateKey(date);
}

module.exports = {
  addItem,
  addItems,
  getCollection,
  markWin,
  wonToday,
  store: st,
  setSaveHandler: st.setSaveHandler,
  importRecords: st.importRecords,
  flush: st.flush,
};
