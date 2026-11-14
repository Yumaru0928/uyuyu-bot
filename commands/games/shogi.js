// commands/games/shogi.js  (discord.js v14 / CommonJS)
//
//   /shogi opponent:@ユーザー        → 人間との対戦（レート戦）
//   /shogi opponent:@Bot [level:..]  → Bot（やねうら王）との対戦（レート変動なし）
//
// ・Bot 戦のエンジンは utils/usi-engine.js（やねうら王。環境変数で別プロセス/WASM を選ぶ）
// ・進行中の対局は utils/sessions.js に保存され、Bot の再起動後は restoreSessions() で続きから遊べる
//   （保存するのは指し手の列だけ。盤面は指し手を最初から再生して復元する）
// ・操作は「動かす駒を選ぶ → 動かす先を選ぶ →（成れるときは）成る/成らない」。
//   持ち駒は「持ち駒を打つ → 駒 → 筋 → 段」。選択肢はすべて合法手から作るので、反則は選べない

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');

const core = require('../../utils/shogi-core');
const rating = require('../../utils/rating');
const sessions = require('../../utils/sessions');
const { requestChallenge } = require('../../utils/challenge');
const { GAMES } = require('../../utils/games');
const { getEngine } = require('../../utils/usi-engine');

const GAME_ID = 'shogi'; // utils/games.js のキーと同じにする
const { BLACK, WHITE } = core;

// ---------- 設定 ----------
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 無操作30分で終了（レート戦は手番の人が時間切れ負け）
const SESSION_STALE_MS = 24 * 60 * 60 * 1000; // 再起動後、最後の操作からこれ以上たった対局は復元せず中断する

// ---------- 表示用 ----------
const SIDE = {
  [BLACK]: { mark: '▲', name: '先手' },
  [WHITE]: { mark: '△', name: '後手' },
};
const LEVEL_LABEL = { easy: '弱い', normal: '普通', hard: '強い' };
const HAND_ORDER = [core.ROOK, core.BISHOP, core.GOLD, core.SILVER, core.KNIGHT, core.LANCE, core.PAWN];

function handText(pos, color) {
  const parts = HAND_ORDER.filter((t) => pos.hands[color][t] > 0).map((t) => {
    const n = pos.hands[color][t];
    return core.KANJI[t] + (n > 1 ? core.kanjiCount(n) : '');
  });
  return parts.length > 0 ? parts.join(' ') : 'なし';
}

// 棒盤（BOD）形式。後手の駒は先頭に v を付ける。marks: マス → 'move'(動ける空きマス) | 'capture'(取れる駒)
function renderBoard(pos, marks = new Map()) {
  const lines = [
    `後手の持駒：${handText(pos, WHITE)}`,
    '  ９ ８ ７ ６ ５ ４ ３ ２ １',
    '+---------------------------+',
  ];
  for (let y = 0; y < 9; y++) {
    let row = '|';
    for (let x = 0; x < 9; x++) {
      const sq = y * 9 + x;
      const p = pos.board[sq];
      const mark = marks.get(sq);
      if (p) {
        const prefix = mark === 'capture' ? '*' : core.colorOf(p) === WHITE ? 'v' : ' ';
        row += prefix + core.pieceKanji(p);
      } else {
        row += mark === 'move' ? ' 〇' : ' ・';
      }
    }
    lines.push(`${row}|${core.KAN_NUM[y]}`);
  }
  lines.push('+---------------------------+', `先手の持駒：${handText(pos, BLACK)}`);
  return lines.join('\n');
}

// ---------- 選択肢の元になる合法手の整理 ----------
const boardMovesFrom = (legal) => {
  const byFrom = new Map();
  for (const mv of legal) {
    if (mv.drop) continue;
    if (!byFrom.has(mv.from)) byFrom.set(mv.from, []);
    byFrom.get(mv.from).push(mv);
  }
  return byFrom;
};
const dropTypesOf = (legal) => {
  const byType = new Map();
  for (const mv of legal) {
    if (!mv.drop) continue;
    if (!byType.has(mv.drop)) byType.set(mv.drop, []);
    byType.get(mv.drop).push(mv);
  }
  return byType;
};
const uniqueDests = (moves) => [...new Set(moves.map((m) => m.to))].sort((a, b) => a - b);

