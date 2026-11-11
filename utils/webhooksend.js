const {
    PermissionsBitField,
    ChannelType,
    AttachmentBuilder,
    StickerFormatType,
    InteractionType,
    escapeMarkdown,
} = require('discord.js');

// ---------------------------------------------------------------
// 設定
// ---------------------------------------------------------------
const excludeConfig = require('./mirror-exclude.js'); // 監視除外リスト
const getTargetChannelId = () => process.env.TARGET_CHANNEL_ID || '1569502078110408775';
const MAX_TRACKED = 5000;          // 編集・リアクション反映のために覚えておく転送メッセージ数
const REACTION_DEBOUNCE_MS = 1500; // リアクション連打をまとめて反映する待ち時間

// ---------------------------------------------------------------
// キャッシュ / ロック
// ---------------------------------------------------------------
/** channelId -> Webhook */
const webhookCache = new Map();
/** `${転送先チャンネルID}:${送信元チャンネルID}` -> スレッドID */
const threadCache = new Map();
/** 同じスレッドへの同時送信（スレッド二重作成・順序入れ替わり）を防ぐロック */
const locks = new Map();
/** 元メッセージID -> 転送先メッセージの情報（編集・リアクション反映用。再起動で消える） */
const mirrors = new Map();
/** DMへ中継済みのメッセージID（再転送の防止用） */
const relayedIds = new Set();
/** 転送先スレッドの発言ID -> DMへ中継した内容（編集・削除の反映用。再起動で消える） */
const relays = new Map();
/** 中継送信中の発言ID -> Promise */
const relayInflight = new Map();
/** DMチャンネルID -> 中継送信の期限時刻の配列（送信直後の通知を再転送しないための目印） */
const relayPending = new Map();
/** 転送処理中の元メッセージID -> Promise */
const inflight = new Map();
/** リアクション反映のデバウンス用タイマー */
const refreshTimers = new Map();

function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => {
        if (locks.get(key) === next) locks.delete(key);
    }).catch(() => {});
    return next;
}

function rememberMirror(id, entry) {
    mirrors.set(id, entry);
    if (mirrors.size > MAX_TRACKED) mirrors.delete(mirrors.keys().next().value);
}

// ---------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------

/**
 * 送信場所の文字列表記を取得（フォーラムのスレッド名に使用）
 * サーバー内: サーバー名 | カテゴリ名 | #チャンネル名 -> スレッド名
 * DM:        DM | ユーザー名 (ユーザーID)
 * グループDM: グループDM | 名前
 * @param {import('discord.js').Message} message
 * @returns {string}
 */
function getLocationString(message) {
    const channel = message.channel;

    if (!message.guild) {
        if (channel?.type === ChannelType.GroupDM) {
            return `グループDM | ${channel.name ?? channel.id}`;
        }
        // DMの相手（Botのメッセージでも、相手はユーザー側）
        const other = channel?.recipient ?? (message.author?.bot ? null : message.author);
        if (other) return `DM | ${other.globalName ?? other.username} (${other.id})`;
        return `DM | ${message.channelId}`;
    }

    const isThread = channel.isThread();
    const base = isThread ? channel.parent : channel;

    const category = base?.parent?.name ?? 'カテゴリなし';
    const channelName = base?.name ?? '不明なチャンネル';

    let text = `${message.guild.name} | ${category} | #${channelName}`;
    if (isThread) text += ` -> ${channel.name}`;
    return text;
}

/** 送信元チャンネルの種類をタグ名で返す（スレッドの場合は親チャンネルの種類） */
function getChannelTypeLabel(message) {
    const base = message.channel.isThread?.() ? message.channel.parent : message.channel;
    switch (base?.type) {
        case ChannelType.DM:
            return 'DM';
        case ChannelType.GroupDM:
            return 'グループDM';
        case ChannelType.GuildAnnouncement:
            return 'アナウンス';
        case ChannelType.GuildText:
            return 'テキスト';
        case ChannelType.GuildVoice:
        case ChannelType.GuildStageVoice:
            return 'VC';
        case ChannelType.GuildForum:
        case ChannelType.GuildMedia:
            return 'フォーラム';
        default:
            return null;
    }
}

