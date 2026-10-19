// channel-config.js
// config-channels.json を読み書きするための共通処理。
//
// 読み込み: 全サーバーの全メッセージで毎回ファイルを読み直さないよう、ファイルの更新時刻が変わったときだけ読み直す。
// 書き込み: コマンドやダッシュボードで同じ「読む → 変更 → 書く」処理が重複していたので、ここにまとめた。
//          一時ファイルに書いてから置き換えるため、書き込み途中でプロセスが止まっても設定ファイルは壊れない。
const fs = require('node:fs');
const path = require('node:path');

const FILE_PATH = path.join(__dirname, 'config-channels.json');

let cache = {};
let cachedMtime = -1;

function getChannelConfig() {
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(FILE_PATH).mtimeMs;
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('設定ファイルの確認エラー:', error);
        cache = {};
        cachedMtime = -1;
        return cache;
    }

    if (mtimeMs !== cachedMtime) {
        cachedMtime = mtimeMs; // 壊れていても同じ内容で読み直し続けないよう、先に更新時刻を記録する
        try {
            cache = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        } catch (error) {
            console.error('設定ファイルの読み込みエラー（直前の内容を使い続けます）:', error);
        }
    }
    return cache;
}

// 設定を書き換える。mutator(configData) の中で configData を直接変更する。
// ファイルが壊れていて読めないときは、空の設定で上書きしてしまわないよう例外を投げる。
// 戻り値: 保存した設定（GitHub への反映にそのまま渡せる）
function updateChannelConfig(mutator) {
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

    mutator(data);

    const tmpPath = `${FILE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 4), 'utf8');
    fs.renameSync(tmpPath, FILE_PATH);

    // 直後の読み込みで必ず最新が返るよう、キャッシュも更新しておく
    cache = data;
    try {
        cachedMtime = fs.statSync(FILE_PATH).mtimeMs;
    } catch {
        cachedMtime = -1;
    }
    return data;
}

// サーバーごとの設定オブジェクトを取り出す（無ければ作る）
function ensureGuildConfig(data, guildId) {
    if (!data[guildId] || typeof data[guildId] !== 'object') data[guildId] = {};
    return data[guildId];
}

module.exports = { getChannelConfig, updateChannelConfig, ensureGuildConfig, FILE_PATH };