// ---------- メッセージの組み立て ----------
function marksFor(game) {
  const marks = new Map();
  const legal = game.game.legalMoves();
  const pos = game.game.pos;
  const add = (sq) => marks.set(sq, pos.board[sq] ? 'capture' : 'move');
  if (game.stage === 'dest' || game.stage === 'promote') {
    for (const mv of legal) if (mv.from === game.sel.from) add(mv.to);
  } else if (game.stage === 'dropfile') {
    for (const mv of legal) if (mv.drop === game.sel.dropType) add(mv.to);
  } else if (game.stage === 'droprank') {
    for (const mv of legal) if (mv.drop === game.sel.dropType && mv.to % 9 === game.sel.file) add(mv.to);
  }
  return marks;
}

function hintFor(game) {
  const pos = game.game.pos;
  const sel = game.sel;
  switch (game.stage) {
    case 'dest':
      return `選択中: ${core.squareLabel(sel.from)}の${core.pieceKanji(pos.board[sel.from])} → 動かす先を選んでください（〇=空き / *=取れる）`;
    case 'promote':
      return `${core.squareLabel(sel.to)}へ動かします。成りますか？`;
    case 'droptype':
      return '打つ駒を選んでください';
    case 'dropfile':
      return `${core.KANJI[sel.dropType]}を打つ筋を選んでください`;
    case 'droprank':
      return `${core.KANJI[sel.dropType]}を${core.ZEN_DIGITS[8 - sel.file]}筋の何段に打ちますか？`;
    default:
      return '動かす駒を選んでください（持ち駒を打つときは「持ち駒を打つ」）';
  }
}

function buildHeader(game) {
  const p = game.players;
  const mode = game.ranked
    ? '【レート戦】'
    : `【Bot戦（やねうら王）・強さ:${LEVEL_LABEL[game.level]}・レート変動なし】`;
  const lines = [`${mode} ${SIDE[BLACK].mark}先手 **${p[BLACK].displayName}** vs ${SIDE[WHITE].mark}後手 **${p[WHITE].displayName}**`];
  if (game.events.length > 0) lines.push(game.events.join('\n'));
  if (game.note) lines.push(game.note);
  return lines;
}

function buildPlayMessage(game) {
  const g = game.game;
  const turn = g.turn;
  const check = core.inCheck(g.pos) ? '  🔴 **王手！**' : '';
  const lines = buildHeader(game);
  lines.push(`手番: ${SIDE[turn].mark}${SIDE[turn].name} <@${game.players[turn].id}>（${g.moves.length}手）${check}`);
  lines.push(hintFor(game));
  lines.push('```\n' + renderBoard(g.pos, marksFor(game)) + '\n```');
  return { content: lines.join('\n'), components: buildComponents(game) };
}

function buildResult(game, text) {
  const lines = [text, ...buildHeader(game).slice(0, 1), '```\n' + renderBoard(game.game.pos) + '\n```'];
  return { content: lines.join('\n'), components: [] };
}

function selectRow(id, placeholder, options) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).addOptions(options),
  );
}
const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

