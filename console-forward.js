// console-forward.js
// console.log / console.warn / console.error の出力を、通常のコンソール(Renderのログ)に出したまま、
// Discordの指定チャンネルにも送るためのモジュール。
//
// 使い方(index.js):
//   const consoleForward = require('./console-forward.js');
//   consoleForward.install();                 // できるだけ最初に呼ぶ。以降は全ファイルの console が対象になる
//   consoleForward.attach(client, channelId); // client を作ったあとに呼ぶ
//
// ・events / commands など、どのファイルから呼ばれた console でも転送される(console はグローバルなため)
// ・Bot がログインするまでの出力は溜めておき、ログイン後にまとめて送る
// ・連投で Discord のレート制限に当たらないよう、2秒ごとに1つのメッセージへまとめて送る
// ・Error オブジェクトはスタックトレースごと文字にする
// ・トークンなどの秘密情報は *** に置き換える
// ・転送の失敗でBot本来の処理は止めない。失敗は元の console.error に出すだけで、再び転送はしない(無限ループ防止)
const util = require('node:util');

const FLUSH_INTERVAL_MS = 2000;   // まとめて送る間隔
const MAX_QUEUE = 200;            // 送信待ちの上限。超えたら古いものから捨てる
const MAX_ENTRY_LENGTH = 1500;    // 1回の console 出力で送る最大文字数
const MAX_BLOCK_LENGTH = 1900;    // 1メッセージのコードブロックに入れる最大文字数(Discordの上限2000文字から余裕を引いた値)

const LABELS = {
    log: 'ℹ️ [LOG]',
    warn: '⚠️ [WARN]',
    error: '🚨 [ERROR]'
};

// 値を伏せる環境変数
const SECRET_ENV_NAMES = ['DISCORD_TOKEN', 'GITHUB_TOKEN', 'GEMINI_API_KEY', 'CLIENT_SECRET', 'SESSION_SECRET'];
// 値が環境変数に無くても、形で見分けて伏せるもの
const SECRET_PATTERNS = [
    /[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g, // Discord Bot トークン
    /gh[pousr]_[A-Za-z0-9]{20,}/g,           // GitHub トークン
    /AIza[0-9A-Za-z_-]{30,}/g,               // Google API キー
    /Bearer\s+[\w.~+\/-]+=*/gi               // Authorization ヘッダー
];

const originals = {};   // 差し替える前の console.log / warn / error
const queue = [];       // 送信待ち
let dropped = 0;        // 上限を超えて捨てた件数
let installed = false;
let client = null;
let channelId = null;
let channel = null;
let timer = null;
let flushing = false;
let channelErrorShown = false;

function redact(text) {
    let result = text;
    for (const name of SECRET_ENV_NAMES) {
        const value = process.env[name];
        if (value && value.length >= 8) result = result.split(value).join('***');
    }
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, '***');
    }
    return result;
}

function toText(args) {
    let text;
    try {
        text = util.format(...args); // Error はスタックトレースつきの文字になる。循環参照があっても落ちない
    } catch {
        text = '(表示できない値)';
    }
    text = redact(text).replace(/```/g, '`​``'); // コードブロックを壊さないようにする
    if (text.length > MAX_ENTRY_LENGTH) {
        text = `${text.slice(0, MAX_ENTRY_LENGTH)}…(あと${text.length - MAX_ENTRY_LENGTH}文字省略)`;
    }
    return text;
}

function enqueue(level, args) {
    if (!channelId) return; // 転送先が決まっていなければ何もしない
    const text = toText(args);
    if (!text.trim()) return;
    if (queue.length >= MAX_QUEUE) {
        queue.shift();
        dropped++;
    }
    queue.push(`${LABELS[level]} ${text}`);
}

// 行を、1メッセージに収まる大きさごとにまとめる
function chunkLines(lines, limit) {
    const chunks = [];
    let current = '';
    for (const line of lines) {
        if (current && current.length + 1 + line.length > limit) {
            chunks.push(current);
            current = '';
        }
        current = current ? `${current}\n${line}` : line;
    }
    if (current) chunks.push(current);
    return chunks;
}

async function getChannel() {
    if (channel) return channel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (fetched && typeof fetched.send === 'function') {
            channel = fetched;
            return channel;
        }
        throw new Error('テキストチャンネルではありません');
    } catch (error) {
        if (!channelErrorShown) {
            channelErrorShown = true;
            originals.error('[console-forward] ログ用チャンネルを取得できません。次回また試します:', error.message);
        }
        return null;
    }
}

async function flush() {
    if (flushing || !client || !client.isReady() || queue.length === 0) return;
    flushing = true;
    try {
        const target = await getChannel();
        if (!target) return; // 取得できない間は溜めておく(上限を超えたら古いものから捨てる)

        const lines = queue.splice(0);
        if (dropped > 0) {
            lines.unshift(`(… ${dropped}件のログは多すぎたため省略しました)`);
            dropped = 0;
        }
        for (const chunk of chunkLines(lines, MAX_BLOCK_LENGTH)) {
            try {
                await target.send({
                    content: `\`\`\`\n${chunk}\n\`\`\``,
                    allowedMentions: { parse: [] } // ログに含まれる @ で誰かに通知が飛ばないようにする
                });
            } catch (error) {
                // 転送側のエラーを console.error に出すと自分自身に戻ってくるため、元の関数に出す
                originals.error('[console-forward] ログの送信に失敗しました:', error.message);
            }
        }
    } finally {
        flushing = false;
    }
}

// console.log / warn / error を差し替える。何度呼んでも1回だけ
function install() {
    if (installed) return;
    installed = true;
    for (const level of Object.keys(LABELS)) {
        const original = console[level].bind(console);
        originals[level] = original;
        console[level] = (...args) => {
            original(...args); // いつもどおりコンソールにも出す
            try {
                enqueue(level, args);
            } catch {
                // 転送の準備で失敗しても、呼び出し元には影響させない
            }
        };
    }
}

// 転送先を設定し、定期的な送信を始める。Botがログインするまでの出力は、ログイン後に送られる
function attach(discordClient, targetChannelId) {
    install();
    client = discordClient;
    channelId = targetChannelId;
    channel = null;
    channelErrorShown = false;
    if (timer) clearInterval(timer);
    timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { install, attach, _flush: flush, _queue: queue };