/** フォーラムから同名タグのIDを取得。なければ作成（要「チャンネルの管理」権限） */
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
            const updated = await forum.setAvailableTags([...forum.availableTags, { name: tagName }]);
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
// 転送対象かどうかの判定
// ---------------------------------------------------------------
const toSet = (list, env) =>
    new Set([...(list ?? []), ...(env ? env.split(',') : [])].map((v) => String(v).trim()).filter(Boolean));

const excluded = {
    guilds: toSet(excludeConfig.guilds, process.env.MIRROR_EXCLUDE_GUILDS),
    categories: toSet(excludeConfig.categories, process.env.MIRROR_EXCLUDE_CATEGORIES),
    channels: toSet(excludeConfig.channels, process.env.MIRROR_EXCLUDE_CHANNELS),
    users: toSet(excludeConfig.users, process.env.MIRROR_EXCLUDE_USERS),
};

/** 監視除外リストに該当するか（サーバー / カテゴリ / チャンネル・スレッド / ユーザー・DM相手） */
function isExcluded(message) {
    const ch = message.channel;
    const base = ch?.isThread?.() ? ch.parent : ch;

    if (message.guildId && excluded.guilds.has(message.guildId)) return true;
    if (base?.parentId && excluded.categories.has(base.parentId)) return true;

    for (const id of [message.channelId, base?.id, ch?.parentId]) {
        if (id && excluded.channels.has(id)) return true;
    }
    for (const id of [message.author?.id, ch?.recipient?.id]) {
        if (id && excluded.users.has(id)) return true;
    }
    return false;
}

/**
 * 転送すべきメッセージか判定
 * - サーバー内・DM、人間・Botのどれも対象
 * - システムメッセージ、転送先フォーラム自身のメッセージ（ループ防止）、DMへ中継したメッセージ、
 *   監視除外リストに載っているものは対象外
 */
function shouldMirror(message) {
    if (message.system) return false;
    if (relayedIds.has(message.id)) return false;

    const targetId = getTargetChannelId();
    if (message.channelId === targetId || message.channel?.parentId === targetId) return false;

    if (isExcluded(message)) return false;
    return true;
}

// ---------------------------------------------------------------
// 転送先スレッドでの発言 → DMへ中継
// ---------------------------------------------------------------
function markRelayPending(dmChannelId) {
    const list = relayPending.get(dmChannelId) ?? [];
    list.push(Date.now() + 15_000);
    relayPending.set(dmChannelId, list);
}

/**
 * 中継送信した直後に届く「Bot自身のDMメッセージ」の通知かどうか判定する（1回につき1件消費）。
 * MessageCreateの処理の最初に1回だけ呼ぶこと。
 */
function isRelayEcho(message) {
    if (message.guildId || message.author?.id !== message.client.user?.id) return false;

    const now = Date.now();
    const fresh = (relayPending.get(message.channelId) ?? []).filter((t) => t > now);
    if (!fresh.length) {
        relayPending.delete(message.channelId);
        return false;
    }
    fresh.shift();
    if (fresh.length) relayPending.set(message.channelId, fresh);
    else relayPending.delete(message.channelId);
    return true;
}

function rememberRelayed(id) {
    relayedIds.add(id);
    if (relayedIds.size > 1000) relayedIds.delete(relayedIds.values().next().value);
}

/**
 * 転送先フォーラムの「DM | 名前 (ユーザーID)」スレッドでの発言を、そのユーザーのDMへ送る。
 * 成功したら元の発言に ✅、失敗（DM拒否など）なら ❌ を付ける。
 * @returns {Promise<boolean>} 転送先スレッド内の発言だった場合 true
 */