function buildComponents(game) {
  const g = game.game;
  const legal = g.legalMoves();
  const sel = game.sel;
  const rows = [];
  const buttons = [];

  switch (game.stage) {
    case 'pick': {
      const byFrom = boardMovesFrom(legal);
      if (byFrom.size > 0) {
        const options = [...byFrom.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([from, moves]) => ({
            label: `${core.squareLabel(from)} ${core.pieceKanji(g.pos.board[from])}`,
            description: `${uniqueDests(moves).length}か所に動けます`,
            value: String(from),
          }));
        rows.push(selectRow('pick', '① 動かす駒を選んでください', options));
      }
      buttons.push(button('drop', '持ち駒を打つ', ButtonStyle.Primary, dropTypesOf(legal).size === 0));
      break;
    }
    case 'dest': {
      const moves = legal.filter((m) => m.from === sel.from);
      const options = uniqueDests(moves).map((to) => {
        const variants = moves.filter((m) => m.to === to);
        const capture = g.pos.board[to] !== 0;
        let description;
        if (variants.length === 2) description = '成る・成らないを選べます';
        else if (variants[0].promo) description = '成ります（必須）';
        return {
          label: `${core.squareLabel(to)}${capture ? '（取る）' : ''}`,
          ...(description ? { description } : {}),
          value: String(to),
        };
      });
      rows.push(selectRow('dest', '② 動かす先を選んでください', options));
      buttons.push(button('back', '駒を選び直す'));
      break;
    }
    case 'promote':
      buttons.push(button('promo1', '成る', ButtonStyle.Success), button('promo0', '成らない', ButtonStyle.Primary), button('back', '戻る'));
      break;
    case 'droptype': {
      const options = [...dropTypesOf(legal).entries()]
        .sort((a, b) => HAND_ORDER.indexOf(a[0]) - HAND_ORDER.indexOf(b[0]))
        .map(([type, moves]) => ({
          label: `${core.KANJI[type]}（${g.pos.hands[g.turn][type]}枚）`,
          description: `${moves.length}か所に打てます`,
          value: String(type),
        }));
      rows.push(selectRow('dtype', '打つ駒を選んでください', options));
      buttons.push(button('back', '戻る'));
      break;
    }
    case 'dropfile': {
      const files = [...new Set(legal.filter((m) => m.drop === sel.dropType).map((m) => m.to % 9))].sort((a, b) => a - b);
      rows.push(selectRow('dfile', '打つ筋を選んでください', files.map((x) => ({
        label: `${core.ZEN_DIGITS[8 - x]}筋`,
        value: String(x),
      }))));
      buttons.push(button('back', '戻る'));
      break;
    }
    case 'droprank': {
      const ranks = legal.filter((m) => m.drop === sel.dropType && m.to % 9 === sel.file).map((m) => (m.to / 9) | 0).sort((a, b) => a - b);
      rows.push(selectRow('drank', '打つ段を選んでください', ranks.map((y) => ({
        label: `${core.KAN_NUM[y]}段`,
        value: String(y),
      }))));
      buttons.push(button('back', '戻る'));
      break;
    }
    default:
      break;
  }

  buttons.push(button('resign', '投了', ButtonStyle.Danger));
  rows.push(new ActionRowBuilder().addComponents(...buttons));
  return rows;
}

// ---------- 結果の確定とレート記録 ----------
// outcome: { winner: BLACK|WHITE|null, reason }
function settle(game, outcome) {
  const p = game.players;
  const n = game.game.moves.length;
  const w = outcome.winner;
  const loser = w === null ? null : 1 - w;
  const who = (c) => `${SIDE[c].mark}${SIDE[c].name} **${p[c].displayName}**`;

  let text;
  switch (outcome.reason) {
    case 'checkmate':
      text = `🎉 詰み！ ${who(w)} の勝ち！（${n}手）`;
      break;
    case 'nomove':
      text = `🎉 ${who(loser)} は指せる手がありません。${who(w)} の勝ち！（${n}手）`;
      break;
    case 'resign':
      text = `🏳️ ${who(loser)} が投了しました。${who(w)} の勝ち！（${n}手）`;
      break;
    case 'timeout':
      text = `⌛ ${who(loser)} が時間切れです。${who(w)} の勝ち！（${n}手）`;
      break;
    case 'perpetual':
      text = `⚠️ 連続王手の千日手です。${who(loser)} の反則負け。${who(w)} の勝ち！（${n}手）`;
      break;
    case 'repetition':
      text = `🤝 千日手（同一局面4回）で引き分けです。（${n}手）`;
      break;
    default: // maxply
      text = `🤝 ${n}手に達したため、持将棋として引き分けです。`;
  }

  if (game.ranked) {
    try {
      const r = rating.recordMatch({
        game: GAME_ID,
        guildId: game.guildId,
        userA: p[BLACK].id,
        userB: p[WHITE].id,
        result: w === BLACK ? 'a' : w === WHITE ? 'b' : 'draw',
      });
      const fmt = (c, x) =>
        `${SIDE[c].mark} ${p[c].displayName}: ${x.before} → **${x.after}** (${x.delta >= 0 ? '+' : ''}${x.delta})`;
      text += `\n📈 レート変動\n${fmt(BLACK, r.a)}\n${fmt(WHITE, r.b)}`;
    } catch (err) {
      console.error('[shogi] rating error:', err);
      text += '\n⚠️ 戦績の保存に失敗しました。';
    }
  } else {
    text += '\n(Bot戦のためレートは変動しません)';
  }
  return text;
}

