// channel-config.js
// config-channels.json を読むための共通処理。
// 全サーバーの全メッセージで毎回ファイルを読み直さないよう、ファイルの更新時刻が変わったときだけ読み直す。
// （書き込みは各コマンドや web.js が直接行うので、更新時刻で変更を検知する）
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

module.exports = { getChannelConfig, FILE_PATH };
