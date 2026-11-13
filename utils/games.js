'use strict';

// 対戦ゲームの登録簿。
// 新しい対戦コマンドを作ったら、ここに1行足すだけで /ranking の選択肢に出ます。
//   キー  : レート保存時に使うゲームID（一度決めたら変更しないこと）
//   label : 表示名
const GAMES = {
  othello: { label: 'オセロ' },
  // connect4: { label: '四目並べ' },
};

const DEFAULT_GAME = Object.keys(GAMES)[0];

module.exports = { GAMES, DEFAULT_GAME };