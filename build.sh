#!/usr/bin/env bash
set -e

npm install

mkdir -p /tmp/yaneuraou-src

# GitHub APIから最新リリースのtarball_urlを取得してダウンロード
TAR_URL=$(node -e "
  fetch('https://github.com', {
    headers: { 'User-Agent': 'render-build' }
  })
  .then(r => r.json())
  .then(d => {
    if (!d.tarball_url) throw new Error(JSON.stringify(d));
    console.log(d.tarball_url);
  });
")

echo "Downloading: $TAR_URL"
curl -fL -H "User-Agent: render-build" "$TAR_URL" -o /tmp/yaneuraou.tar.gz
tar -xzf /tmp/yaneuraou.tar.gz -C /tmp/yaneuraou-src --strip-components=1

make -C /tmp/yaneuraou-src/source tournament YANEURAOU_EDITION=YANEURAOU_ENGINE_MATERIAL
mkdir -p engine
cp /tmp/yaneuraou-src/source/YaneuraOu-by-gcc engine/yaneuraou
chmod +x engine/yaneuraou