// ---------- Bot（やねうら王）の手番 ----------
// 手を指して、終局していればその結果（outcome）を返す。続行なら null
async function aiTurn(game) {
  const g = game.game;
  const aiColor = g.turn;

  let usi = null;
  try {
    usi = (await getEngine().bestMove(g.moves, game.level)).move;
  } catch (err) {
    console.error('[shogi] エンジンエラー:', err.message);
  }

  if (usi === 'resign') return { winner: 1 - aiColor, reason: 'resign' };

  let mv = usi ? core.findLegalByUsi(g.legalMoves(), usi) : null;
  if (!mv) {
    // エンジンが応答しない・想定外の手を返したときも、対局が止まらないようにする
    if (usi) console.warn(`[shogi] エンジンの手を指せません: ${usi}`);
    const legal = g.legalMoves();
    mv = legal[Math.floor(Math.random() * legal.length)];
    game.note = '⚠️ Botの思考エンジンが応答しなかったため、ランダムな手を指しました。';
  }
  game.events.push(core.describeMove(g.pos, mv));
  g.play(mv);
  return g.outcome();
}

// ---------- 保存と復元 ----------
const activeIds = new Set(); // いま操作を受け付けている対局のメッセージID
const restoringIds = new Set(); // 復元の処理中の対局（restoreSessions の二重実行を防ぐ）
const GONE_CODES = new Set([10003, 10008, 50001, 50013]); // メッセージ/チャンネルが無い・見られない

function saveSession(game, message) {
  sessions.put(GAME_ID, message.id, {
    channelId: message.channelId,
    guildId: game.guildId,
    moves: game.game.moves,
    players: game.players,
    ranked: game.ranked,
    level: game.level,
  });
}

function isValidSession(s) {
  const okPlayer = (p) => p && typeof p.id === 'string' && typeof p.displayName === 'string';
  return (
    Array.isArray(s.moves) && s.moves.every((m) => typeof m === 'string') &&
    okPlayer(s.players?.[BLACK]) && okPlayer(s.players?.[WHITE]) &&
    typeof s.channelId === 'string' && typeof s.ranked === 'boolean'
  );
}

const newUiState = () => ({ stage: 'pick', sel: {} });

