// utils/notify/index.js
// YouTube / Twitch / X の通知の本体。
//   ・サーバーごとの設定は config-channels.json の guildConfig.notifications（配列）に保存する
//     （ダッシュボードの他の設定と同じく、GitHub の data ブランチにも反映される）
//   ・同じチャンネルを複数のサーバーが登録しても、外部サービスへの購読は1つだけにする
//   ・購読・受信の細かい処理は youtube.js / twitch.js / x.js
const crypto = require('node:crypto');
const { PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { getChannelConfig, updateChannelConfig, ensureGuildConfig } = require('../../channel-config.js');
const { NotifyError } = require('./common.js');

const providers = {
    youtube: require('./youtube.js'),
    twitch: require('./twitch.js'),
    x: require('./x.js'),
};

const PLATFORMS = [
    { id: 'youtube', label: 'YouTube', placeholder: '@ハンドル / チャンネルURL / チャンネルID (UC…)', help: '新しい動画・ライブ配信の作成を通知します。' },
    { id: 'twitch', label: 'Twitch', placeholder: 'ユーザー名 または チャンネルURL', help: '配信の開始を通知します。' },
    { id: 'x', label: 'X (Twitter)', placeholder: '@ユーザー名', help: '無料で使えるWebhookが無いため準備中です。' },
];

const MAX_PER_GUILD = 10;
const RESYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

// ---------- 設定の読み書き ----------
const guildList = guildId => {
    const list = getChannelConfig()[guildId]?.notifications;
    return Array.isArray(list) ? list : [];
};

/** Botが今いるサーバーの登録だけを返す（抜けたサーバーの分で購読を持ち続けない） */
function activeEntries(client, platform) {
    const result = [];
    for (const [guildId, guildConfig] of Object.entries(getChannelConfig())) {
        if (!client.guilds.cache.has(guildId) || !Array.isArray(guildConfig?.notifications)) continue;
        for (const entry of guildConfig.notifications) {
            if (!platform || entry.platform === platform) result.push({ ...entry, guildId });
        }
    }
    return result;
}

const wantedTargets = (client, platform) => new Set(activeEntries(client, platform).map(e => e.targetId));

function platformInfo() {
    return PLATFORMS.map(p => ({ ...p, enabled: providers[p.id].enabled() }));
}

const labelOf = id => PLATFORMS.find(p => p.id === id)?.label ?? id;

// ---------- 追加・削除（ダッシュボードから） ----------
async function persist(client, guildId, data, message) {
    if (client.commitJsonToGitHub) await client.commitJsonToGitHub('config-channels.json', data, message);
}

/**
 * @param {{platform:string, input:string, channelId:string, roleId:string|null}} form
 *        channelId / roleId は呼び出し側（web.js）で、そのサーバーのものか検証済みであること
 */
async function addSubscription(client, guildId, { platform, input, channelId, roleId }) {
    const provider = providers[platform];
    if (!provider) throw new NotifyError('通知の種類が正しくありません。');
    if (!provider.enabled()) throw new NotifyError(`${labelOf(platform)} の通知は、現在このBotでは利用できません。`);
    if (guildList(guildId).length >= MAX_PER_GUILD) {
        throw new NotifyError(`通知は1サーバーあたり ${MAX_PER_GUILD} 件までです。`);
    }

    const target = await provider.resolve(input);
    if (guildList(guildId).some(e => e.platform === platform && e.targetId === target.targetId && e.channelId === channelId)) {
        throw new NotifyError('同じ通知がすでに登録されています。');
    }

    const entry = {
        id: crypto.randomBytes(4).toString('hex'),
        platform,
        targetId: target.targetId,
        targetName: target.targetName,
        channelId,
        roleId: roleId || null, // 'everyone' なら @everyone
    };

    const alreadyWatched = wantedTargets(client, platform).has(target.targetId);
    const data = updateChannelConfig(config => {
        const guildConfig = ensureGuildConfig(config, guildId);
        guildConfig.notifications = [...(Array.isArray(guildConfig.notifications) ? guildConfig.notifications : []), entry];
    });

    if (!alreadyWatched) {
        try {
            await provider.subscribe(target.targetId);
        } catch (error) {
            console.error(`[Notify] ${platform} の購読に失敗したため、登録を取り消します:`, error);
            const rolledBack = updateChannelConfig(config => {
                const guildConfig = ensureGuildConfig(config, guildId);
                guildConfig.notifications = guildConfig.notifications.filter(e => e.id !== entry.id);
            });
            await persist(client, guildId, rolledBack, `auto: rollback notification in guild ${guildId} [skip render]`);
            throw new NotifyError(`${labelOf(platform)} への購読登録に失敗しました。しばらくしてからもう一度お試しください。`);
        }
    }

    await persist(client, guildId, data, `auto: add ${platform} notification in guild ${guildId} [skip render]`);
    return entry;
}

async function removeSubscription(client, guildId, id) {
    const entry = guildList(guildId).find(e => e.id === id);
    if (!entry) throw new NotifyError('その通知は見つかりません（すでに削除されています）。');

    const data = updateChannelConfig(config => {
        const guildConfig = ensureGuildConfig(config, guildId);
        guildConfig.notifications = guildConfig.notifications.filter(e => e.id !== id);
    });
    await persist(client, guildId, data, `auto: remove ${entry.platform} notification in guild ${guildId} [skip render]`);

    // 他のサーバーが同じ相手を登録していなければ、購読を解除する（失敗しても、次の同期で整理される）
    if (!wantedTargets(client, entry.platform).has(entry.targetId)) {
        try {
            await providers[entry.platform].unsubscribe(entry.targetId);
        } catch (error) {
            console.error(`[Notify] ${entry.platform} の購読解除に失敗しました:`, error.message);
        }
    }
}

// ---------- 通知の送信 ----------
const seen = new Map();
/** すでに処理したイベントなら false。初めてなら記録して true */
function firstTime(key) {
    const now = Date.now();
    for (const [k, expires] of seen) if (expires < now) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, now + SEEN_TTL_MS);
    return true;
}

