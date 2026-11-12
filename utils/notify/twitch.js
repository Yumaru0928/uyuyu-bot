// utils/notify/twitch.js
// Twitch の配信開始(stream.online)を EventSub (webhook) で受け取る。
//   必要な環境変数: TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / TWITCH_EVENTSUB_SECRET(10〜100文字の任意の文字列)
//   購読 : Helix の EventSub API（アプリアクセストークン）
//   受信 : POST /webhook/twitch（Twitch-Eventsub-Message-Signature を検証）
const crypto = require('node:crypto');
const { NotifyError, baseUrl, safeEqual, sleep } = require('./common.js');

const HELIX = 'https://api.twitch.tv/helix';
const TIMEOUT_MS = 10000;
const REPLAY_WINDOW_MS = 10 * 60 * 1000; // Twitch の推奨: 10分より古いリクエストは捨てる
const ACTIVE = new Set(['enabled', 'webhook_callback_verification_pending']);

const clientId = () => (process.env.TWITCH_CLIENT_ID || '').trim();
const clientSecret = () => (process.env.TWITCH_CLIENT_SECRET || '').trim();
const secret = () => (process.env.TWITCH_EVENTSUB_SECRET || '').trim();
const callbackUrl = () => `${baseUrl()}/webhook/twitch`;

function enabled() {
    const s = secret();
    return Boolean(clientId() && clientSecret() && s.length >= 10 && s.length <= 100 && baseUrl());
}

// ---------- アプリアクセストークン ----------
let token = null;
let tokenExpires = 0;

async function appToken(force = false) {
    if (!force && token && Date.now() < tokenExpires - 60_000) return token;
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
            client_id: clientId(),
            client_secret: clientSecret(),
            grant_type: 'client_credentials',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Twitch のトークン取得に失敗しました (HTTP ${res.status})`);
    const data = await res.json();
    token = data.access_token;
    tokenExpires = Date.now() + data.expires_in * 1000;
    return token;
}

/** Helix を呼ぶ。401（トークン失効）なら取り直して1回だけやり直す */
async function helix(path, { method = 'GET', body } = {}, retried = false) {
    const res = await fetch(`${HELIX}${path}`, {
        method,
        headers: {
            'Client-Id': clientId(),
            Authorization: `Bearer ${await appToken(retried)}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) return helix(path, { method, body }, true);
    return res;
}

// ---------- ユーザー名 → ID ----------
async function resolve(input) {
    const text = String(input || '').trim();
    const login = (text.match(/twitch\.tv\/([A-Za-z0-9_]{3,25})/i)?.[1] ?? text.replace(/^@/, '')).toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(login)) {
        throw new NotifyError('Twitchのユーザー名（またはチャンネルURL）を入力してください。');
    }
    const res = await helix(`/users?login=${encodeURIComponent(login)}`);
    if (!res.ok) throw new NotifyError(`Twitchの情報を取得できませんでした (HTTP ${res.status})。`);
    const user = (await res.json()).data?.[0];
    if (!user) throw new NotifyError('そのTwitchユーザーが見つかりません。');
    return { targetId: user.id, targetName: user.display_name };
}

// ---------- 購読 ----------
async function listSubscriptions() {
    const all = [];
    let cursor = null;
    do {
        const res = await helix(`/eventsub/subscriptions?type=stream.online${cursor ? `&after=${cursor}` : ''}`);
        if (!res.ok) throw new Error(`EventSub の一覧取得に失敗しました (HTTP ${res.status})`);
        const page = await res.json();
        all.push(...(page.data || []));
        cursor = page.pagination?.cursor || null;
    } while (cursor);
    // このBotのコールバック宛のものだけを扱う（同じアプリの別用途の購読を消さないため）
    return all.filter(sub => sub.transport?.callback === callbackUrl());
}