async function relayToDm(message) {
    const ch = message.channel;
    if (!ch?.isThread?.() || ch.parentId !== getTargetChannelId()) return false;

    // Webhook（転送）やBotの発言、システムメッセージは中継しない
    if (message.author?.bot || message.webhookId || message.system) return true;

    const match = ch.name.match(/^DM \| .* \((\d+)\)$/);
    if (!match) return true; // DM以外のスレッド

    const files = [...message.attachments.values()].map(
        (a) => new AttachmentBuilder(a.url, { name: a.name, description: a.description ?? undefined }),
    );
    const texts = splitText(message.content ?? '');
    const fileChunks = chunk(files, 10);
    if (!texts.length && !fileChunks.length) return true;

    const payloads = texts.map((t, i) => ({ content: t, files: i === 0 ? fileChunks[0] : undefined }));
    if (!texts.length) payloads.push({ files: fileChunks[0] });
    for (const f of fileChunks.slice(1)) payloads.push({ files: f });

    const sentIds = [];
    let dmChannelId = null;

    const job = (async () => {
        try {
            const user = await message.client.users.fetch(match[1]);
            const dm = await user.createDM();
            dmChannelId = dm.id;

            for (const payload of payloads) {
                markRelayPending(dm.id);
                let sent;
                try {
                    sent = await dm.send(payload);
                } catch (err) {
                    if (!payload.files?.length) throw err;
                    // 添付が大きすぎる等はURLリンクにして再送
                    markRelayPending(dm.id);
                    const urls = payload.files.map((f) => f.attachment);
                    sent = await dm.send({
                        content: [payload.content, ...urls].filter(Boolean).join('\n').slice(0, 2000),
                    });
                }
                rememberRelayed(sent.id);
                sentIds.push(sent.id);
            }
            await message.react('✅').catch(() => {});
        } catch (err) {
            console.error('DMへの送信に失敗しました:', err.message);
            await message.react('❌').catch(() => {});
        }

        // 編集・削除を反映できるよう、送れた分を記録する
        if (sentIds.length) {
            relays.set(message.id, {
                dmChannelId,
                messageIds: sentIds,
                textIds: sentIds.slice(0, texts.length), // 本文を持つDMメッセージ
                content: message.content ?? '',
            });
            if (relays.size > MAX_TRACKED) relays.delete(relays.keys().next().value);
        }
    })();

    relayInflight.set(message.id, job);
    try {
        await job;
    } finally {
        relayInflight.delete(message.id);
    }
    return true;
}

/** 転送先スレッドでの発言の編集を、中継済みのDMメッセージに反映する。中継済みの発言なら true */
async function syncRelayEdit(message) {
    await relayInflight.get(message.id)?.catch(() => {});

    const entry = relays.get(message.id);
    if (!entry) return false;

    const newContent = message.content ?? '';
    if (newContent === entry.content) return true; // Embed展開などの更新は無視
    entry.content = newContent;

    try {
        const dm = await message.client.channels.fetch(entry.dmChannelId);
        const texts = splitText(newContent);

        if (!texts.length && entry.textIds[0]) {
            // 本文を空にした（添付だけ残る）場合
            await dm.messages.edit(entry.textIds[0], { content: '' }).catch(() => {});
        }
        for (let i = 0; i < texts.length; i++) {
            if (entry.textIds[i]) {
                await dm.messages.edit(entry.textIds[i], { content: texts[i] });
            } else {
                // 編集で長くなった分は追加送信
                markRelayPending(dm.id);
                const sent = await dm.send({ content: texts[i] });
                rememberRelayed(sent.id);
                entry.textIds.push(sent.id);
                entry.messageIds.push(sent.id);
            }
        }
        // 短くなって余った続きメッセージは削除（先頭は残す）
        for (const id of entry.textIds.splice(Math.max(texts.length, 1))) {
            await dm.messages.delete(id).catch(() => {});
            entry.messageIds = entry.messageIds.filter((x) => x !== id);
        }
    } catch (err) {
        console.error('DMへの編集の反映に失敗しました:', err.message);
    }
    return true;
}

/** 転送先スレッドでの発言の削除を、中継済みのDMメッセージに反映する（DM側も削除） */
async function syncRelayDelete(client, sourceId) {
    await relayInflight.get(sourceId)?.catch(() => {});

    const entry = relays.get(sourceId);
    if (!entry) return;
    relays.delete(sourceId);

    const dm = await client.channels.fetch(entry.dmChannelId).catch(() => null);
    if (!dm) return;
    for (const id of entry.messageIds) {
        await dm.messages.delete(id).catch((err) =>
            console.warn(`DMメッセージ(${id})の削除に失敗しました:`, err.message),
        );
    }
}

