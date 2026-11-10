const { Events } = require('discord.js');
// ※ パスやファイル名は実際のプロジェクトの構造に合わせて調整してください
const { shouldMirror, mirrorMessage, syncEdit, onReactionChanged } = require('../utils/webhooksend.js');

/** 非同期ハンドラのエラーをまとめてログ出力する */
const safe = (label, fn) => async (...args) => {
    try {
        await fn(...args);
    } catch (error) {
        console.error(`${label}に失敗しました:`, error);
    }
};

/**
 * 転送関連のイベント（新規・編集・リアクション）をこの1ファイルにまとめて登録する。
 * Bot起動時に1回だけ実行される。
 */
module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        // 新規メッセージ（Botはスラッシュコマンド等の応答のみ shouldMirror が通す）
        client.on(
            Events.MessageCreate,
            safe('メッセージの転送', async (message) => {
                if (!shouldMirror(message)) return;
                await mirrorMessage(message);
            }),
        );

        // メッセージ編集
        client.on(
            Events.MessageUpdate,
            safe('編集の反映', async (_old, updated) => {
                const message = updated.partial ? await updated.fetch().catch(() => null) : updated;
                if (!message || !shouldMirror(message)) return;
                await syncEdit(message);
            }),
        );

        // リアクションの追加・削除・全削除
        const onReaction = safe('リアクションの反映', (reaction) => onReactionChanged(reaction.message));
        client.on(Events.MessageReactionAdd, onReaction);
        client.on(Events.MessageReactionRemove, onReaction);
        client.on(
            Events.MessageReactionRemoveAll,
            safe('リアクションの反映', (message) => onReactionChanged(message)),
        );
    },
};