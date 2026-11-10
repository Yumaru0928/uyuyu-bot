const { Events } = require('discord.js');
// 統合した utils から sendAsUser と getLocationString を読み込む
// ※ パスやファイル名は実際のプロジェクトの構造に合わせて調整してください
const { sendAsUser, getLocationString } = require('../utils/webhooksend.js');

module.exports = {
    name: Events.MessageCreate,
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

            // 指定された形式 (サーバー名)|(チャンネル名) または (server)|(Channel)->(thread) を取得
            const generatedThreadTitle = getLocationString(message);

            // Webhookを使って送信（threadTitleに生成した文字列を指定）
            await sendAsUser(message, targetChannel, message.content, {
                threadTitle: generatedThreadTitle, // 例: マイサーバー|(general) や server|(Channel)->(thread)
                deleteOriginal: false,             // 元のメッセージを削除するかどうか
            });

        } catch (error) {
            console.error('メッセージの転送・Webhook送信に失敗しました:', error);
        }
    },
};