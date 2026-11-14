'use strict';

// 将棋のルール（discord.js にも USI エンジンにも依存しない）
//
// 座標: 盤は 81 マスの配列。sq = y * 9 + x
//   x = 0..8 … 画面の左から右（筋は 9..1。 筋 = 9 - x）
//   y = 0..8 … 画面の上から下（段は 一..九。段 = y + 1）
//   先手(BLACK)は y が小さい方（上）へ進む
//
// 駒の値: type | (成り ? 16 : 0) | (後手 ? 32 : 0)。 0 は空き
//
// 実装している規則: 王手放置の禁止、二歩、行き所のない駒の禁止、打ち歩詰め、成り・不成、
//   詰み/指し手なし、千日手（同一局面4回）、連続王手の千日手（王手をかけ続けた側の負け）、手数上限
// 実装していない規則: 入玉宣言（持将棋の27点法）。代わりに手数上限で引き分けにする

const BLACK = 0;
const WHITE = 1;

const PAWN = 1, LANCE = 2, KNIGHT = 3, SILVER = 4, GOLD = 5, BISHOP = 6, ROOK = 7, KING = 8;
const PROMO = 16;
const GOTE = 32;

const typeOf = (c) => c & 15;
const isPromoted = (c) => (c & PROMO) !== 0;
const colorOf = (c) => (c & GOTE ? WHITE : BLACK);
const makePiece = (type, color, promoted = false) =>
  type | (promoted ? PROMO : 0) | (color === WHITE ? GOTE : 0);

// ---------- 駒の動き ----------
// 8方向（先手から見て）。dy < 0 が前
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const FLIP = [5, 6, 7, 3, 4, 0, 1, 2]; // 後手は上下反転
const bits = (list) => list.reduce((m, d) => m | (1 << d), 0);
const flipMask = (mask) => {
  let out = 0;
  for (let d = 0; d < 8; d++) if (mask & (1 << d)) out |= 1 << FLIP[d];
  return out;
};

const GOLD_STEP = bits([0, 1, 2, 3, 4, 6]);
const STEP = new Int32Array(64); // 1マス動ける方向
const SLIDE = new Int32Array(64); // 何マスでも動ける方向
for (const color of [BLACK, WHITE]) {
  for (let type = PAWN; type <= KING; type++) {
    for (const promoted of [false, true]) {
      if (promoted && (type === GOLD || type === KING)) continue;
      let step = 0;
      let slide = 0;
      if (promoted && type !== BISHOP && type !== ROOK) step = GOLD_STEP; // と・成香・成桂・成銀
      else if (type === PAWN) step = bits([1]);
      else if (type === LANCE) slide = bits([1]);
      else if (type === SILVER) step = bits([0, 1, 2, 5, 7]);
      else if (type === GOLD) step = GOLD_STEP;
      else if (type === BISHOP) { slide = bits([0, 2, 5, 7]); if (promoted) step = bits([1, 3, 4, 6]); }
      else if (type === ROOK) { slide = bits([1, 3, 4, 6]); if (promoted) step = bits([0, 2, 5, 7]); }
      else if (type === KING) step = bits([0, 1, 2, 3, 4, 5, 6, 7]);
      // 桂馬は専用処理
      if (color === WHITE) { step = flipMask(step); slide = flipMask(slide); }
      const code = makePiece(type, color, promoted);
      STEP[code] = step;
      SLIDE[code] = slide;
    }
  }
}

// ---------- 局面 ----------
class Position {
  constructor() {
    this.board = new Uint8Array(81);
    this.hands = [new Uint8Array(8), new Uint8Array(8)]; // hands[color][type] (type 1..7)
    this.turn = BLACK;
    this.ply = 0;
    this.king = [-1, -1];
  }
}

const PIECE_CH = [null, 'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K'];
const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

