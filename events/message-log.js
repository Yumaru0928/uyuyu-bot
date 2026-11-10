const { Events } = require('discord.js');
// ※ パスやファイル名は実際のプロジェクトの構造に合わせて調整してください
const { sendAsUser, getLocationString } = require('../utils/webhooksend.js');

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // DM・Bot・Webhook・システムメッセージ（参加通知など）は無視
        if (!message.guild || message.author.bot || message.webhookId || message.system) return;

        // 送信先のチャンネルID（環境変数優先、なければ固定ID）
        const targetChannelId = process.env.TARGET_CHANNEL_ID || '1569502078110408775';

        // 転送先フォーラム自身（およびその中のスレッド）の発言は転送しない（ループ防止）
        if (message.channelId === targetChannelId || message.channel.parentId === targetChannelId) return;

        try {
            const targetChannel = await message.client.channels.fetch(targetChannelId);
            if (!targetChannel) {
                console.error('送信先のチャンネルが見つかりませんでした。');
                return;
            }

            // 返信・転送・添付ファイル・スタンプは sendAsUser が message から自動で処理する。
            // 同名スレッドが既にあれば再利用し、なければ新規作成される。
            await sendAsUser(message, targetChannel, message.content, {
                threadTitle: getLocationString(message), // 例: サーバー名 | カテゴリ | #general -> スレッド名
                deleteOriginal: false,
            });
        } catch (error) {
            console.error('メッセージの転送・Webhook送信に失敗しました:', error);
        }
    },
};