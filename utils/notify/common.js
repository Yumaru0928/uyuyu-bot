// utils/notify/common.js
// YouTube / Twitch / X の通知で共通して使う小さな道具。
const crypto = require('node:crypto');

/** 画面に見せてよいエラー（それ以外のエラーは「内部エラー」として扱う） */
class NotifyError extends Error {}

/**
 * 外部サービスがこのBotにPOSTしてくる先のオリジン（https 必須）。
 * PUBLIC_BASE_URL があればそれを、無ければダッシュボードの CALLBACK_URL から取る。
 * https でなければ null（YouTube / Twitch は https の公開URLにしか送ってくれない）。
 */
function baseUrl() {
    const raw = (process.env.PUBLIC_BASE_URL || '').trim() || (process.env.CALLBACK_URL || '').trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' ? url.origin : null;
    } catch {
        return null;
    }
}

/** 署名の比較（長さが違っても例外にならず、タイミング攻撃にも強い） */
function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** XMLの文字参照を戻す（フィードのタイトル用） */
function decodeXml(text) {
    return String(text)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}

module.exports = { NotifyError, baseUrl, safeEqual, sleep, decodeXml };
