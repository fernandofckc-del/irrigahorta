#!/bin/sh
# Compila o teste nativo do firmware (núcleo + hardware de mentira) no PC.
# Uso: testes/nativo/compila.sh      → gera testes/nativo/rega
# ArduinoJson: usa $ARDUINOJSON_SRC; senão a da Arduino IDE (~/Arduino/libraries);
# senão baixa a v7.4.3 do GitHub para testes/nativo/.ArduinoJson.
set -e
AQUI=$(cd "$(dirname "$0")" && pwd)
if [ -n "$ARDUINOJSON_SRC" ]; then
  AJ="$ARDUINOJSON_SRC"
elif [ -f "$HOME/Arduino/libraries/ArduinoJson/src/ArduinoJson.h" ]; then
  AJ="$HOME/Arduino/libraries/ArduinoJson/src"
else
  if [ ! -f "$AQUI/.ArduinoJson/src/ArduinoJson.h" ]; then
    echo "Baixando ArduinoJson 7.4.3..." >&2
    rm -rf "$AQUI/.ArduinoJson"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch v7.4.3 https://github.com/bblanchon/ArduinoJson "$AQUI/.ArduinoJson"
  fi
  AJ="$AQUI/.ArduinoJson/src"
fi
# -Wno-maybe-uninitialized: falso alarme do GCC dentro do ArduinoJson (com os sanitizers)
${CXX:-g++} -std=c++17 -O1 -g -Wall -Wextra -Wno-maybe-uninitialized -fno-omit-frame-pointer \
  -fsanitize=address,undefined -fno-sanitize-recover=undefined \
  -isystem "$AJ" -I"$AQUI/../../firmware/ControladorRega" \
  "$AQUI/main.cpp" -o "$AQUI/rega"
echo "ok: $AQUI/rega" >&2
