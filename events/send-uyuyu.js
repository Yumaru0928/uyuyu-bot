const { Events } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const Emojis = [
    '1549375294614540409',
    '1524698363532935248',
    '1521842573314887762',
    '1528488334014283806',
    '1537390880934203392',
    '1551217609880510534',
    '1512638117268685020',
    '1528265962984439970',
    '1528093863573585924',
    '1527287285446344704',
    '1528036666936131715',
    '1529686813071900814',
    '1539487778553729064',
    'a:rolling_uyuyu:1529182253207392267'
];

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // ボットのメッセージおよびDM（サーバー外）は無視
        if (message.author.bot || !message.guild) return;

        // 1. 設定ファイル（config-channels.json）から無効化チャンネルリストを読み込み
        const configPath = path.join(__dirname, '..', 'config-channels.json');
        
        if (fs.existsSync(configPath)) {
            try {
                const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                // 自サーバーの disableAutoReact 配列を取得
                const disabledChannels = configData[message.guild.id]?.disableAutoReact || [];
                
                // コマンドが実行されたチャンネルが無効化リストに含まれていれば処理終了
                if (disabledChannels.includes(message.channel.id)) {
                    return;
                }
            } catch (error) {
                console.error('設定ファイルの読み込みエラー:', error);
            }
        }

        // 2. 絵文字ランダム選出とリアクション処理
        if (message.content.includes('うゆゆ') || message.content.includes('uyuyu') || message.content.includes('myumyumyu') || message.content.includes('suyarunn') || message.content.includes('ウユユ')) {
            const rand = Math.floor(Math.random() * Emojis.length);
            await message.react(Emojis[rand]);
        }
    }
};