async function remove(id) {
    const res = await helix(`/eventsub/subscriptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) console.warn(`[Notify/Twitch] 購読 ${id} を削除できませんでした (HTTP ${res.status})`);
}

async function subscribe(broadcasterId) {
    const res = await helix('/eventsub/subscriptions', {
        method: 'POST',
        body: {
            type: 'stream.online',
            version: '1',
            condition: { broadcaster_user_id: broadcasterId },
            transport: { method: 'webhook', callback: callbackUrl(), secret: secret() },
        },
    });
    if (res.status === 409) return; // すでに購読済み
    if (!res.ok) throw new Error(`EventSub の登録に失敗しました (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function unsubscribe(broadcasterId) {
    for (const sub of await listSubscriptions()) {
        if (sub.condition?.broadcaster_user_id === broadcasterId) await remove(sub.id);
    }
}

/** 起動時・定期実行: 実際の購読状態を、設定している内容に合わせる */
async function resync(wanted) {
    let subs;
    try {
        subs = await listSubscriptions();
    } catch (error) {
        console.error('[Notify/Twitch]', error.message);
        return;
    }

    const have = new Set();
    for (const sub of subs) {
        const id = sub.condition?.broadcaster_user_id;
        if (!ACTIVE.has(sub.status) || !wanted.has(id)) {
            await remove(sub.id); // 失敗状態のもの・もう要らないものは削除（失敗状態は作り直す）
        } else {
            have.add(id);
        }
    }
    for (const id of wanted) {
        if (have.has(id)) continue;
        try {
            await subscribe(id);
        } catch (error) {
            console.error(`[Notify/Twitch] ${id} の購読に失敗しました:`, error.message);
        }
    }
}

// ---------- 受信 ----------
function verifySignature(rawBody, headers) {
    const id = headers['twitch-eventsub-message-id'];
    const timestamp = headers['twitch-eventsub-message-timestamp'];
    const signature = headers['twitch-eventsub-message-signature'];
    if (!id || !timestamp || !signature || !secret()) return false;

    const sent = Date.parse(timestamp);
    if (!Number.isFinite(sent) || Math.abs(Date.now() - sent) > REPLAY_WINDOW_MS) return false;

    const expected = 'sha256=' + crypto.createHmac('sha256', secret())
        .update(id + timestamp).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
}

/**
 * Twitch からの通知（POST）。
 * @returns {{status:number, body?:string, event?:object}}
 */
function handleWebhook(rawBody, headers) {
    if (!verifySignature(rawBody, headers)) return { status: 403 };

    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
        return { status: 400 };
    }

    switch (headers['twitch-eventsub-message-type']) {
        case 'webhook_callback_verification':
            return { status: 200, body: String(payload.challenge ?? '') };
        case 'revocation':
            console.warn(`[Notify/Twitch] 購読が取り消されました: ${payload.subscription?.status} (${payload.subscription?.type})`);
            return { status: 204 };
        case 'notification': {
            const event = payload.event || {};
            // type は live のほか rerun / premiere などもある。通常の配信開始だけ通知する
            if (payload.subscription?.type !== 'stream.online' || event.type !== 'live') return { status: 204 };
            return {
                status: 204,
                event: {
                    targetId: event.broadcaster_user_id,
                    id: event.id || headers['twitch-eventsub-message-id'], // 配信ID（再送されても同じ）
                    name: event.broadcaster_user_name,
                    login: event.broadcaster_user_login,
                },
            };
        }
        default:
            return { status: 204 };
    }
}

/** 配信タイトルとゲーム名（配信開始直後はまだ取れないことがあるので少し待つ）。取れなければ null */
async function fetchStreamInfo(broadcasterId) {
    try {
        await sleep(4000);
        const res = await helix(`/streams?user_id=${encodeURIComponent(broadcasterId)}`);
        if (!res.ok) return null;
        const stream = (await res.json()).data?.[0];
        return stream ? { title: stream.title, game: stream.game_name } : null;
    } catch {
        return null;
    }
}

module.exports = { enabled, resolve, subscribe, unsubscribe, resync, handleWebhook, fetchStreamInfo };
