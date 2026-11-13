// commands/othello.js  (discord.js v14 / CommonJS)
//
//   /othello opponent:@ユーザー        → 人間との対戦（レート戦）
//   /othello opponent:@Bot [level:..]  → Bot（内蔵AI）との対戦（レート変動なし）

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');

const core = require('../../utils/othello-core');
const rating = require('../../utils/rating');
const { requestChallenge } = require('../../utils/challenge');
const { GAMES } = require('../../utils/games');

const GAME_ID = 'othello'; // lib/games.js のキーと同じにする
const { BLACK, WHITE, COLS } = core;

// ---------- 設定 ----------
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 無操作10分で終了（レート戦は手番の人が時間切れ負け）

// ---------- 表示用 ----------
const NUM_EMOJI = [':one:', ':two:', ':three:', ':four:', ':five:', ':six:', ':seven:', ':eight:'];
const STONE = { [BLACK]: '⚫', [WHITE]: '⚪' };
const LEVEL_LABEL = { easy: '弱い', normal: '普通', hard: '強い' };

function renderBoard(board, candidates = []) {
  const candSet = new Set(candidates.map((m) => `${m.x},${m.y}`));
  const header = ['⬛', ...[...COLS].map((c) => `:regional_indicator_${c}:`)].join('');
  const lines = [header];
  for (let y = 0; y < 8; y++) {
    let line = NUM_EMOJI[y];
    for (let x = 0; x < 8; x++) {
      const c = board[y][x];
      if (c === BLACK) line += STONE[BLACK];
      else if (c === WHITE) line += STONE[WHITE];
      else line += candSet.has(`${x},${y}`) ? '🟡' : '🟩';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function buildStatus(game, candidates = []) {
  const { black, white } = core.countStones(game.board);
  const p = game.players;
  const mode = game.ranked
    ? '【レート戦】'
    : `【Bot戦・強さ:${LEVEL_LABEL[game.level]}・レート変動なし】`;
  const lines = [
    mode,
    `${STONE[BLACK]} **${p[BLACK].displayName}** (${black}) vs ${STONE[WHITE]} **${p[WHITE].displayName}** (${white})`,
  ];
  if (game.events.length > 0) lines.push(game.events.join('\n'));
  lines.push(renderBoard(game.board, candidates));
  return lines.join('\n');
}

function buildPlayMessage(game) {
  const moves = core.getLegalMoves(game.board, game.turn);
  const turnUser = game.players[game.turn];
  const content = `手番: ${STONE[game.turn]} <@${turnUser.id}>  (🟡 = 置ける場所)\n${buildStatus(game, moves)}`;

  const rows = [];

  if (game.selectedCol === null) {
    // ステップ1: 列を選ぶ（置ける場所がある列のみ）
    const byCol = new Map();
    for (const m of moves) byCol.set(m.x, (byCol.get(m.x) ?? 0) + 1);
    const options = [...byCol.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([x, n]) => ({
        label: `${COLS[x].toUpperCase()}列`,
        description: `${n}か所に置けます`,
        value: String(x),
      }));
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('col')
          .setPlaceholder('① 列を選んでください (A〜H)')
          .addOptions(options),
      ),
    );
  } else {
    // ステップ2: 行を選ぶ（選んだ列で置ける行のみ）
    const x = game.selectedCol;
    const options = moves
      .filter((m) => m.x === x)
      .sort((a, b) => a.y - b.y)
      .map((m) => ({
        label: `${COLS[x]}${m.y + 1}`,
        description: `${m.flips.length}個ひっくり返せます`,
        value: String(m.y),
      }));
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('row')
          .setPlaceholder(`② ${COLS[x].toUpperCase()}列の何行目に置きますか？`)
          .addOptions(options),
      ),
    );
  }

  const buttons = [];
  if (game.selectedCol !== null) {
    buttons.push(
      new ButtonBuilder().setCustomId('back').setLabel('列を選び直す').setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.push(new ButtonBuilder().setCustomId('resign').setLabel('投了').setStyle(ButtonStyle.Danger));
  rows.push(new ActionRowBuilder().addComponents(...buttons));

  return { content, components: rows };
}

function buildResult(game, text) {
  return { content: `${text}\n${buildStatus(game)}`, components: [] };
}

// ---------- 進行 ----------

// 現在の手番で (x, y) に置き、パス・終局まで処理する
function doMove(game, x, y) {
  const player = game.turn;
  const flips = core.place(game.board, x, y, player);
  game.events.push(
    `${STONE[player]} ${game.players[player].displayName}: **${COLS[x]}${y + 1}** (${flips.length}個)`,
  );

  const next = 3 - player;
  if (core.getLegalMoves(game.board, next).length > 0) {
    game.turn = next;
  } else if (core.getLegalMoves(game.board, player).length > 0) {
    game.events.push(`⏭️ ${STONE[next]} ${game.players[next].displayName} は置ける場所がないためパス`);
    game.turn = player;
  } else {
    game.over = true;
  }
}

// 手番がAIの間、打ち続ける
function runAi(game) {
  while (!game.over && game.players[game.turn].isAi) {
    const m = core.chooseAiMove(game.board, game.turn, game.level);
    if (!m) break; // 通常は起こらない
    doMove(game, m.x, m.y);
  }
}

function stoneWinner(board) {
  const { black, white } = core.countStones(board);
  if (black > white) return BLACK;
  if (white > black) return WHITE;
  return null;
}

// 結果の確定とレート記録。表示用テキストを返す
// winner: BLACK / WHITE / null(引き分け)   reason: 'normal' | 'resign' | 'timeout'
function settle(game, winner, reason) {
  const p = game.players;
  const { black, white } = core.countStones(game.board);
  const score = `${STONE[BLACK]}${black} - ${STONE[WHITE]}${white}`;
  const loser = winner === null ? null : 3 - winner;

  let text;
  if (reason === 'resign') {
    text = `🏳️ **${p[loser].displayName}** が投了しました。\n🏆 **${p[winner].displayName}** の勝ち！`;
  } else if (reason === 'timeout') {
    text = `⌛ **${p[loser].displayName}** が時間切れのため、🏆 **${p[winner].displayName}** の勝ち！`;
  } else if (winner === null) {
    text = `🎉 ゲーム終了！ 🤝 引き分け！ (${score})`;
  } else {
    text = `🎉 ゲーム終了！ 🏆 **${p[winner].displayName}** (${STONE[winner]}) の勝ち！ (${score})`;
  }

  if (game.ranked) {
    try {
      const r = rating.recordMatch({
        game: GAME_ID,
        guildId: game.guildId,
        userA: p[BLACK].id,
        userB: p[WHITE].id,
        result: winner === BLACK ? 'a' : winner === WHITE ? 'b' : 'draw',
      });
      const fmt = (color, x) =>
        `${STONE[color]} ${p[color].displayName}: ${x.before} → **${x.after}** (${x.delta >= 0 ? '+' : ''}${x.delta})`;
      text += `\n📈 レート変動\n${fmt(BLACK, r.a)}\n${fmt(WHITE, r.b)}`;
    } catch (err) {
      console.error('[othello] rating error:', err);
      text += '\n⚠️ 戦績の保存に失敗しました。';
    }
  } else {
    text += '\n(Bot戦のためレートは変動しません)';
  }
  return text;
}

// ---------- コマンド本体 ----------
module.exports = {
  data: new SlashCommandBuilder()
    .setName('othello')
    .setDescription('オセロで対戦します（Botを指定するとBot戦）')
    .addUserOption((o) =>
      o.setName('opponent').setDescription('対戦相手（Botを指定するとBot戦）').setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName('level')
        .setDescription('Botの強さ（Bot戦のみ・省略時は普通）')
        .addChoices(
          { name: '弱い', value: 'easy' },
          { name: '普通', value: 'normal' },
          { name: '強い', value: 'hard' },
        ),
    ),

  async execute(interaction) {
    const opponent = interaction.options.getUser('opponent', true);
    const level = interaction.options.getString('level') ?? 'normal';
    const challenger = interaction.user;

    if (opponent.id === challenger.id) {
      return interaction.reply({ content: '自分自身とは対戦できません。', flags: MessageFlags.Ephemeral });
    }

    const vsAi = opponent.bot;
    const opponentMember = interaction.options.getMember('opponent');

    const challengerEntry = {
      id: challenger.id,
      displayName: interaction.member?.displayName ?? challenger.globalName ?? challenger.username,
      isAi: false,
    };
    const opponentEntry = {
      id: opponent.id,
      displayName: opponentMember?.displayName ?? opponent.globalName ?? opponent.username,
      isAi: vsAi,
    };

    // 先手(黒)はランダム
    const challengerIsBlack = Math.random() < 0.5;
    const game = {
      board: core.createBoard(),
      turn: BLACK,
      players: challengerIsBlack
        ? { [BLACK]: challengerEntry, [WHITE]: opponentEntry }
        : { [BLACK]: opponentEntry, [WHITE]: challengerEntry },
      ranked: !vsAi,
      level,
      guildId: interaction.guildId ?? null,
      selectedCol: null,
      events: [], // 直近の着手・パスの表示用
      over: false,
    };

    const humanIds = new Set(vsAi ? [challenger.id] : [challenger.id, opponent.id]);
    let message;

    if (vsAi) {
      // Bot戦: 申し込みなしで即開始（Botが先手ならここで先に打つ）
      runAi(game);
      await interaction.reply(buildPlayMessage(game));
      message = await interaction.fetchReply();
    } else {
      // 人間戦: 承諾を待ってから開始
      const res = await requestChallenge(interaction, {
        opponent,
        gameLabel: GAMES[GAME_ID].label,
      });
      if (res.status !== 'accepted') return;
      await res.interaction.update(buildPlayMessage(game));
      message = res.message;
    }

    const collector = message.createMessageComponentCollector({ idle: IDLE_TIMEOUT_MS });
    const deny = (i, text) => i.reply({ content: text, flags: MessageFlags.Ephemeral });

    collector.on('collect', async (i) => {
      try {
        if (!humanIds.has(i.user.id)) {
          return deny(i, 'この対局の参加者ではありません。');
        }

        // 投了（どちらでも可）
        if (i.customId === 'resign') {
          const loserColor = i.user.id === game.players[BLACK].id ? BLACK : WHITE;
          game.over = true;
          collector.stop('finished');
          return i.update(buildResult(game, settle(game, 3 - loserColor, 'resign')));
        }

        // 手番チェック
        if (i.user.id !== game.players[game.turn].id) {
          return deny(i, 'あなたの手番ではありません。');
        }

        if (i.customId === 'back') {
          game.selectedCol = null;
          return i.update(buildPlayMessage(game));
        }

        if (i.customId === 'col') {
          game.selectedCol = Number(i.values[0]);
          return i.update(buildPlayMessage(game));
        }

        if (i.customId === 'row') {
          const x = game.selectedCol;
          const y = Number(i.values[0]);
          if (x === null || core.getFlips(game.board, x, y, game.turn).length === 0) {
            game.selectedCol = null;
            return i.update(buildPlayMessage(game));
          }

          game.events = [];
          game.selectedCol = null;
          doMove(game, x, y);
          runAi(game); // 相手がBotなら続けて打つ

          if (game.over) {
            collector.stop('finished');
            return i.update(buildResult(game, settle(game, stoneWinner(game.board), 'normal')));
          }
          return i.update(buildPlayMessage(game));
        }
      } catch (err) {
        console.error('[othello] interaction error:', err);
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (reason !== 'idle') return;
      try {
        game.over = true;
        const text = game.ranked
          ? settle(game, 3 - game.turn, 'timeout') // 手番の人が時間切れ負け
          : '⌛ 一定時間操作がなかったため、対局を終了しました。(Bot戦のため記録なし)';
        await message.edit(buildResult(game, text));
      } catch (err) {
        console.error('[othello] timeout error:', err);
      }
    });
  },
};