// ---------- 対局の進行（新規開始・復元で共通） ----------
function startSession(game, message) {
  activeIds.add(message.id);
  saveSession(game, message);

  const humanIds = new Set(Object.values(game.players).filter((p) => !p.isAi).map((p) => p.id));
  const collector = message.createMessageComponentCollector({ idle: IDLE_TIMEOUT_MS });
  const deny = (i, text) => i.reply({ content: text, flags: MessageFlags.Ephemeral });

  // 手を指す（Bot が相手なら続けてBotの手も指す）。画面の更新までここで行う
  async function commitMove(i, mv) {
    const g = game.game;
    game.events = [];
    game.note = null;
    Object.assign(game, newUiState());
    game.events.push(core.describeMove(g.pos, mv));
    g.play(mv);

    let outcome = g.outcome();
    let respond = (payload) => i.update(payload);

    if (!outcome && game.players[g.turn].isAi) {
      game.busy = true; // Bot が考えている間は、ほかの操作を受け付けない
      try {
        saveSession(game, message); // 考えている途中で落ちても、ここから再開できる
        await i.deferUpdate(); // 3秒を超えるかもしれないので先に応答する
        respond = (payload) => i.editReply(payload);
        outcome = await aiTurn(game);
      } finally {
        game.busy = false;
      }
    }

    if (outcome) {
      collector.stop('finished');
      return respond(buildResult(game, settle(game, outcome)));
    }
    saveSession(game, message);
    return respond(buildPlayMessage(game));
  }

  collector.on('collect', async (i) => {
    try {
      if (!humanIds.has(i.user.id)) return deny(i, 'この対局の参加者ではありません。');
      if (game.busy) return deny(i, 'Botが考え中です。少しお待ちください。');

      // 投了（どちらでも可）
      if (i.customId === 'resign') {
        const loser = i.user.id === game.players[BLACK].id ? BLACK : WHITE;
        collector.stop('finished');
        return i.update(buildResult(game, settle(game, { winner: 1 - loser, reason: 'resign' })));
      }

      const g = game.game;
      if (i.user.id !== game.players[g.turn].id) return deny(i, 'あなたの手番ではありません。');

      const legal = g.legalMoves();
      const num = Number(i.values?.[0]);
      const sel = game.sel;
      const refresh = () => i.update(buildPlayMessage(game));
      const reset = () => {
        Object.assign(game, newUiState());
        return refresh();
      };

      switch (i.customId) {
        case 'pick':
          if (!boardMovesFrom(legal).has(num)) return reset();
          game.stage = 'dest';
          game.sel = { from: num };
          return refresh();

        case 'drop':
          game.stage = 'droptype';
          game.sel = {};
          return refresh();

        case 'dest': {
          const moves = legal.filter((m) => m.from === sel.from && m.to === num);
          if (moves.length === 0) return reset();
          if (moves.length === 1) return commitMove(i, moves[0]);
          game.stage = 'promote'; // 成る・成らないの両方が可能
          game.sel = { from: sel.from, to: num };
          return refresh();
        }

        case 'promo1':
        case 'promo0': {
          const wantPromo = i.customId === 'promo1';
          const mv = legal.find((m) => m.from === sel.from && m.to === sel.to && m.promo === wantPromo);
          return mv ? commitMove(i, mv) : reset();
        }

        case 'dtype':
          if (!dropTypesOf(legal).has(num)) return reset();
          game.stage = 'dropfile';
          game.sel = { dropType: num };
          return refresh();

        case 'dfile':
          game.stage = 'droprank';
          game.sel = { dropType: sel.dropType, file: num };
          return refresh();

        case 'drank': {
          const mv = legal.find((m) => m.drop === sel.dropType && m.to === num * 9 + sel.file);
          return mv ? commitMove(i, mv) : reset();
        }

        case 'back': {
          const prev = { dest: 'pick', droptype: 'pick', dropfile: 'droptype', droprank: 'dropfile' };
          if (game.stage === 'promote') {
            game.stage = 'dest';
            game.sel = { from: sel.from };
          } else if (prev[game.stage]) {
            game.stage = prev[game.stage];
            game.sel = game.stage === 'dropfile' ? { dropType: sel.dropType } : {};
          }
          return refresh();
        }

        default:
          return undefined;
      }
    } catch (err) {
      console.error('[shogi] interaction error:', err);
    }
  });

  collector.on('end', async (_collected, reason) => {
    // 終わった対局（終局・投了・時間切れ・メッセージ削除など）は保存データから消す
    activeIds.delete(message.id);
    sessions.remove(GAME_ID, message.id);

    if (reason !== 'idle') return;
    try {
      const text = game.ranked
        ? settle(game, { winner: 1 - game.game.turn, reason: 'timeout' }) // 手番の人が時間切れ負け
        : '⌛ 一定時間操作がなかったため、対局を終了しました。(Bot戦のため記録なし)';
      await message.edit(buildResult(game, text));
    } catch (err) {
      console.error('[shogi] timeout error:', err);
    }
  });
}

// 保存されている対局を1つ復元する
async function restoreOne(client, s) {
  let shogi;
  try {
    if (!isValidSession(s)) throw new Error('形式が正しくありません');
    shogi = new core.ShogiGame(s.moves); // 指し手を最初から再生して盤面を戻す（不正な手があれば例外）
  } catch (err) {
    console.warn(`[shogi] 保存データを復元できないため破棄しました (message ${s.messageId}): ${err.message}`);
    sessions.remove(GAME_ID, s.messageId);
    return;
  }

  let message;
  try {
    const channel = await client.channels.fetch(s.channelId);
    message = await channel.messages.fetch(s.messageId);
  } catch (err) {
    if (GONE_CODES.has(err.code)) {
      console.log(`[shogi] 対局のメッセージが見つからないため破棄しました (message ${s.messageId})`);
      sessions.remove(GAME_ID, s.messageId);
      return;
    }
    throw err; // 一時的な通信エラーなどは保存データを残す（次回の起動でもう一度試す）
  }

  if (Date.now() - (s.updatedAt ?? 0) > SESSION_STALE_MS) {
    sessions.remove(GAME_ID, s.messageId);
    await message
      .edit({
        content: '⌛ Botの再起動から長い時間がたったため、この対局は中断されました。(レートは変動しません)',
        components: [],
      })
      .catch(() => {});
    return;
  }

  const game = {
    game: shogi,
    players: s.players,
    ranked: s.ranked,
    level: s.level ?? 'normal',
    guildId: s.guildId ?? null,
    events: [],
    note: '♻️ Botが再起動したため、対局を復元しました。続きから遊べます。',
    busy: false,
    ...newUiState(),
  };

  // Botが考えている途中で再起動した場合は、Botの手から再開する
  let outcome = shogi.outcome();
  if (!outcome && game.players[shogi.turn].isAi) outcome = await aiTurn(game);
  if (outcome) {
    sessions.remove(GAME_ID, s.messageId);
    await message.edit(buildResult(game, settle(game, outcome)));
    return;
  }

  await message.edit(buildPlayMessage(game));
  startSession(game, message);
  console.log(`[shogi] 対局を復元しました (message ${s.messageId})`);
}

