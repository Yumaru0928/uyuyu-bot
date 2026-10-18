const { Events } = require('discord.js');
const { getChannelConfig } = require('../channel-config.js');
const { UYUYU_EMOJIS, ROLLING_UYUYU } = require('../emojis.js');

// リアクション用：Discordが確実に認識できる '名前:ID' 形式（絵文字の一覧は emojis.js にまとめてある）
const Emojis = [...UYUYU_EMOJIS, ROLLING_UYUYU].map(emoji => `${emoji.name}:${emoji.id}`);

// リアクションを付けられなくても異常ではないエラー（ログに流さない）
//  10008: メッセージがもう無い / 90001: 相手にブロックされている / 50013: 権限が無い
const IGNORED_REACT_ERRORS = new Set([10008, 90001, 50013]);

// 反応するキーワード
const KEYWORDS = /うゆゆ|ウユユ|uyuyu|myumyumyu|suyarunn/i;

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // ボットのメッセージおよびDM（サーバー外）は無視
        if (message.author.bot || !message.guild) return;

        // 1. キーワードが含まれないメッセージは、設定ファイルを見るまでもなく終了（大文字小文字は区別しない）
        if (!KEYWORDS.test(message.content)) return;

        // 2. 設定ファイル（config-channels.json）から、このチャンネルが無効化されていないか確認
        const disabledChannels = getChannelConfig()[message.guild.id]?.disableAutoReact || [];
        if (disabledChannels.includes(message.channel.id)) return;

        // 3. 絵文字ランダム選出とリアクション処理
        const rand = Math.floor(Math.random() * Emojis.length);
        try {
            await message.react(Emojis[rand]);
        } catch (error) {
            if (!IGNORED_REACT_ERRORS.has(error.code)) {
                console.error('リアクションの追加に失敗しました:', error);
            }
        }
    }
};
