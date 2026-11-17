const { Events } = require('discord.js');
const { getChannelConfig } = require('../utils/channel-config.js');
const { UYUYU_EMOJIS, ROLLING_UYUYU } = require('../utils/emojis.js');
const { ROLLING_RATE } = require('../utils/gacha.js');
const gachaCollection = require('../utils/gacha-collection.js');

// リアクション用：Discordが確実に認識できる '名前:ID' 形式（絵文字の一覧は emojis.js にまとめてある）
// 通常のリアクションは UYUYU_EMOJIS から選ぶ。rolling_uyuyu は下記の抽選に当たったときだけ付ける
const Emojis = UYUYU_EMOJIS.map(emoji => `${emoji.name}:${emoji.id}`);
const ROLLING_TEXT = `${ROLLING_UYUYU.name}:${ROLLING_UYUYU.id}`;

// リアクションを付けられなくても異常ではないエラー（ログに流さない）
//  10008: メッセージがもう無い / 90001: 相手にブロックされている / 50013: 権限が無い
const IGNORED_REACT_ERRORS = new Set([10008, 90001, 50013]);



// 反応するキーワード
const KEYWORDS = new RegExp(
    [
        '[うウ][ゆユ][ゆユ]',
        'u+y+u+y+u+',
        '(?:myu){3}',
        'suyarun+',
    ].join('|'),
    'i'
);

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // ボットのメッセージおよびDM（サーバー外）は無視
        if (message.author.bot || !message.guild) return;

        // 1. キーワードが含まれないメッセージは、設定ファイルを見るまでもなく終了（大文字小文字は区別しない）
        if (!KEYWORDS.test(message.content.normalize('NFKC'))) return;

        // 2. 設定ファイル（config-channels.json）から、このチャンネルが無効化されていないか確認
        const disabledChannels = getChannelConfig()[message.guild.id]?.disableAutoReact || [];
        if (disabledChannels.includes(message.channel.id)) return;

        // 3. 絵文字ランダム選出とリアクション処理
        // 低確率（ROLLING_RATE）で rolling_uyuyu に変化する（図鑑の条件ドロップ「見える版」）。
        // 変化したリアクションが実際に付けられたときだけ、投稿者の図鑑へ登録する
        const isRolling = Math.random() < ROLLING_RATE;
        const emoji = isRolling
            ? ROLLING_TEXT
            : Emojis[Math.floor(Math.random() * Emojis.length)];
        try {
            await message.react(emoji);
            if (isRolling) gachaCollection.addItem(message.author.id, ROLLING_UYUYU.name);
        } catch (error) {
            if (!IGNORED_REACT_ERRORS.has(error.code)) {
                console.error('リアクションの追加に失敗しました:', error);
            }
        }
    }
};
