#!/usr/bin/env bash
set -e

npm install

mkdir -p /tmp/yaneuraou-src
curl -L https://github.com | tar -xz -C /tmp/yaneuraou-src --strip-components=1

make -C /tmp/yaneuraou-src/source tournament YANEURAOU_EDITION=YANEURAOU_ENGINE_MATERIAL
mkdir -p engine
cp /tmp/yaneuraou-src/source/YaneuraOu-by-gcc engine/yaneuraou
chmod +x engine/yaneuraou
