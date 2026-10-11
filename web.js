// web.js
const express = require('express');
const path = require('node:path');

const app = express();

// public フォルダの静的ファイルを公開
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// ビューエンジンの設定（EJS等を使う場合）
app.set('view engine', 'ejs');

// ルート設定（Renderのヘルスチェック用・ホームページ）
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// TODO: ここにDiscord OAuth2認証やサーバー設定用のルーティングを追加していく
// 例: app.get('/dashboard', (req, res) => { ... });

module.exports = app;