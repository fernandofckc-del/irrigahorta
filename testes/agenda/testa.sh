#!/bin/sh
# Teste diferencial das contas da agenda (PROTOCOLO §3–§4):
#   referência em Python (feita direto da especificação)  ×  agenda.h (firmware)  ×  agenda.js (app)
# Gera os casos com semente fixa, roda os três e compara.
# Uso: testes/agenda/testa.sh [semente] [nR] [nP] [nB]
# (AGENDA_JS / AGENDA_H_DIR / SAIDA_AGENDA trocam os arquivos testados: usados no teste de mutantes,
#  testes/agenda/mutantes.py, que confere que este teste pega erros de propósito)
# AGENDA_INTEGRACAO=<n>: roda também n cenários no núcleo do firmware (testes/nativo), mais lento.
set -e
export PYTHONDONTWRITEBYTECODE=1  # sem __pycache__ dentro do repositório
AQUI=$(cd "$(dirname "$0")" && pwd)
RAIZ=$(cd "$AQUI/../.." && pwd)
SAI="${SAIDA_AGENDA:-$RAIZ/testes/.saida/agenda}"
SEMENTE=${1:-20261022}
mkdir -p "$SAI"

echo "== compilando o driver C++ (agenda.h, com -fsanitize=undefined)"
${CXX:-g++} -std=c++17 -O2 -Wall -Wextra -fsanitize=undefined -fno-sanitize-recover=undefined \
  -I"${AGENDA_H_DIR:-$RAIZ/firmware/ControladorRega}" "$AQUI/driver.cpp" -o "$SAI/driver"

echo "== gerando os casos e a resposta da referência (Python)"
python3 "$AQUI/gera.py" "$SAI" "$SEMENTE" ${2:-320000} ${3:-20000} ${4:-8000}

echo "== rodando o C++"
"$SAI/driver" < "$SAI/casos.txt" > "$SAI/cpp.txt"

echo "== rodando o JS (com conferência interna por força bruta)"
JS_OK=0
node "$AQUI/driver.cjs" "$SAI/casos.txt" "$SAI/js.txt" || JS_OK=1

echo "== comparando"
CMP_OK=0
python3 "$AQUI/compara.py" "$SAI" || CMP_OK=1

# opcional (lento, ~2 min): o núcleo do firmware rodando dias simulados tem que ligar/desligar
# nos minutos que a referência manda.  Ex.: AGENDA_INTEGRACAO=8 testes/agenda/testa.sh
INT_OK=0
if [ -n "$AGENDA_INTEGRACAO" ]; then
  BIN="$RAIZ/testes/nativo/rega"
  FW="$RAIZ/firmware/ControladorRega"
  if [ ! -x "$BIN" ] || [ "$FW/nucleo.h" -nt "$BIN" ] || [ "$FW/agenda.h" -nt "$BIN" ]; then
    sh "$RAIZ/testes/nativo/compila.sh"
  fi
  echo "== integração com o núcleo do firmware ($AGENDA_INTEGRACAO cenários × 2 dias)"
  python3 "$AQUI/integracao.py" "$BIN" "$SAI/integracao" "$SEMENTE" "$AGENDA_INTEGRACAO" 2 || INT_OK=1
fi

if [ $JS_OK -ne 0 ] || [ $CMP_OK -ne 0 ] || [ $INT_OK -ne 0 ]; then
  echo "FALHOU"
  exit 1
fi
echo "TUDO IGUAL"
