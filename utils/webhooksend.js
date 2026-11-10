const {
    PermissionsBitField,
    ChannelType,
    AttachmentBuilder,
    StickerFormatType,
    escapeMarkdown,
} = require('discord.js');

// ---------------------------------------------------------------
// キャッシュ / ロック
// ---------------------------------------------------------------
/** channelId -> Webhook */
const webhookCache = new Map();
/** `${転送先チャンネルID}:${送信元チャンネルID}` -> スレッドID */
const threadCache = new Map();
/** 同じスレッドへの同時送信（スレッド二重作成・順序入れ替わり）を防ぐロック */
const locks = new Map();

function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => {
        if (locks.get(key) === next) locks.delete(key);
    }).catch(() => {});
    return next;
}

// ---------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------

/**
 * 送信場所の文字列表記を取得（フォーラムのスレッド名に使用）
 * 形式: サーバー名 | カテゴリ名 | #チャンネル名 -> スレッド名
 * （スレッド内の発言でなければ " -> スレッド名" は付かない）
 * @param {import('discord.js').Message} message
 * @returns {string}
 */
function getLocationString(message) {
    if (!message.guild) return 'DM';

    const isThread = message.channel.isThread();
    const base = isThread ? message.channel.parent : message.channel;

    const category = base?.parent?.name ?? 'カテゴリなし';
    const channelName = base?.name ?? '不明なチャンネル';

    let text = `${message.guild.name} | ${category} | #${channelName}`;
    if (isThread) text += ` -> ${message.channel.name}`;
    return text;
}

/**
 * 送信元チャンネルの種類をタグ名で返す（スレッドの場合は親チャンネルの種類）
 * @param {import('discord.js').Message} message
 * @returns {string|null}
 */
function getChannelTypeLabel(message) {
    const base = message.channel.isThread() ? message.channel.parent : message.channel;
    switch (base?.type) {
        case ChannelType.GuildAnnouncement:
            return '📢アナウンス';
        case ChannelType.GuildText:
            return '📝テキスト';
        case ChannelType.GuildVoice:
        case ChannelType.GuildStageVoice:
            return '🔊VC';
        case ChannelType.GuildForum:
        case ChannelType.GuildMedia:
            return '💭フォーラム';
        default:
            return null;
    }
}

/**
 * フォーラムから同名タグのIDを取得。なければタグを作成する（要「チャンネルの管理」権限）
 * @returns {Promise<string|null>}
 */
async function ensureForumTag(forum, tagName) {
    if (!tagName) return null;

    const find = (f) => f.availableTags.find((t) => t.name === tagName)?.id ?? null;

    const existing = find(forum);
    if (existing) return existing;

    return withLock(`tag:${forum.id}`, async () => {
        const again = find(forum);
        if (again) return again;

        try {
            if (forum.availableTags.length >= 20) return null; // タグ上限
            const updated = await forum.setAvailableTags([
                ...forum.availableTags,
                { name: tagName },
            ]);
            return find(updated);
        } catch (err) {
            console.warn(`タグ「${tagName}」を作成できませんでした:`, err.message);
            return null;
        }
    });
}

/** Webhookのusernameの制約（1〜80文字、clyde/discordを含められない）に合わせる */
function sanitizeUsername(name) {
    let n = (name || 'Unknown').replace(/(clyde|discord)/gi, (m) => m[0] + '\u200b' + m.slice(1));
    n = n.slice(0, 80).trim();
    return n || 'Unknown';
}

/** 2000文字制限に合わせて分割（改行 > スペース の順で切る） */
function splitText(text, limit = 2000) {
    const out = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
        if (cut <= 0) cut = limit;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length) out.push(rest);
    return out;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/** Botが作成したWebhookを取得（なければ作成）。結果はキャッシュ */
async function getWebhook(channel, client) {
    const cached = webhookCache.get(channel.id);
    if (cached) return cached;

    const hooks = await channel.fetchWebhooks();
    let webhook = hooks.find((wh) => wh.owner?.id === client.user.id && wh.token);

    if (!webhook) {
        webhook = await channel.createWebhook({
            name: 'EmojiProxyWebhook',
            reason: 'ユーザーのメッセージ偽装・代行用',
        });
    }
    webhookCache.set(channel.id, webhook);
    return webhook;
}