// ---------------------------------------------------------------
// 送信内容の組み立て（コマンド実行者 / 返信 / 転送 / 添付 / スタンプ / Embed / 編集前 / リアクション）
// ---------------------------------------------------------------
async function buildParts(message, contentToSend, { previousContent, reactions } = {}) {
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

    // --- コマンド実行結果（誰が実行したか） ---
    const meta = message.interactionMetadata;
    const legacy = message.interaction; // 非推奨だがコマンド名が入っている
    const invoker = meta?.user ?? legacy?.user;
    if (message.author?.bot && invoker) {
        const member = message.guild?.members.cache.get(invoker.id);
        const name = member?.displayName ?? invoker.globalName ?? invoker.username;
        let action = '操作';
        if (legacy?.commandName) action = `/${legacy.commandName}`;
        else if (meta?.type === InteractionType.ApplicationCommand) action = 'コマンド';
        lines.push(`-# ⌨️ **${escapeMarkdown(name)}** が ${action} を実行`);
    }

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

    // --- 編集前の内容（小さく表示） ---
    if (previousContent && previousContent.trim()) {
        let prev = previousContent.replace(/\s+/g, ' ').trim();
        if (prev.length > 200) prev = prev.slice(0, 200) + '…';
        lines.push(`-# ✏️ 編集前: ${prev}`);
    }

    // --- リアクション（件数つきで小さく表示） ---
    const reactionList = (reactions ?? []).filter((r) => r.count > 0);
    if (reactionList.length) {
        const text = reactionList
            .slice(0, 20)
            .map((r) => `${r.emoji} ${r.count}`)
            .join('　');
        lines.push(`-# リアクション: ${text}`);
    }

    return {
        texts: splitText(lines.join('\n')),
        fileChunks: chunk(files, 10), // 1メッセージ最大10ファイル
        embeds: embeds.slice(0, 10),  // 1メッセージ最大10 Embed
    };
}

// ---------------------------------------------------------------
// 送信
// ---------------------------------------------------------------
/**
 * Webhookでユーザーになりすましてメッセージを送信する。
 * 転送先がフォーラムの場合は、同名スレッドがあれば再利用し、なければ新規作成する。
 * 送信した内容は記録され、後から編集・リアクションを反映できる。
 *
 * @param {import('discord.js').Message} message - 元のメッセージ
 * @param {import('discord.js').TextBasedChannel|import('discord.js').ForumChannel} targetChannel
 * @param {string} contentToSend - 本文
 * @param {Object} [options]
 * @param {string} [options.threadTitle] - フォーラムのスレッド名（省略時は送信場所の文字列）
 * @param {string[]} [options.appliedTags] - 新規スレッドに追加で付けるタグID
 * @param {boolean} [options.deleteOriginal=true] - 送信成功後に元メッセージを削除するか
 */
async function sendAsUser(message, targetChannel, contentToSend, options = {}) {
    const { threadTitle, appliedTags, deleteOriginal = true } = options;

    if (!targetChannel) {
        throw new Error('ターゲットチャンネルが無効です。');
    }

    const targetIsThread = targetChannel.isThread?.() ?? false;
    const hookChannel = targetIsThread ? targetChannel.parent : targetChannel;
    const isForum =
        hookChannel.type === ChannelType.GuildForum || hookChannel.type === ChannelType.GuildMedia;

    // 1. 権限確認
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

    // 3. 表示名・アイコン
    const baseName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
    const username = sanitizeUsername(message.author.bot ? `${baseName} [BOT]` : baseName);
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

            if (isForum && !threadId) {
                threadId = msg.channelId ?? msg.channel_id;
                threadCache.set(threadKey, threadId);
            }
        }
        return { threadId, sent };
    });

    // 5. 編集・リアクション反映のために記録
    rememberMirror(message.id, {
        webhook,
        threadId: result.threadId,
        username,
        avatarURL,
        messageIds: result.sent.map((m) => m.id),
        // 本文を持つメッセージ（先頭 + 長文の続き）。編集時はここを書き換える
        textIds: result.sent.slice(0, Math.max(texts.length, 1)).map((m) => m.id),
        texts,                       // 最後に送信した本文（削除時に取り消し線を付けるため）
        reactions: new Map(),        // 絵文字キー -> { emoji, count }（生イベントから自前で集計）
        source: message,             // 元メッセージ（リアクション反映時の再描画用）
        content: message.content ?? '',
        prevContent: null,
    });

    // 6. 送信成功後に元メッセージを削除
    if (deleteOriginal) {
        await message.delete().catch(() => {});
    }

    return { location, webhook, threadId: result.threadId, messages: result.sent };
}

