const { PermissionsBitField, ChannelType } = require('discord.js');

/**
 * 送信場所の文字列表記を取得するヘルパー関数
 * 形式: (サーバー名)|(チャンネル名) または (server)|(Channel)->(thread)
 * @param {import('discord.js').Message} message 
 * @returns {string}
 */
function getLocationString(message) {
    const guildName = message.guild ? message.guild.name : 'DM';

    if (message.channel.isThread()) {
        const parentChannel = message.channel.parent;
        const parentName = parentChannel ? parentChannel.name : '不明なチャンネル';
        const threadName = message.channel.name;
        return `${guildName}|${parentName}->${threadName}`;
    } else {
        const channelName = message.channel.name;
        return `${guildName}|${channelName}`;
    }
}

/**
 * チャンネル/フォーラムにWebhookでメッセージを送信（必要に応じてスレッド作成）
 * @import { Message, TextBasedChannel, ForumChannel } from 'discord.js'
 * @param {Message} message - 元のメッセージオブジェクト
 * @param {TextBasedChannel|ForumChannel} targetChannel - 送信先のチャンネル（テキスト or フォーラム）
 * @param {string} contentToSend - 送信したい本文
 * @param {Object} [options] - オプション
 * @param {string} [options.threadTitle] - フォーラム等で新規スレッドを作成する場合のタイトル
 * @param {boolean} [options.deleteOriginal=true] - 元のメッセージを削除するかどうか
 * @returns {Promise<{ location: string, webhook: import('discord.js').Webhook }>}
 */
async function sendAsUser(message, targetChannel, contentToSend, options = {}) {
    const { threadTitle, deleteOriginal = true } = options;

    if (!message.guild || !targetChannel) {
        throw new Error('ギルドまたはターゲットチャンネルが無効です。');
    }

    // 1. Botに「ウェブフックの管理」権限があるか確認
    const botMember = message.guild.members.cache.get(message.client.user.id);
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageWebhooks)) {
        throw new Error('Botに「ウェブフックの管理」権限がありません。');
    }

    // 2. チャンネルに応じたWebhookの取得・作成
    const webhooks = await targetChannel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.owner.id === message.client.user.id);

    if (!webhook) {
        webhook = await targetChannel.createWebhook({
            name: 'EmojiProxyWebhook',
            reason: 'ユーザーのメッセージ偽装・代行用',
        });
    }

    // 3. 元のメッセージを削除（必要に応じて）
    if (deleteOriginal) {
        await message.delete().catch(() => {});
    }

    // 4. 送信者の表示名（ニックネーム優先）とアイコンURLを取得
    const displayName = message.member ? message.member.displayName : message.author.username;
    const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 256 });

    // 5. 送信データの構築
    const sendPayload = {
        content: contentToSend,
        username: displayName,
        avatarURL: avatarURL,
    };

    // フォーラムなどで新規スレッドを作成する場合
    if (threadTitle && targetChannel.type === ChannelType.GuildForum) {
        sendPayload.threadName = threadTitle;
    }

    // 6. Webhookで送信
    await webhook.send(sendPayload);

    // 7. ログ用などに整形した位置情報を返す
    const location = getLocationString(message);
    return { location, webhook };
}

module.exports = { sendAsUser, getLocationString };