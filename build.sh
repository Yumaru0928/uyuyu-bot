#!/usr/bin/env bash
set -e

npm install

git clone --depth 1 https://github.com /tmp/YaneuraOu
make -C /tmp/YaneuraOu/source tournament YANEURAOU_EDITION=YANEURAOU_ENGINE_MATERIAL
mkdir -p engine
cp /tmp/YaneuraOu/source/YaneuraOu-by-gcc engine/yaneuraou
chmod +x engine/yaneuraou