/** フォーラム内から同名の既存スレッドを探す（キャッシュ → アクティブ → アーカイブ済み） */
async function findExistingThread(forum, key, name) {
    const cachedId = threadCache.get(key);
    if (cachedId) {
        const t = await forum.threads.fetch(cachedId).catch(() => null);
        if (t) return t;
        threadCache.delete(key);
    }

    let t = forum.threads.cache.find((x) => x.name === name);
    if (t) return t;

    const active = await forum.threads.fetchActive().catch(() => null);
    t = active?.threads.find((x) => x.name === name);
    if (t) return t;

    const archived = await forum.threads.fetchArchived({ fetchAll: true }).catch(() => null);
    return archived?.threads.find((x) => x.name === name) ?? null;
}

/** 添付ファイルが大きすぎる等で失敗した場合はURLリンクに置き換えて再送 */
async function safeSend(webhook, payload) {
    try {
        return await webhook.send(payload);
    } catch (err) {
        if (err.code === 10015) webhookCache.delete(webhook.channelId); // Webhookが消された

        if (payload.files?.length && err.code !== 10015) {
            const urls = payload.files.map((f) => f.attachment);
            const content = [payload.content, ...urls].filter(Boolean).join('\n').slice(0, 2000);
            return await webhook.send({ ...payload, files: undefined, content });
        }
        throw err;
    }
}

// ---------------------------------------------------------------
// 送信内容の組み立て（返信 / 転送 / 添付 / スタンプ / Embed）
// ---------------------------------------------------------------
async function buildParts(message, contentToSend) {
    const lines = [];
    const files = [];
    const embeds = [];

    const addAttachments = (collection) => {
        if (!collection) return;
        for (const a of collection.values()) {
            files.push(new AttachmentBuilder(a.url, { name: a.name, description: a.description ?? undefined }));
        }
    };
    const addRichEmbeds = (list) => {
        for (const e of list ?? []) {
            if (e.data?.type === 'rich') embeds.push(e.data);
        }
    };

    const snapshots = message.messageSnapshots; // discord.js v14.17+ の転送メッセージ
    const isForward = !!snapshots && snapshots.size > 0;

    // --- 返信 ---
    if (!isForward && message.reference?.messageId) {
        const ref = await message.fetchReference().catch(() => null);
        if (ref) {
            const refName = ref.member?.displayName ?? ref.author.globalName ?? ref.author.username;
            let snippet = (ref.content ?? '').replace(/\s+/g, ' ').trim();
            if (!snippet) {
                snippet = ref.attachments.size ? '(添付ファイル)' : ref.embeds.length ? '(埋め込み)' : '(内容なし)';
            }
            if (snippet.length > 80) snippet = snippet.slice(0, 80) + '…';
            lines.push(`-# ↩ **${escapeMarkdown(refName)}** への返信: ${snippet} [↗](${ref.url})`);
        } else {
            lines.push('-# ↩ 削除された（または取得できない）メッセージへの返信');
        }
    }

    // --- 本文 ---
    if (contentToSend && contentToSend.trim()) lines.push(contentToSend);

    // --- 転送 ---
    if (isForward) {
        for (const snap of snapshots.values()) {
            const text = (snap.content ?? '').trim();
            lines.push('-# ↪ 転送されたメッセージ');
            if (text) lines.push(text.split('\n').map((l) => `> ${l}`).join('\n'));
            addAttachments(snap.attachments);
            addRichEmbeds(snap.embeds);
        }
    }

    // --- 添付ファイル / Embed ---
    addAttachments(message.attachments);
    addRichEmbeds(message.embeds);

    // --- スタンプ（Webhookはスタンプを送れないので画像として表示） ---
    for (const s of message.stickers?.values() ?? []) {
        if (s.format === StickerFormatType.Lottie) {
            lines.push(`[スタンプ: ${s.name}]`);
        } else {
            embeds.push({ image: { url: s.url } });
        }
    }

    return {
        texts: splitText(lines.join('\n')),
        fileChunks: chunk(files, 10), // 1メッセージ最大10ファイル
        embeds: embeds.slice(0, 10),  // 1メッセージ最大10 Embed
    };
}