/** 設定済みの転送先へメッセージを転送する（二重転送防止つき） */
function mirrorMessage(message) {
    if (mirrors.has(message.id)) return Promise.resolve(null);
    if (inflight.has(message.id)) return inflight.get(message.id);

    const p = (async () => {
        // DMのチャンネルはPartialで届くことがあるので、相手の情報を取得しておく
        if (message.channel?.partial) await message.channel.fetch().catch(() => {});

        const targetChannel = await message.client.channels.fetch(getTargetChannelId());
        if (!targetChannel) {
            console.error('送信先のチャンネルが見つかりませんでした。');
            return null;
        }
        return sendAsUser(message, targetChannel, message.content, {
            threadTitle: getLocationString(message),
            deleteOriginal: false,
        });
    })();

    inflight.set(message.id, p);
    p.finally(() => inflight.delete(message.id)).catch(() => {});
    return p;
}

// ---------------------------------------------------------------
// 編集・リアクションの反映
// ---------------------------------------------------------------

/** アーカイブされたスレッドは編集・削除できないので解除する */
async function ensureThreadOpen(client, threadId) {
    if (!threadId) return;
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (thread?.archived) await thread.setArchived(false).catch(() => {});
}

/** 転送済みメッセージの本文を、元メッセージの最新状態で書き換える */
function refreshMirror(message, entry) {
    return withLock(`msg:${message.id}`, async () => {
        const { texts, embeds } = await buildParts(message, message.content, {
            previousContent: entry.prevContent,
            reactions: [...entry.reactions.values()],
        });
        const { webhook, threadId } = entry;

        await ensureThreadOpen(message.client, threadId);

        const base = { allowedMentions: { parse: [] } };
        if (threadId) base.threadId = threadId;

        for (let i = 0; i < texts.length; i++) {
            if (entry.textIds[i]) {
                const edit = { ...base, content: texts[i] };
                if (i === 0 && embeds.length) edit.embeds = embeds;
                await webhook.editMessage(entry.textIds[i], edit);
            } else {
                // 編集で長くなった分は追加送信
                const m = await webhook.send({
                    ...base,
                    content: texts[i],
                    username: entry.username,
                    avatarURL: entry.avatarURL,
                });
                entry.textIds.push(m.id);
                entry.messageIds.push(m.id);
            }
        }

        entry.texts = texts;

        // 短くなって余った続きメッセージは削除（先頭は残す）
        const removed = entry.textIds.splice(Math.max(texts.length, 1));
        for (const id of removed) {
            await webhook.deleteMessage(id, threadId ?? undefined).catch(() => {});
            entry.messageIds = entry.messageIds.filter((x) => x !== id);
        }
    });
}

/** メッセージ編集を転送先に反映（編集前の内容も小さく表示） */
async function syncEdit(message) {
    await inflight.get(message.id)?.catch(() => {}); // 転送中なら完了を待つ

    const entry = mirrors.get(message.id);
    if (!entry) {
        // 未転送: 「考え中…」から結果に編集されたコマンド応答などは、ここで初めて転送する
        if (message.author?.bot && shouldMirror(message)) await mirrorMessage(message);
        return;
    }

    const newContent = message.content ?? '';
    const changed = newContent !== entry.content;
    if (!changed && !message.author?.bot) return; // Embed展開などの更新は無視

    if (changed) {
        entry.prevContent = entry.content;
        entry.content = newContent;
    }
    entry.source = message;
    await refreshMirror(message, entry);
}

