'use strict';

// 進行中の対局の保存（Bot を再起動・再デプロイしても続きから遊べるようにする）
//
// ・ゲームごとに「メッセージID → ゲームの状態」を保存する。メッセージIDは、対局が表示されている
//   メッセージのID。復元のときは、そのメッセージを取得して操作を受け付け直す
// ・保存先は data ブランチの sessions.json（レートの ratings.json とは別ファイル。
//   こちらは手を打つたびに変わるので、レートのファイルを巻き込まないように分けている）
// ・ゲームの状態の中身は各ゲーム側で決める（JSON にできるものだけ）
//
// 保存形式 (sessions.json):
// {
//   "version": 1,
//   "games": {
//     "othello": {
//       "<messageId>": { "channelId": "...", "board": [...], "turn": 1, ..., "updatedAt": 1760000000000 }
//     }
//   }
// }
//
// 使い方（ゲーム側）:
//   sessions.put('othello', message.id, { channelId, ...状態 });  // 状態が変わるたびに
//   sessions.remove('othello', message.id);                      // 対局が終わったら
//   sessions.list('othello');                                    // 起動後の復元で

const path = require('node:path');
const { createJsonStore } = require('./json-store');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const st = createJsonStore({
  file: 'sessions.json',
  label: 'sessions',
  localFile: process.env.SESSIONS_LOCAL_PATH || path.join(__dirname, '..', 'data', 'sessions.json'),
  empty: () => ({ version: 1, games: {} }),
  sanitize(raw) {
    if (!isPlainObject(raw) || !isPlainObject(raw.games)) {
      throw new Error('sessions.json の形式が正しくありません');
    }
    const out = { version: 1, games: {} };
    for (const [gameId, byMessage] of Object.entries(raw.games)) {
      if (!isPlainObject(byMessage)) continue;
      for (const [messageId, s] of Object.entries(byMessage)) {
        if (!isPlainObject(s)) continue;
        (out.games[gameId] ??= {})[messageId] = s;
      }
    }
    return out;
  },
  count: (d) => Object.values(d.games).reduce((n, g) => n + Object.keys(g).length, 0),
});

/** 対局の状態を保存する（同じメッセージIDなら上書き） */
function put(gameId, messageId, state) {
  const byMessage = (st.data.games[gameId] ??= {});
  byMessage[messageId] = { ...structuredClone(state), updatedAt: Date.now() };
  st.markDirty();
}

/** 対局の状態を消す。消したものがあれば true */
function remove(gameId, messageId) {
  const byMessage = st.data.games[gameId];
  if (!byMessage || !(messageId in byMessage)) return false;
  delete byMessage[messageId];
  if (Object.keys(byMessage).length === 0) delete st.data.games[gameId];
  st.markDirty();
  return true;
}

/** そのゲームの保存済みの対局 [{ messageId, ...状態, updatedAt }] */
function list(gameId) {
  return Object.entries(st.data.games[gameId] ?? {}).map(([messageId, s]) => ({
    messageId,
    ...structuredClone(s),
  }));
}

module.exports = {
  put, remove, list,
  store: st,
  setSaveHandler: st.setSaveHandler,
  importRecords: st.importRecords,
  flush: st.flush,
};