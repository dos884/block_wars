#!/bin/sh
# Build the itch.io version and push it to https://dos884.itch.io/cube-wars (channel "html5").
# The butler API key lives in /etc/itch-butler.env (root only), never in git.
set -eu
cd "$(dirname "$0")/.."
node tools/build-itch.js
set -a; . /etc/itch-butler.env; set +a
butler push itch/cube-wars-itch.zip dos884/cube-wars:html5