/** 各行を取り消し線で囲む（引用・小文字・箇条書きの記号とコードブロックは崩さない） */
function strikeText(text) {
    let inCode = false;
    return text
        .split('\n')
        .map((line) => {
            if (line.trim().startsWith('```')) {
                inCode = !inCode;
                return line;
            }
            if (inCode || !line.trim()) return line;

            const [, prefix, body] = line.match(/^((?:-# |> |#{1,3} |- |\* )*)(.*)$/);
            const clean = body.replaceAll('~~', '').trim();
            return clean ? `${prefix}~~${clean}~~` : line;
        })
        .join('\n');
}

/**
 * 元メッセージの削除を転送先に反映する。
 * 転送先のメッセージは消さず、本文に取り消し線を付けて「削除されました」と表示する。
 * （添付ファイルやEmbedはそのまま残る）
 */
async function syncDelete(sourceId) {
    await inflight.get(sourceId)?.catch(() => {}); // 転送中なら完了を待つ

    const entry = mirrors.get(sourceId);
    if (!entry) return;

    clearTimeout(refreshTimers.get(sourceId));
    refreshTimers.delete(sourceId);
    mirrors.delete(sourceId); // 以降は編集・リアクションを反映しない

    await withLock(`msg:${sourceId}`, async () => {
        const { webhook, threadId } = entry;
        await ensureThreadOpen(webhook.client, threadId);

        const marker = '-# 🗑️ 削除されました';
        for (let i = 0; i < entry.textIds.length; i++) {
            const original = entry.texts?.[i] ?? '';
            if (i > 0 && !original) continue;

            const struck = original ? strikeText(original) : '';
            const content = (i === 0 ? [marker, struck] : [struck]).filter(Boolean).join('\n').slice(0, 2000);

            try {
                await webhook.editMessage(entry.textIds[i], {
                    ...(threadId ? { threadId } : {}),
                    content,
                    allowedMentions: { parse: [] },
                });
            } catch (err) {
                console.warn(`転送先メッセージ(${entry.textIds[i]})の更新に失敗しました:`, err.message);
            }
        }
    });
}

/** リアクション絵文字を表示用の文字列にする（カスタム絵文字は <:名前:ID>） */
function emojiToString(e) {
    return e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name;
}

/**
 * リアクションの件数を生イベントから自前で集計し、転送先に反映する。
 * APIでメッセージを取り直さないので、「メッセージ履歴を読む」権限やキャッシュに依存しない。
 * 連続した変更はまとめて1回の編集にする。
 */
async function onReactionPacket(t, d) {
    await inflight.get(d.message_id)?.catch(() => {}); // 転送中なら完了を待つ

    const entry = mirrors.get(d.message_id);
    if (!entry) return;
    if (t !== 'MESSAGE_REACTION_REMOVE_ALL' && !d.emoji) return;

    const key = d.emoji ? (d.emoji.id ?? d.emoji.name) : null;
    switch (t) {
        case 'MESSAGE_REACTION_ADD': {
            const cur = entry.reactions.get(key) ?? { emoji: emojiToString(d.emoji), count: 0 };
            cur.count += 1;
            entry.reactions.set(key, cur);
            break;
        }
        case 'MESSAGE_REACTION_REMOVE': {
            const cur = entry.reactions.get(key);
            if (cur) {
                cur.count -= 1;
                if (cur.count <= 0) entry.reactions.delete(key);
            }
            break;
        }
        case 'MESSAGE_REACTION_REMOVE_EMOJI':
            entry.reactions.delete(key);
            break;
        case 'MESSAGE_REACTION_REMOVE_ALL':
            entry.reactions.clear();
            break;
    }

    clearTimeout(refreshTimers.get(d.message_id));
    refreshTimers.set(
        d.message_id,
        setTimeout(() => {
            refreshTimers.delete(d.message_id);
            const current = mirrors.get(d.message_id);
            if (!current) return;
            refreshMirror(current.source, current).catch((err) =>
                console.error('リアクションの反映に失敗しました:', err),
            );
        }, REACTION_DEBOUNCE_MS),
    );
}

/**
 * 生のゲートウェイイベントを処理する（削除・リアクション）。
 * 通常のイベントと違い、キャッシュやPartialsの設定に関係なく届く。
 * @param {import('discord.js').Client} client
 * @param {{ t: string, d: any }} packet
 */
async function handleRaw(client, packet) {
    const { t, d } = packet;
    if (!d) return;

    switch (t) {
        case 'MESSAGE_DELETE':
            await syncRelayDelete(client, d.id);
            await syncDelete(d.id);
            break;
        case 'MESSAGE_DELETE_BULK':
            for (const id of d.ids) {
                await syncRelayDelete(client, id);
                await syncDelete(id);
            }
            break;
        case 'MESSAGE_REACTION_ADD':
        case 'MESSAGE_REACTION_REMOVE':
        case 'MESSAGE_REACTION_REMOVE_ALL':
        case 'MESSAGE_REACTION_REMOVE_EMOJI':
            await onReactionPacket(t, d);
            break;
    }
}

module.exports = {
    sendAsUser,
    mirrorMessage,
    shouldMirror,
    isExcluded,
    relayToDm,
    syncRelayEdit,
    isRelayEcho,
    syncEdit,
    handleRaw,
    getLocationString,
    getChannelTypeLabel,
};