const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('color')
        .setDescription('HEXまたはRGBカラーコードを相互変換しプレビュー表示します')
        .addStringOption(option =>
            option
                .setName('code')
                .setDescription('カラーコードを入力 (例: #3498db, 3498db, 255,87,51)')
                .setRequired(true)
        ),
    async execute(interaction) {
        const input = interaction.options.getString('code').trim();

        let hex = '';
        let r = 0, g = 0, b = 0;

        // --- 1. 入力値の判定 & RGB/HEXの解析 ---
        if (input.includes(',')) {
            // RGB形式 (例: 255, 87, 51)
            const parts = input.split(',').map(p => parseInt(p.trim(), 10));
            if (parts.length === 3 && parts.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
                r = parts[0];
                g = parts[1];
                b = parts[2];
                hex = ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
            }
        } else {
            // HEX形式 (例: #3498db または 3498db)
            let cleanHex = input.replace('#', '');
            if (cleanHex.length === 3) {
                // 3桁表記 (#f00) を 6桁 (#ff0000) に拡張
                cleanHex = cleanHex.split('').map(c => c + c).join('');
            }
            if (/^[0-9A-Fa-f]{6}$/.test(cleanHex)) {
                hex = cleanHex.toUpperCase();
                r = parseInt(hex.substring(0, 2), 16);
                g = parseInt(hex.substring(2, 4), 16);
                b = parseInt(hex.substring(4, 6), 16);
            }
        }

        // 入力値が無効な場合のエラー表示
        if (!hex) {
            const errorEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ 無効なカラーコード')
                .setDescription('正しいHEX表記（例: `#3498db` または `3498db`）またはRGB表記（例: `52, 152, 219`）を入力してください。');
            
            return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        // --- 2. 各種色空間数値の計算 ---
        const hexNum = parseInt(hex, 16); // Embedのカラー用（数値）
        const hexStr = `#${hex}`;
        const rgbStr = `rgb(${r}, ${g},${b})`;
        
        // HSL値の計算
        const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
        const max = Math.max(rNorm, gNorm, bNorm), min = Math.min(rNorm, gNorm, bNorm);
        let h = 0, s = 0, l = (max + min) / 2;

        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
                case gNorm: h = (bNorm - rNorm) / d + 2; break;
                case bNorm: h = (rNorm - gNorm) / d + 4; break;
            }
            h /= 6;
        }
        const hslStr = `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}\%,${Math.round(l * 100)}%)`;

        // --- 3. プレビュー画像の自動生成URL (Single Color Image APIを利用) ---
        const previewUrl = `https://singlecolorimage.com/get/${hex}/300x100`;

        // --- 4. Embedの構築 ---
        const colorEmbed = new EmbedBuilder()
            .setColor(hexNum) // Embedの左端サイドバーの色を指定
            .setTitle(`🎨 カラー詳細・変換結果`)
            .setThumbnail(previewUrl) // 右上に指定した色のプレビュー画像を表示
            .addFields(
                { name: 'HEX', value: `\`${hexStr}\``, inline: true },
                { name: 'RGB', value: `\`${rgbStr}\``, inline: true },
                { name: 'HSL', value: `\`${hslStr}\``, inline: true }
            )
            .setFooter({ text: `数値表記: ${hexNum}` })
            .setTimestamp();

        await interaction.reply({ embeds: [colorEmbed] });
    },
};