// Bot の起動後（ready）に index.js から呼ばれる
async function restoreSessions(client) {
  const saved = sessions.list(GAME_ID);
  if (saved.length === 0) return;
  console.log(`[shogi] 保存されている ${saved.length} 件の対局を復元します...`);

  for (const s of saved) {
    if (activeIds.has(s.messageId) || restoringIds.has(s.messageId)) continue;
    restoringIds.add(s.messageId);
    try {
      await restoreOne(client, s);
    } catch (err) {
      console.error(`[shogi] 対局の復元に失敗しました (message ${s.messageId}):`, err);
    } finally {
      restoringIds.delete(s.messageId);
    }
  }
}

// ---------- コマンド本体 ----------
module.exports = {
  data: new SlashCommandBuilder()
    .setName('shogi')
    .setDescription('将棋で対戦します（Botを指定するとやねうら王と対局）')
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

  restoreSessions,

  async execute(interaction) {
    const opponent = interaction.options.getUser('opponent', true);
    const level = interaction.options.getString('level') ?? 'normal';
    const challenger = interaction.user;

    if (opponent.id === challenger.id) {
      return interaction.reply({ content: '自分自身とは対戦できません。', flags: MessageFlags.Ephemeral });
    }

    const vsAi = opponent.bot;
    if (vsAi && !getEngine().configured) {
      return interaction.reply({
        content: 'Bot戦に使う将棋エンジン（やねうら王）が設定されていないため、現在はBot戦を利用できません。',
        flags: MessageFlags.Ephemeral,
      });
    }

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

    // 先手はランダム
    const challengerIsBlack = Math.random() < 0.5;
    const game = {
      game: new core.ShogiGame(),
      players: challengerIsBlack
        ? { [BLACK]: challengerEntry, [WHITE]: opponentEntry }
        : { [BLACK]: opponentEntry, [WHITE]: challengerEntry },
      ranked: !vsAi,
      level,
      guildId: interaction.guildId ?? null,
      events: [],
      note: null,
      busy: false,
      ...newUiState(),
    };

    let message;
    if (vsAi) {
      // Bot戦: 申し込みなしで即開始。エンジンの起動に時間がかかるので先に応答しておく
      await interaction.deferReply();
      if (!(await getEngine().ensureStarted())) {
        return interaction.editReply('将棋エンジン（やねうら王）を起動できなかったため、Bot戦を開始できませんでした。しばらくしてからもう一度お試しください。');
      }
      // Botが先手なら先に指す。この時点で終局（Botの投了）になることもある
      const outcome = game.players[game.game.turn].isAi ? await aiTurn(game) : null;
      if (outcome) {
        await interaction.editReply(buildResult(game, settle(game, outcome)));
        return undefined;
      }
      await interaction.editReply(buildPlayMessage(game));
      message = await interaction.fetchReply();
    } else {
      // 人間戦: 承諾を待ってから開始（申し込み中の状態は保存しない。再起動で取り消される）
      const res = await requestChallenge(interaction, { opponent, gameLabel: GAMES[GAME_ID].label });
      if (res.status !== 'accepted') return undefined;
      await res.interaction.update(buildPlayMessage(game));
      message = res.message;
    }

    startSession(game, message);
    return undefined;
  },
};
