const { Events } = require('discord.js');
const { sendAsUser } = require('../utils/webhookSender'); // 統合版モジュールの関数名・パスに合わせる

module.exports = {
    name: Events.MessageCreate, // イベント名は Events.MessageCreate
    async execute(message) {
        // DM（サーバー外）やBot自身のメッセージは無視
        if (!message.guild || message.author.bot) return;

        // 送信先のチャンネルID（環境変数優先、なければ固定ID）
        const targetChannelId = process.env.TARGET_CHANNEL_ID || '1569502078110408775';

        try {
            // 送信先のチャンネルオブジェクトを非同期で取得
            const targetChannel = await message.guild.channels.fetch(targetChannelId);
            if (!targetChannel) {
                console.error('送信先のチャンネルが見つかりませんでした。');
                return;
            }

            // 統合版の sendAsUser 関数を呼び出し
            await sendAsUser(message, targetChannel, message.content, {
                threadTitle: message.channel.name, // フォーラム等の場合はスレッドタイトルに利用
                deleteOriginal: false,             // 元のメッセージを削除するかどうか
            });

        } catch (error) {
            console.error('メッセージの転送・Webhook送信に失敗しました:', error);
        }
    },
};