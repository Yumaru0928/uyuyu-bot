'use strict';

// JSON で保存するデータの共通部品（utils/rating.js と utils/sessions.js が使う）
//
// ・データはメモリ上に持ち、変更があったら少し待って（既定10秒）まとめて1回保存する
// ・保存の実体は setSaveHandler() で差し替える。index.js から GitHub の data ブランチへの
//   コミット(commitJsonToGitHub)に差し替えている。差し替えていない間（ローカル実行など）は
//   localFile に書く
// ・保存するのは常に「全データのスナップショット」。途中の保存に失敗しても、次の保存で追いつく
// ・起動時は index.js が data ブランチから読み戻して importRecords() に渡す（ai-messages.js と同じ型）

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object} o
 * @param {string} o.file        data ブランチ上のファイル名（例: 'ratings.json'）
 * @param {string} o.label       ログ・コミットメッセージ用の名前（例: 'ratings'）
 * @param {string} o.localFile   ローカル保存先（GitHub 未設定のときだけ使う）
 * @param {() => any} o.empty    空データを作る
 * @param {(raw: any) => any} o.sanitize  読み込んだ生データを検証して整える（不正なら例外）
 * @param {(data: any) => number} o.count 読み戻したときのログ用の件数
 * @param {number} [o.delayMs]   変更からこの時間まとめて1回保存する
 */
function createJsonStore({ file, label, localFile, empty, sanitize, count, delayMs = 10 * 1000 }) {
  let data = empty();

  async function saveLocal(snapshot) {
    await fs.promises.mkdir(path.dirname(localFile), { recursive: true });
    const tmp = `${localFile}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    await fs.promises.rename(tmp, localFile);
  }

  let saveHandler = saveLocal;
  let dirty = false;
  let timer = null;
  let saving = Promise.resolve();

  /** 変更があったことを知らせる（少し待ってから保存される） */
  function markDirty() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch((error) => console.error(`[${label}] 保存に失敗しました:`, error));
    }, delayMs);
  }

  /** 保存待ちの変更をすぐに書き出す。終了時（SIGTERM）に呼ぶ */
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (dirty) {
      dirty = false;
      const snapshot = structuredClone(data); // 保存処理の待ち中に値が変わっても影響しないようコピーする
      saving = saving.catch(() => {}).then(() => saveHandler(snapshot));
    }
    return saving;
  }

  /** 保存先を差し替える。fn(data) は Promise を返してよい */
  function setSaveHandler(fn) {
    saveHandler = fn;
  }

  /** 読み戻したデータで丸ごと置き換える。件数を返す。形式が違えば例外 */
  function importRecords(raw) {
    data = sanitize(raw);
    return count(data);
  }

  // 起動時にローカルのファイルがあれば読む（ローカル実行用。Render では無く、GitHub から読み戻される）
  try {
    data = sanitize(JSON.parse(fs.readFileSync(localFile, 'utf-8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[${label}] ローカルの ${path.basename(localFile)} を読み込めませんでした:`, error.message);
  }

  return {
    file,
    label,
    get data() {
      return data;
    },
    markDirty,
    flush,
    setSaveHandler,
    importRecords,
  };
}

module.exports = { createJsonStore };