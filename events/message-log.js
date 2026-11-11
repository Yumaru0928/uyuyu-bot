const { Events, GatewayIntentBits, Partials } = require('discord.js');
// ※ パスやファイル名は実際のプロジェクトの構造に合わせて調整してください
const {
    shouldMirror,
    mirrorMessage,
    syncEdit,
    handleRaw,
    relayToDm,
    syncRelayEdit,
    isRelayEcho,
} = require('../utils/webhooksend.js');

/** 非同期ハンドラのエラーをまとめてログ出力する */
const safe = (label, fn) => async (...args) => {
    try {
        await fn(...args);
    } catch (error) {
        console.error(`${label}に失敗しました:`, error);
    }
};

/**
 * 転送関連のイベント（新規・編集・削除・リアクション）をこの1ファイルにまとめて登録する。
 * Bot起動時に1回だけ実行される。
 */
module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        // 必要なIntentが足りないとイベントが届かないので、起動時に警告する
        const required = {
            GuildMessages: GatewayIntentBits.GuildMessages,
            MessageContent: GatewayIntentBits.MessageContent,
            GuildMessageReactions: GatewayIntentBits.GuildMessageReactions,
            DirectMessages: GatewayIntentBits.DirectMessages,
            DirectMessageReactions: GatewayIntentBits.DirectMessageReactions,
        };
        for (const [name, bit] of Object.entries(required)) {
            if (!client.options.intents.has(bit)) {
                console.warn(`[転送] Intent「${name}」が未設定です。関連する機能が動きません。`);
            }
        }

        // DMを受け取るにはPartials.Channelも必要
        if (!client.options.partials?.includes(Partials.Channel)) {
            console.warn('[転送] Partials「Channel」が未設定です。DMが動きません。');
        }

        // 新規メッセージ（サーバー内・DM、人間・Bot）
        client.on(
            Events.MessageCreate,
            safe('メッセージの転送', async (message) => {
                await relayToDm(message);          // 転送先のDMスレッドでの発言 → 相手のDMへ送信
                if (isRelayEcho(message)) return;  // 中継したDMメッセージが再転送されるのを防ぐ
                if (!shouldMirror(message)) return;
                await mirrorMessage(message);
            }),
        );

        // メッセージ編集
        client.on(
            Events.MessageUpdate,
            safe('編集の反映', async (_old, updated) => {
                const message = updated.partial ? await updated.fetch().catch(() => null) : updated;
                if (!message) return;
                if (await syncRelayEdit(message)) return; // 転送先スレッドでの編集 → DMへ反映
                if (!shouldMirror(message)) return;
                await syncEdit(message);
            }),
        );

        // 削除・リアクションは生イベントで受ける（キャッシュ/Partials設定に依存しない）
        client.on(
            Events.Raw,
            safe('削除・リアクションの反映', (packet) => handleRaw(client, packet)),
        );
    },
};