// delete-commands.js
const { REST, Routes } = require('discord.js');
const { clientId, guildId, token } = require('./config.json');

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('登録済みのスラッシュコマンドを全削除・リセットします...');

        // 1. サーバー（ギルド）限定コマンドを全削除する場合
        await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: [] } // 空の配列を送信して全削除
        );
        console.log('サーバー(Guild)のコマンドを全て削除しました。');

        // 2. グローバルコマンドも全削除したい場合（必要に応じて有効化）
        
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: [] }
        );
        console.log('グローバルコマンドを全て削除しました。');
        

        console.log('コマンドのリセットが完了しました！');
    } catch (error) {
        console.error('コマンド削除中にエラーが発生しました:', error);
    }
})();