function mentionOf(roleId) {
    if (roleId === 'everyone') return { prefix: '@everyone ', allowed: { parse: ['everyone'] } };
    if (roleId) return { prefix: `<@&${roleId}> `, allowed: { roles: [roleId] } };
    return { prefix: '', allowed: { parse: [] } };
}

/**
 * 登録しているサーバーすべてに通知を送る。
 * @param {string} platform
 * @param {string} targetId 通知元（YouTubeチャンネルID・TwitchユーザーID など）
 * @param {{ id: string, text: string }} event id は重複排除用、text は本文（メンションは自動で先頭に付く）
 */
async function dispatch(client, platform, targetId, event) {
    if (!firstTime(`${platform}:${event.id}`)) return;

    for (const entry of activeEntries(client, platform).filter(e => e.targetId === targetId)) {
        try {
            const guild = client.guilds.cache.get(entry.guildId);
            const channel = guild?.channels.cache.get(entry.channelId);
            if (!channel?.isTextBased()) continue;

            const permissions = channel.permissionsFor(guild.members.me);
            if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                console.warn(`[Notify] #${channel.name} (${guild.name}) に送信する権限がありません。`);
                continue;
            }

            const mention = mentionOf(entry.roleId);
            await channel.send({ content: mention.prefix + event.text, allowedMentions: mention.allowed });
        } catch (error) {
            console.error(`[Notify] ${entry.guildId} への通知に失敗しました:`, error);
        }
    }
}

// ---------- Webhook の受け口（web.js から呼ぶ） ----------
const webhooks = {
    youtubeVerify(client, query) {
        return providers.youtube.handleVerify(query, wantedTargets(client, 'youtube'));
    },

    youtubeNotify(client, rawBody, headers) {
        const { status, event } = providers.youtube.handleNotify(rawBody, headers);
        if (event) {
            const text = `📺 **${escapeMarkdown(event.name || 'YouTube')}** が新しい動画・配信を投稿しました！\n` +
                `${escapeMarkdown(event.title || '')}\n${event.url}`;
            dispatch(client, 'youtube', event.targetId, { id: event.id, text })
                .catch(error => console.error('[Notify/YouTube]', error));
        }
        return status;
    },

    twitch(client, rawBody, headers) {
        const { status, body, event } = providers.twitch.handleWebhook(rawBody, headers);
        if (event && firstTimePeek(`twitch:${event.id}`)) {
            sendTwitch(client, event).catch(error => console.error('[Notify/Twitch]', error));
        }
        return { status, body };
    },
};

// Twitch は配信情報の取得で数秒待つので、待つ前に「処理済みか」だけ先に調べる
const firstTimePeek = key => !seen.has(key);

async function sendTwitch(client, event) {
    if (activeEntries(client, 'twitch').every(e => e.targetId !== event.targetId)) return;
    const info = await providers.twitch.fetchStreamInfo(event.targetId);
    const lines = [`🔴 **${escapeMarkdown(event.name || event.login)}** が配信を開始しました！`];
    if (info?.title) lines.push(escapeMarkdown(info.title) + (info.game ? `（${escapeMarkdown(info.game)}）` : ''));
    lines.push(`https://www.twitch.tv/${event.login}`);
    await dispatch(client, 'twitch', event.targetId, { id: event.id, text: lines.join('\n') });
}

// ---------- 起動 ----------
let started = false;

function start(client) {
    if (started) return;
    started = true;

    const active = PLATFORMS.filter(p => providers[p.id].enabled());
    if (!active.length) {
        console.log('[Notify] 通知機能は無効です（PUBLIC_BASE_URL / YOUTUBE_WEBSUB_SECRET / TWITCH_* の環境変数が未設定）。');
        return;
    }
    console.log(`[Notify] 有効な通知: ${active.map(p => p.label).join(', ')}`);

    const resyncAll = async () => {
        for (const p of active) {
            try {
                await providers[p.id].resync(wantedTargets(client, p.id));
            } catch (error) {
                console.error(`[Notify/${p.label}] 同期に失敗しました:`, error);
            }
        }
    };
    resyncAll();
    setInterval(resyncAll, RESYNC_INTERVAL_MS).unref();
}

module.exports = {
    start, platformInfo, labelOf, MAX_PER_GUILD,
    addSubscription, removeSubscription, listSubscriptions: guildList,
    dispatch, webhooks, NotifyError,
};
