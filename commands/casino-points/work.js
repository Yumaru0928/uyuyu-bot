const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('work')
        .setDescription('カジノポイントを稼ぐために働きます。'),
    async execute(interaction) {
        const pointsFilePath = path.join(__dirname, '..', '..', 'config-users.json');
        
        // ユーザーのポイントデータを読み込む
        let pointsData = {};
        if (fs.existsSync(pointsFilePath)) {
            try {
                const rawData = fs.readFileSync(pointsFilePath, 'utf8');
                pointsData = JSON.parse(rawData);
            } catch (error) {
                console.error('JSON読み込みエラー:', error);
            }
        }

        // ユーザーのデータがまだない場合は初期化
        if (!pointsData[interaction.user.id]) {
            pointsData[interaction.user.id] = { casinoPoints: 0, lastWorkTime: 0 };
        }

        const lastWorkTime = pointsData[interaction.user.id].lastWorkTime || 0;
        const currentTime = Date.now();
        // 1時間のクールダウンを設定（3600000ミリ秒）
        const cooldown = 3600000;

        let earnedPoints = 0; // コミット用

        // クールダウンが経過しているかチェック
        if (currentTime - lastWorkTime >= cooldown) {
            // ポイントを増やす（1000〜1999Pt）
            earnedPoints = Math.floor(Math.random() * 1000) + 1000;
            pointsData[interaction.user.id].casinoPoints += earnedPoints;
            
            // 最後に働いた時間を更新
            pointsData[interaction.user.id].lastWorkTime = currentTime;

            // 結果をユーザーに表示
            const embed = new EmbedBuilder()
                .setTitle('働きました！')
                .setDescription(`${interaction.user.displayName}は働いて${earnedPoints}Ptを稼ぎました！`)
                .setColor(0x00ff00);
            
            await interaction.reply({ embeds: [embed] });

            // データをファイルに保存
            fs.writeFileSync(pointsFilePath, JSON.stringify(pointsData, null, 2));
            
            // GitHubへのコミット処理
            if (interaction.client.commitJsonToGitHub) {
                await interaction.client.commitJsonToGitHub(
                    'config-users.json',
                    pointsData,
                    `[skip render] ${interaction.user.tag}が働いて${earnedPoints}Ptを稼ぎました。`
                );
            }
        } else {
            // クールダウン中の処理
            const remainingTime = cooldown - (currentTime - lastWorkTime);
            const minutes = Math.floor(remainingTime / 60000);
            const seconds = Math.floor((remainingTime % 60000) / 1000);
            
            const embed = new EmbedBuilder()
                .setTitle('クールダウン中')
                .setDescription(`まだ働くことはできません。あと${minutes}分${seconds}秒待ってください。`)
                .setColor(0xff0000);
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },
};