function fromSfen(sfen) {
  if (sfen === 'startpos') sfen = START_SFEN;
  const [boardPart, turnPart = 'b', handPart = '-', plyPart = '1'] = sfen.trim().split(/\s+/);
  const pos = new Position();

  const rows = boardPart.split('/');
  if (rows.length !== 9) throw new Error('SFEN: 段の数が正しくありません');
  for (let y = 0; y < 9; y++) {
    let x = 0;
    let promoted = false;
    for (const ch of rows[y]) {
      if (ch === '+') { promoted = true; continue; }
      if (ch >= '1' && ch <= '9') { x += Number(ch); continue; }
      const type = PIECE_CH.indexOf(ch.toUpperCase());
      if (type < 1 || x > 8) throw new Error(`SFEN: 不正な駒 ${ch}`);
      const color = ch === ch.toUpperCase() ? BLACK : WHITE;
      const sq = y * 9 + x;
      pos.board[sq] = makePiece(type, color, promoted);
      if (type === KING) pos.king[color] = sq;
      promoted = false;
      x++;
    }
    if (x !== 9) throw new Error('SFEN: 1段の幅が9ではありません');
  }
  pos.turn = turnPart === 'w' ? WHITE : BLACK;

  if (handPart !== '-') {
    let count = '';
    for (const ch of handPart) {
      if (ch >= '0' && ch <= '9') { count += ch; continue; }
      const type = PIECE_CH.indexOf(ch.toUpperCase());
      if (type < 1 || type > 7) throw new Error(`SFEN: 不正な持ち駒 ${ch}`);
      const color = ch === ch.toUpperCase() ? BLACK : WHITE;
      pos.hands[color][type] += count ? Number(count) : 1;
      count = '';
    }
  }
  pos.ply = Math.max(0, Number(plyPart) - 1);
  return pos;
}

function toSfen(pos, withPly = true) {
  let s = '';
  for (let y = 0; y < 9; y++) {
    let empty = 0;
    for (let x = 0; x < 9; x++) {
      const p = pos.board[y * 9 + x];
      if (!p) { empty++; continue; }
      if (empty) { s += empty; empty = 0; }
      const ch = PIECE_CH[typeOf(p)];
      s += (isPromoted(p) ? '+' : '') + (colorOf(p) === BLACK ? ch : ch.toLowerCase());
    }
    if (empty) s += empty;
    if (y < 8) s += '/';
  }
  s += pos.turn === BLACK ? ' b ' : ' w ';
  let hand = '';
  for (const color of [BLACK, WHITE]) {
    for (let type = ROOK; type >= PAWN; type--) {
      const n = pos.hands[color][type];
      if (!n) continue;
      const ch = PIECE_CH[type];
      hand += (n > 1 ? n : '') + (color === BLACK ? ch : ch.toLowerCase());
    }
  }
  s += hand || '-';
  if (withPly) s += ` ${pos.ply + 1}`;
  return s;
}

const startPosition = () => fromSfen(START_SFEN);

// ---------- 王手の判定 ----------
// (x, y) のマスが by 側の駒に利かされているか
function isAttacked(board, x, y, by) {
  for (let d = 0; d < 8; d++) {
    const [dx, dy] = DIRS[d];
    const back = 1 << (7 - d); // 攻撃する駒から見た「このマスへ向かう方向」
    let nx = x + dx;
    let ny = y + dy;
    let dist = 1;
    while (nx >= 0 && nx < 9 && ny >= 0 && ny < 9) {
      const p = board[ny * 9 + nx];
      if (p !== 0) {
        if (colorOf(p) === by) {
          if (SLIDE[p] & back) return true;
          if (dist === 1 && (STEP[p] & back)) return true;
        }
        break;
      }
      nx += dx;
      ny += dy;
      dist++;
    }
  }
  // 桂馬
  const ky = by === BLACK ? y + 2 : y - 2; // 先手の桂は上へ2つ進むので、攻撃元は2つ下にいる
  if (ky >= 0 && ky < 9) {
    const knight = makePiece(KNIGHT, by, false);
    if (x - 1 >= 0 && board[ky * 9 + x - 1] === knight) return true;
    if (x + 1 < 9 && board[ky * 9 + x + 1] === knight) return true;
  }
  return false;
}

