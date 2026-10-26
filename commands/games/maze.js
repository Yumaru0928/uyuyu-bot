const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('maze')
        .setDescription('プリム法を使ったランダムな迷路を生成します'),

    async execute(interaction) {
        // DiscordのEmbedに収まりやすいサイズ（奇数推奨）
        const width = 11;
        const height = 11;

        // プリム法で迷路を生成
        const maze = generateMazePrim(width, height);

        // 描画用絵文字の定義
        const wallEmoji = ':white:'; // 壁
        const pathEmoji = ':null:'; // 通路

        // グリッドを絵文字の文字列に変換
        let description = '';
        for (let y = 0; y < maze.length; y++) {
            for (let x = 0; x < maze[y].length; x++) {
                description += maze[y][x] === 1 ? wallEmoji : pathEmoji;
            }
            description += '\n';
        }

        // Embedの作成
        const embed = new EmbedBuilder()
            .setTitle('🌀 プリム法ダンジョン生成')
            .setDescription(description)
            .setColor(0x00AE86)
            .setFooter({ text: `Requested by ${interaction.user.tag}` })
            .setTimestamp();

        // 返信
        await interaction.reply({ embeds: [embed] });
    },
};

// プリム法による迷路生成ロジック
function generateMazePrim(width, height) {
    if (width % 2 === 0) width++;
    if (height % 2 === 0) height++;

    const grid = Array.from({ length: height }, () => Array(width).fill(1));
    const walls = [];

    function addWalls(x, y) {
        const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
        for (const [dx, dy] of dirs) {
            const wx = x + dx;
            const wy = y + dy;
            if (wx > 0 && wx < width - 1 && wy > 0 && wy < height - 1) {
                if (grid[wy][wx] === 1) {
                    walls.push([wx, wy]);
                }
            }
        }
    }

    // スタート地点 (1, 1)
    const startX = 1;
    const startY = 1;
    grid[startY][startX] = 0;
    addWalls(startX, startY);

    while (walls.length > 0) {
        const index = Math.floor(Math.random() * walls.length);
        const [wx, wy] = walls.splice(index, 1)[0];

        let cells = [];
        if (wx % 2 === 1 && wy % 2 === 0) {
            cells = [[wx, wy - 1], [wx, wy + 1]];
        } else if (wx % 2 === 0 && wy % 2 === 1) {
            cells = [[wx - 1, wy], [wx + 1, wy]];
        }

        if (cells.length === 2) {
            const [c1x, c1y] = cells[0];
            const [c2x, c2y] = cells[1];
            const is1Passage = (grid[c1y][c1x] === 0);
            const is2Passage = (grid[c2y][c2x] === 0);

            if (is1Passage !== is2Passage) {
                grid[wy][wx] = 0;
                const targetX = is1Passage ? c2x : c1x;
                const targetY = is1Passage ? c2y : c1y;

                if (grid[targetY][targetX] === 1) {
                    grid[targetY][targetX] = 0;
                    addWalls(targetX, targetY);
                }
            }
        }
    }

    // 入口と出口の開口部
    grid[1][0] = 0;
    grid[height - 2][width - 1] = 0;

    return grid;
}