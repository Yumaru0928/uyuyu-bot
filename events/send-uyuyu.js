const { Events } = require('discord.js');
const { getChannelConfig } = require('../utils/channel-config.js');
const { UYUYU_EMOJIS, ROLLING_UYUYU, SANTA_UYUYU, TONAKAI_UYUYU, NEWYEAR_UYUYU } = require('../utils/emojis.js');
const { ROLLING_RATE, isDecemberJst, isNewYearJst } = require('../utils/gacha.js');
const gachaCollection = require('../utils/gacha-collection.js');

// リアクション用：Discordが確実に認識できる '名前:ID' 形式（絵文字の一覧は emojis.js にまとめてある）
// 通常のリアクションは UYUYU_EMOJIS から選ぶ。rolling_uyuyu は下記の抽選に当たったときだけ付ける
// uyuyu_santa と uyuyu_tonakai は12月だけ通常候補に混ざる（付けられても図鑑には登録しない。登録はガチャ経由のみ）
const Emojis = UYUYU_EMOJIS.map(emoji => `${emoji.name}:${emoji.id}`);
const ROLLING_TEXT = `${ROLLING_UYUYU.name}:${ROLLING_UYUYU.id}`;
const SANTA_TEXT = `${SANTA_UYUYU.name}:${SANTA_UYUYU.id}`;
const TONAKAI_TEXT = `${TONAKAI_UYUYU.name}:${TONAKAI_UYUYU.id}`;
const NEWYEAR_TEXT = `${NEWYEAR_UYUYU.name}:${NEWYEAR_UYUYU.id}`;

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
        const candidates = [...Emojis];
        if (isDecemberJst()) candidates.push(SANTA_TEXT, TONAKAI_TEXT);
        if (isNewYearJst()) candidates.push(NEWYEAR_TEXT);
        const emoji = isRolling
            ? ROLLING_TEXT
            : candidates[Math.floor(Math.random() * candidates.length)];
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