function isKingAttacked(pos, color) {
  const k = pos.king[color];
  if (k < 0) return false;
  return isAttacked(pos.board, k % 9, (k / 9) | 0, 1 - color);
}

/** 手番側が王手をかけられているか */
const inCheck = (pos) => isKingAttacked(pos, pos.turn);

// ---------- 指し手の生成 ----------
const inZone = (color, y) => (color === BLACK ? y <= 2 : y >= 6);
const lastRank = (color) => (color === BLACK ? 0 : 8);
function mustPromote(type, color, y) {
  if (type === PAWN || type === LANCE) return y === lastRank(color);
  if (type === KNIGHT) return color === BLACK ? y <= 1 : y >= 7;
  return false;
}

function pushBoardMoves(out, from, to, piece, color) {
  const type = typeOf(piece);
  if (!isPromoted(piece) && type !== GOLD && type !== KING) {
    const fy = (from / 9) | 0;
    const ty = (to / 9) | 0;
    if (inZone(color, fy) || inZone(color, ty)) {
      out.push({ from, to, promo: true, drop: 0 });
      if (!mustPromote(type, color, ty)) out.push({ from, to, promo: false, drop: 0 });
      return;
    }
  }
  out.push({ from, to, promo: false, drop: 0 });
}

// 自玉の安全を考えない指し手（疑似合法手）
function genPseudo(pos) {
  const out = [];
  const b = pos.board;
  const color = pos.turn;
  const pawnFiles = new Uint8Array(9);

  for (let sq = 0; sq < 81; sq++) {
    const piece = b[sq];
    if (piece === 0 || colorOf(piece) !== color) continue;
    const x = sq % 9;
    const y = (sq / 9) | 0;
    const type = typeOf(piece);
    if (type === PAWN && !isPromoted(piece)) pawnFiles[x] = 1;

    const step = STEP[piece];
    const slide = SLIDE[piece];
    for (let d = 0; d < 8; d++) {
      const bit = 1 << d;
      const [dx, dy] = DIRS[d];
      if (step & bit) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < 9 && ny >= 0 && ny < 9) {
          const t = ny * 9 + nx;
          if (b[t] === 0 || colorOf(b[t]) !== color) pushBoardMoves(out, sq, t, piece, color);
        }
      }
      if (slide & bit) {
        let nx = x + dx;
        let ny = y + dy;
        while (nx >= 0 && nx < 9 && ny >= 0 && ny < 9) {
          const t = ny * 9 + nx;
          if (b[t] === 0) {
            pushBoardMoves(out, sq, t, piece, color);
          } else {
            if (colorOf(b[t]) !== color) pushBoardMoves(out, sq, t, piece, color);
            break;
          }
          nx += dx;
          ny += dy;
        }
      }
    }
    if (type === KNIGHT && !isPromoted(piece)) {
      const ny = y + (color === BLACK ? -2 : 2);
      if (ny >= 0 && ny < 9) {
        for (const dx of [-1, 1]) {
          const nx = x + dx;
          if (nx < 0 || nx > 8) continue;
          const t = ny * 9 + nx;
          if (b[t] === 0 || colorOf(b[t]) !== color) pushBoardMoves(out, sq, t, piece, color);
        }
      }
    }
  }

  // 打つ手
  const hand = pos.hands[color];
  for (let type = PAWN; type <= ROOK; type++) {
    if (!hand[type]) continue;
    for (let sq = 0; sq < 81; sq++) {
      if (b[sq] !== 0) continue;
      const y = (sq / 9) | 0;
      if ((type === PAWN || type === LANCE) && y === lastRank(color)) continue;
      if (type === KNIGHT && mustPromote(KNIGHT, color, y)) continue; // 行き所のない桂
      if (type === PAWN && pawnFiles[sq % 9]) continue; // 二歩
      out.push({ from: -1, to: sq, promo: false, drop: type });
    }
  }
  return out;
}

