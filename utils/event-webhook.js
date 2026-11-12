const crypto = require('crypto');
const { getOwnerId, recordAuthorized, recordDeauthorized } = require('./installs.js');

// Ed25519の公開鍵(32バイト)をNodeのcryptoで読める形式(SPKI/DER)にするための固定ヘッダ
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** DiscordのEd25519署名を検証する（署名対象は timestamp + 生のリクエスト本文） */
function verifySignature(rawBody, signatureHex, timestamp, publicKeyHex) {
    try {
        const key = crypto.createPublicKey({
            key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
            format: 'der',
            type: 'spki',
        });
        return crypto.verify(
            null,
            Buffer.concat([Buffer.from(timestamp), rawBody]),
            key,
            Buffer.from(signatureHex, 'hex'),
        );
    } catch {
        return false;
    }
}

/** 検知したインストール/削除を、Botの所有者にDMで知らせる（INSTALL_NOTIFY=0 で無効） */
async function notifyOwner(client, text) {
    if (!text || process.env.INSTALL_NOTIFY === '0') return;
    const ownerId = await getOwnerId(client);
    if (!ownerId) return;
    const owner = await client.users.fetch(ownerId);
    await owner.send({ content: text, allowedMentions: { parse: [] } });
}

async function handleEvent(client, event) {
    const data = event.data ?? {};
    switch (event.type) {
        case 'APPLICATION_AUTHORIZED':
            await notifyOwner(client, recordAuthorized(data));
            break;
        case 'APPLICATION_DEAUTHORIZED':
            await notifyOwner(client, recordDeauthorized(data));
            break;
    }
}

/**
 * Discordからのイベント通知（POST）を検証して処理する。
 * @param {import('discord.js').Client} client
 * @param {Buffer} rawBody - 加工していない生のリクエスト本文
 * @param {Record<string, string|undefined>} headers - 小文字化されたヘッダ
 * @returns {number} 返すHTTPステータス（成功は204）
 */
function processEvent(client, rawBody, headers) {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
        console.error('環境変数 DISCORD_PUBLIC_KEY が未設定です。');
        return 500;
    }

    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];
    if (!signature || !timestamp || !verifySignature(rawBody, signature, timestamp, publicKey)) {
        return 401; // 署名が不正な場合は必ず401（Discordの要件）
    }

    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
        return 400;
    }

    if (payload.type === 1 && payload.event) {
        // 先に204を返してから処理する（Discordは素早い応答を求める）
        handleEvent(client, payload.event).catch((err) =>
            console.error('インストールイベントの処理に失敗しました:', err.message),
        );
    }
    return 204; // type 0 (PING) もここで204
}

module.exports = { processEvent, verifySignature };