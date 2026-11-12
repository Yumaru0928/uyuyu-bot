// utils/notify/youtube.js
// YouTube の新着（動画・ライブ配信の作成）を WebSub (PubSubHubbub) で受け取る。
//   購読 : https://pubsubhubbub.appspot.com/subscribe に POST（有効期限 lease があるので定期的に再購読）
//   受信 : POST /webhook/youtube（X-Hub-Signature を YOUTUBE_WEBSUB_SECRET で検証）
const crypto = require('node:crypto');
const { NotifyError, baseUrl, safeEqual, decodeXml } = require('./common.js');

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const LEASE_SECONDS = 5 * 24 * 60 * 60; // 5日。再購読は12時間ごとに行うので余裕がある
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 公開から2日以上たった動画の「更新通知」は無視する
const TIMEOUT_MS = 10000;
const CHANNEL_ID = /^UC[\w-]{22}$/;

const secret = () => (process.env.YOUTUBE_WEBSUB_SECRET || '').trim();
const callbackUrl = () => `${baseUrl()}/webhook/youtube`;
const topicOf = channelId => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;

function enabled() {
    return Boolean(secret() && baseUrl());
}

/** フィード(videos.xml)からチャンネル名を取る。存在しないIDならここで弾ける */
async function fetchChannelName(channelId) {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) throw new NotifyError('そのYouTubeチャンネルが見つかりません。');
    if (!res.ok) throw new NotifyError(`YouTubeの情報を取得できませんでした (HTTP ${res.status})。`);
    const xml = await res.text();
    return decodeXml(xml.match(/<title>([^<]*)<\/title>/)?.[1] ?? channelId);
}

/** 入力（チャンネルID / チャンネルURL / @ハンドル / ハンドルのURL）から { targetId, targetName } を作る */
async function resolve(input) {
    const text = String(input || '').trim();
    let channelId = CHANNEL_ID.test(text) ? text : text.match(/youtube\.com\/channel\/(UC[\w-]{22})/i)?.[1];

    if (!channelId) {
        const handle = text.match(/^(@[\w.-]+)$/)?.[1] ?? text.match(/youtube\.com\/(@[\w.-]+)/i)?.[1];
        if (!handle) throw new NotifyError('YouTubeのチャンネルID(UC…)、チャンネルURL、または @ハンドル を入力してください。');

        // ハンドルからIDへの変換は公式のプッシュ手段が無いので、チャンネルページから読み取る
        const res = await fetch(`https://www.youtube.com/${handle}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; uyuyu-bot)',
                'Accept-Language': 'ja,en;q=0.8',
                Cookie: 'SOCS=CAI; CONSENT=YES+1', // EU向けの同意ページに飛ばされないように
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 404) throw new NotifyError('そのYouTubeチャンネルが見つかりません。');
        const html = res.ok ? await res.text() : '';
        channelId =
            html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
            html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
            html.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
        if (!channelId) {
            throw new NotifyError('ハンドルからチャンネルIDを取得できませんでした。UC から始まるチャンネルIDを直接入力してください。');
        }
    }

    return { targetId: channelId, targetName: await fetchChannelName(channelId) };
}

async function hubRequest(mode, channelId) {
    const res = await fetch(HUB_URL, {
        method: 'POST',
        body: new URLSearchParams({
            'hub.callback': callbackUrl(),
            'hub.topic': topicOf(channelId),
            'hub.verify': 'async',
            'hub.mode': mode,
            'hub.secret': secret(),
            'hub.lease_seconds': String(LEASE_SECONDS),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 受付済みは 202（同期確認なら 204）。実際の確認は、後で GET /webhook/youtube に届く
    if (res.status !== 202 && res.status !== 204) {
        throw new Error(`WebSub hub が ${res.status} を返しました: ${(await res.text()).slice(0, 200)}`);
    }
}

const subscribe = channelId => hubRequest('subscribe', channelId);
const unsubscribe = channelId => hubRequest('unsubscribe', channelId);

/** 起動時・定期実行: 必要なチャンネルをすべて再購読して lease を延ばす */
async function resync(wanted) {
    for (const channelId of wanted) {
        try {
            await subscribe(channelId);
        } catch (error) {
            console.error(`[Notify/YouTube] ${channelId} の再購読に失敗しました:`, error.message);
        }
    }
}

/** hub からの購読確認（GET）。購読したいチャンネルのときだけ challenge を返す */
function handleVerify(query, wanted) {
    const mode = query['hub.mode'];
    const topic = String(query['hub.topic'] || '');
    const challenge = query['hub.challenge'];
    const channelId = topic.match(/[?&]channel_id=(UC[\w-]{22})/)?.[1];

    if (mode === 'denied') {
        console.warn(`[Notify/YouTube] hub が購読を拒否しました: ${query['hub.reason'] || '(理由なし)'} (${topic})`);
        return { status: 200, body: '' };
    }
    if (!channelId || typeof challenge !== 'string') return { status: 400, body: '' };
    if (mode === 'subscribe' && wanted.has(channelId)) return { status: 200, body: challenge };
    if (mode === 'unsubscribe' && !wanted.has(channelId)) return { status: 200, body: challenge };
    return { status: 404, body: '' };
}

function verifySignature(rawBody, header) {
    const match = /^(sha1|sha256|sha384|sha512)=([0-9a-f]+)$/i.exec(String(header || ''));
    if (!match || !secret()) return false;
    const expected = crypto.createHmac(match[1].toLowerCase(), secret()).update(rawBody).digest('hex');
    return safeEqual(expected, match[2].toLowerCase());
}

function tag(xml, name) {
    const match = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
    return match ? decodeXml(match[1].trim()) : null;
}

function parseFeed(xml) {
    if (/<at:deleted-entry/.test(xml)) return { deleted: true };
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
    if (!entry) return null;
    const author = entry.match(/<author>[\s\S]*?<name>([^<]*)<\/name>/)?.[1];
    return {
        videoId: tag(entry, 'yt:videoId'),
        channelId: tag(entry, 'yt:channelId'),
        title: tag(entry, 'title'),
        published: tag(entry, 'published'),
        author: author ? decodeXml(author) : null,
    };
}

/**
 * hub からの新着通知（POST）。
 * @returns {{status:number, event?:{targetId:string, id:string, text:string}}}
 */
function handleNotify(rawBody, headers) {
    if (!verifySignature(rawBody, headers['x-hub-signature'])) return { status: 403 };

    const feed = parseFeed(rawBody.toString('utf8'));
    if (!feed || feed.deleted || !feed.videoId || !feed.channelId) return { status: 204 };

    // 古い動画のタイトル変更などでも通知が来るので、公開が新しいものだけ通知する
    const published = Date.parse(feed.published || '');
    if (Number.isFinite(published) && Date.now() - published > MAX_AGE_MS) return { status: 204 };

    return {
        status: 204,
        event: {
            targetId: feed.channelId,
            id: feed.videoId, // 同じ動画の更新通知を何度も流さないための目印
            name: feed.author,
            title: feed.title,
            url: `https://www.youtube.com/watch?v=${feed.videoId}`,
        },
    };
}

module.exports = { enabled, resolve, subscribe, unsubscribe, resync, handleVerify, handleNotify };