function doMove(pos, mv) {
  const b = pos.board;
  const color = pos.turn;
  let undo;
  if (mv.drop) {
    b[mv.to] = makePiece(mv.drop, color);
    pos.hands[color][mv.drop]--;
    undo = { piece: 0, captured: 0 };
  } else {
    const piece = b[mv.from];
    const captured = b[mv.to];
    b[mv.from] = 0;
    b[mv.to] = mv.promo ? piece | PROMO : piece;
    if (captured) pos.hands[color][typeOf(captured)]++;
    if (typeOf(piece) === KING) pos.king[color] = mv.to;
    undo = { piece, captured };
  }
  pos.turn = 1 - color;
  pos.ply++;
  return undo;
}

function undoMove(pos, mv, undo) {
  const b = pos.board;
  pos.turn = 1 - pos.turn;
  pos.ply--;
  const color = pos.turn;
  if (mv.drop) {
    b[mv.to] = 0;
    pos.hands[color][mv.drop]++;
  } else {
    b[mv.from] = undo.piece;
    b[mv.to] = undo.captured;
    if (undo.captured) pos.hands[color][typeOf(undo.captured)]--;
    if (typeOf(undo.piece) === KING) pos.king[color] = mv.from;
  }
}

// 手番側に合法手が1つでもあるか（打ち歩詰めの判定には使わない＝再帰しない）
function hasLegalMove(pos) {
  const color = pos.turn;
  for (const mv of genPseudo(pos)) {
    const undo = doMove(pos, mv);
    const ok = !isKingAttacked(pos, color);
    undoMove(pos, mv, undo);
    if (ok) return true;
  }
  return false;
}

/** 手番側の合法手の一覧 [{ from, to, promo, drop }] (from = -1 は打つ手) */
function legalMoves(pos) {
  const color = pos.turn;
  const out = [];
  for (const mv of genPseudo(pos)) {
    const undo = doMove(pos, mv);
    let ok = !isKingAttacked(pos, color);
    // 打ち歩詰め: 歩を打って王手になり、相手に合法手が1つもなければ反則
    if (ok && mv.drop === PAWN && isKingAttacked(pos, 1 - color) && !hasLegalMove(pos)) ok = false;
    undoMove(pos, mv, undo);
    if (ok) out.push(mv);
  }
  return out;
}

function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const mv of moves) {
    const undo = doMove(pos, mv);
    n += perft(pos, depth - 1);
    undoMove(pos, mv, undo);
  }
  return n;
}

// ---------- USI の指し手表記 ----------
const RANK_CH = 'abcdefghi';
const sqToUsi = (sq) => `${9 - (sq % 9)}${RANK_CH[(sq / 9) | 0]}`;

function moveToUsi(mv) {
  if (mv.drop) return `${PIECE_CH[mv.drop]}*${sqToUsi(mv.to)}`;
  return `${sqToUsi(mv.from)}${sqToUsi(mv.to)}${mv.promo ? '+' : ''}`;
}

function findLegalByUsi(legal, usi) {
  return legal.find((mv) => moveToUsi(mv) === usi) ?? null;
}

// ---------- 日本語の表示 ----------
const KANJI = [null, '歩', '香', '桂', '銀', '金', '角', '飛', '玉'];
const PROMOTED_KANJI = [null, 'と', '杏', '圭', '全', null, '馬', '龍', null];
const ZEN_DIGITS = '１２３４５６７８９';
const KAN_NUM = '一二三四五六七八九';

const pieceKanji = (code) => (isPromoted(code) ? PROMOTED_KANJI[typeOf(code)] : KANJI[typeOf(code)]);
const squareLabel = (sq) => `${ZEN_DIGITS[8 - (sq % 9)]}${KAN_NUM[(sq / 9) | 0]}`; // 例: ７六