// ---------------------------------------------------------------
// メイン
// ---------------------------------------------------------------
/**
 * Webhookでユーザーになりすましてメッセージを送信する。
 * 転送先がフォーラムの場合は、同名スレッドがあれば再利用し、なければ新規作成する。
 *
 * @param {import('discord.js').Message} message - 元のメッセージ
 * @param {import('discord.js').TextBasedChannel|import('discord.js').ForumChannel} targetChannel
 * @param {string} contentToSend - 本文
 * @param {Object} [options]
 * @param {string} [options.threadTitle] - フォーラムのスレッド名（省略時は送信場所の文字列）
 * @param {string[]} [options.appliedTags] - 新規スレッドに追加で付けるタグID（チャンネルタイプのタグは自動で付く）
 * @param {boolean} [options.deleteOriginal=true] - 送信成功後に元メッセージを削除するか
 */
async function sendAsUser(message, targetChannel, contentToSend, options = {}) {
    const { threadTitle, appliedTags, deleteOriginal = true } = options;

    if (!message.guild || !targetChannel) {
        throw new Error('ギルドまたはターゲットチャンネルが無効です。');
    }

    // Webhookは親チャンネルに作る（ターゲットがスレッドの場合はthreadIdで指定）
    const targetIsThread = targetChannel.isThread?.() ?? false;
    const hookChannel = targetIsThread ? targetChannel.parent : targetChannel;
    const isForum =
        hookChannel.type === ChannelType.GuildForum || hookChannel.type === ChannelType.GuildMedia;

    // 1. 権限確認（転送先チャンネルでの権限を見る）
    const guild = hookChannel.guild;
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!hookChannel.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageWebhooks)) {
        throw new Error('Botに「ウェブフックの管理」権限がありません。');
    }

    const location = getLocationString(message);
    const threadName = (threadTitle || location).slice(0, 100);
    const threadKey = `${hookChannel.id}:${message.channel.id}`;

    // 2. 送信内容を組み立て
    const { texts, fileChunks, embeds } = await buildParts(message, contentToSend);

    const payloads = [];
    if (texts.length || fileChunks.length || embeds.length) {
        payloads.push({
            content: texts[0] || undefined,
            files: fileChunks[0],
            embeds: embeds.length ? embeds : undefined,
        });
        for (const t of texts.slice(1)) payloads.push({ content: t });
        for (const f of fileChunks.slice(1)) payloads.push({ files: f });
    }

    const webhook = await getWebhook(hookChannel, message.client);
    if (!payloads.length) return { location, webhook, threadId: null, messages: [] };

    // 3. 表示名・アイコン（サーバーニックネーム/サーバーアバター優先）
    const username = sanitizeUsername(
        message.member?.displayName ?? message.author.globalName ?? message.author.username,
    );
    const avatarURL = (message.member ?? message.author).displayAvatarURL({ size: 256 });

    // 4. 送信（同じスレッド宛ては直列化）
    const result = await withLock(threadKey, async () => {
        let threadId = targetIsThread ? targetChannel.id : null;

        // フォーラム: 既存スレッドを探して再利用
        if (isForum && !threadId) {
            const thread = await findExistingThread(hookChannel, threadKey, threadName);
            if (thread) {
                if (thread.archived) await thread.setArchived(false).catch(() => {});
                threadId = thread.id;
                threadCache.set(threadKey, threadId);
            }
        }

        // 新規スレッドを作る場合は、チャンネルタイプのタグを付ける
        const newThreadTags = [...(appliedTags ?? [])];
        if (isForum && !threadId) {
            const typeTagId = await ensureForumTag(hookChannel, getChannelTypeLabel(message));
            if (typeTagId && !newThreadTags.includes(typeTagId)) newThreadTags.push(typeTagId);
        }

        const sent = [];
        for (const p of payloads) {
            const data = {
                username,
                avatarURL,
                allowedMentions: { parse: [] }, // @everyone やロールメンションを無効化
                ...p,
            };

            if (threadId) {
                data.threadId = threadId;
            } else if (isForum) {
                data.threadName = threadName; // 初回のみ新規スレッド作成
                if (newThreadTags.length) data.appliedTags = newThreadTags;
            }

            const msg = await safeSend(webhook, data);
            sent.push(msg);

            // 新規作成されたスレッドIDを控えて、以降はそのスレッドに送る
            if (isForum && !threadId) {
                threadId = msg.channelId ?? msg.channel_id;
                threadCache.set(threadKey, threadId);
            }
        }
        return { threadId, sent };
    });

    // 5. 送信成功後に元メッセージを削除
    if (deleteOriginal) {
        await message.delete().catch(() => {});
    }

    return { location, webhook, threadId: result.threadId, messages: result.sent };
}

module.exports = { sendAsUser, getLocationString, getChannelTypeLabel };