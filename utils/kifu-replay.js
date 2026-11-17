'use strict';

// 棋譜の再生（着手列 → n手目の局面 → 盤面画像）。
// Web（web.js）からも、テスト（dev/test-kifu.js）からも使う共通部品。
//
// ・将棋: ShogiGame に USI の指し手を途中まで適用する（コマンド側の復元と同じ方式）
// ・オセロ: 着手列にはパスが含まれないので、再生時に「手番側に合法手が無ければパス」
//   として読み替える（対局中の doMove と同じ規則）
// ・四目並べ: 列番号を順に落とすだけ

const shogiCore = require('./shogi-core');
const othelloCore = require('./othello-core');
const connect4Core = require('./connect4-core');
const boardImage = require('./board-image');

/** ply（手数）を 0..着手数 の範囲に収める */
function clampPly(record, ply) {
  const total = Array.isArray(record?.moves) ? record.moves.length : 0;
  const n = Number.parseInt(ply, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, total);
}

// USI の指し手から移動先のマス番号を求める（将棋の最終手ハイライト用）。
// 打ち手は "P*5e"、動かす手は "7g7f" / "7g7f+" の形で、どちらも移動先は3〜4文字目。
// sq = y*9+x（x=0 が9筋）
function usiToSquare(usi) {
  const dest = String(usi).slice(2, 4);
  const file = Number(dest[0]); // 1..9
  const y = dest.charCodeAt(1) - 'a'.charCodeAt(0); // a=0段 .. i=8段
  if (!Number.isInteger(file) || file < 1 || file > 9 || y < 0 || y > 8) return null;
  return y * 9 + (9 - file);
}

/** 将棋: n手目までの局面 { pos, lastMoveTo } */
function shogiPositionAt(moves, n) {
  const g = new shogiCore.ShogiGame(moves.slice(0, n));
  return { pos: g.pos, lastMoveTo: n > 0 ? usiToSquare(moves[n - 1]) : null };
}

/** オセロ: n手目までの盤面 { board, lastMove }。パスは合法手の有無から再現する */
function othelloBoardAt(moves, n) {
  const board = othelloCore.createBoard();
  let turn = othelloCore.BLACK;
  let lastMove = null;
  for (let i = 0; i < n; i++) {
    // 手番側に置ける場所がなければパス（相手にも無ければ終局なのでそこで止める）
    if (othelloCore.getLegalMoves(board, turn).length === 0) {
      if (othelloCore.getLegalMoves(board, 3 - turn).length === 0) break;
      turn = 3 - turn;
    }
    const m = moves[i];
    if (!m || othelloCore.place(board, m.x, m.y, turn).length === 0) break; // 壊れた棋譜では止める
    lastMove = { x: m.x, y: m.y };
    turn = 3 - turn;
  }
  return { board, lastMove };
}

/** 四目並べ: n手目までの盤面 { board, lastMove, winLine } */
function connect4BoardAt(moves, n) {
  const board = connect4Core.createBoard();
  let turn = connect4Core.RED;
  let lastMove = null;
  for (let i = 0; i < n; i++) {
    const placed = connect4Core.drop(board, moves[i], turn);
    if (!placed) break; // 壊れた棋譜では止める
    lastMove = placed;
    turn = 3 - turn;
  }
  const win = connect4Core.findWinner(board);
  return { board, lastMove, winLine: win ? win.line : null };
}

/** n手目の盤面画像（PNG の Buffer）。Canvas が使えない環境では null */
function renderPositionPng(record, ply) {
  const n = clampPly(record, ply);
  switch (record.game) {
    case 'shogi': {
      const { pos, lastMoveTo } = shogiPositionAt(record.moves, n);
      return boardImage.renderShogi(pos, shogiCore, { lastMoveTo });
    }
    case 'othello': {
      const { board, lastMove } = othelloBoardAt(record.moves, n);
      return boardImage.renderOthello(board, { lastMove });
    }
    case 'connect4': {
      const { board, lastMove, winLine } = connect4BoardAt(record.moves, n);
      return boardImage.renderConnect4(board, { lastMove, winLine });
    }
    default:
      return null;
  }
}

/** 着手リストの表示用ラベル（将棋はUSI、オセロは F5 のような座標、四目並べは列番号） */
function moveLabels(record) {
  switch (record.game) {
    case 'shogi':
      return record.moves.map((m) => String(m));
    case 'othello':
      return record.moves.map((m) => `${othelloCore.COLS[m.x].toUpperCase()}${m.y + 1}`);
    case 'connect4':
      return record.moves.map((m) => `${m + 1}列`);
    default:
      return [];
  }
}

module.exports = {
  clampPly,
  shogiPositionAt,
  othelloBoardAt,
  connect4BoardAt,
  renderPositionPng,
  moveLabels,
};