function kanjiCount(n) {
  if (n < 10) return KAN_NUM[n - 1];
  return `十${n > 10 ? KAN_NUM[n - 11] : ''}`;
}

/** 指す前の局面で、その手を「▲７六歩(77)」のように表す */
function describeMove(pos, mv) {
  const mark = pos.turn === BLACK ? '▲' : '△';
  if (mv.drop) return `${mark}${squareLabel(mv.to)}${KANJI[mv.drop]}打`;
  const piece = pos.board[mv.from];
  const fx = 9 - (mv.from % 9);
  const fy = ((mv.from / 9) | 0) + 1;
  return `${mark}${squareLabel(mv.to)}${pieceKanji(piece)}${mv.promo ? '成' : ''}(${fx}${fy})`;
}

// ---------- 対局の進行 ----------
const DEFAULT_MAX_PLIES = 320;

class ShogiGame {
  /** @param {string[]} moves USI の指し手の列（途中からの復元用） */
  constructor(moves = [], { maxPlies = DEFAULT_MAX_PLIES } = {}) {
    this.pos = startPosition();
    this.moves = [];
    this.maxPlies = maxPlies;
    this.history = [{ key: toSfen(this.pos, false), check: false, mover: null }];
    this._legal = null;
    for (const usi of moves) {
      const mv = findLegalByUsi(this.legalMoves(), usi);
      if (!mv) throw new Error(`不正な指し手です: ${usi}`);
      this.play(mv);
    }
  }

  get turn() { return this.pos.turn; }

  legalMoves() {
    this._legal ??= legalMoves(this.pos);
    return this._legal;
  }

  /** legalMoves() の中の手を指す */
  play(mv) {
    const mover = this.pos.turn;
    this.moves.push(moveToUsi(mv));
    doMove(this.pos, mv);
    this.history.push({ key: toSfen(this.pos, false), check: inCheck(this.pos), mover });
    this._legal = null;
  }

  /**
   * 終局していれば { winner: BLACK|WHITE|null, reason } を返す。続行なら null
   * reason: 'checkmate' | 'nomove' | 'repetition' | 'perpetual' | 'maxply'
   */
  outcome() {
    const legal = this.legalMoves();
    if (legal.length === 0) {
      return { winner: 1 - this.turn, reason: inCheck(this.pos) ? 'checkmate' : 'nomove' };
    }

    // 千日手（同一局面4回）
    const last = this.history.length - 1;
    const key = this.history[last].key;
    const same = [];
    for (let i = 0; i <= last; i++) if (this.history[i].key === key) same.push(i);
    if (same.length >= 4) {
      const start = same[same.length - 4];
      // 連続王手の千日手: 周期の間、王手をかけ続けた側が負け
      const alwaysCheck = [true, true];
      const moved = [false, false];
      for (let j = start + 1; j <= last; j++) {
        const h = this.history[j];
        moved[h.mover] = true;
        if (!h.check) alwaysCheck[h.mover] = false;
      }
      const losers = [BLACK, WHITE].filter((c) => moved[c] && alwaysCheck[c]);
      if (losers.length === 1) return { winner: 1 - losers[0], reason: 'perpetual' };
      return { winner: null, reason: 'repetition' };
    }

    if (this.moves.length >= this.maxPlies) return { winner: null, reason: 'maxply' };
    return null;
  }
}

module.exports = {
  BLACK, WHITE,
  PAWN, LANCE, KNIGHT, SILVER, GOLD, BISHOP, ROOK, KING,
  typeOf, colorOf, isPromoted, makePiece,
  Position, START_SFEN, fromSfen, toSfen, startPosition,
  inCheck, isAttacked, isKingAttacked,
  legalMoves, doMove, undoMove, perft,
  sqToUsi, moveToUsi, findLegalByUsi,
  KANJI, pieceKanji, squareLabel, kanjiCount, describeMove, ZEN_DIGITS, KAN_NUM,
  ShogiGame, DEFAULT_MAX_PLIES,
};
