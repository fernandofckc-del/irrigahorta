#!/usr/bin/env python3
# Teste de integração: o núcleo do firmware (testes/nativo, compilado no PC) rodando dias simulados
# com regras sorteadas tem que ligar/desligar cada saída exatamente nos minutos que a referência
# (referencia.py = PROTOCOLO §4) manda.
#
# Uso: integracao.py <binário do simulador> <pasta de saída> [semente] [cenários] [dias]
import json
import os
import random
import subprocess
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gera  # noqa: E402
import referencia as ref  # noqa: E402

BIN = sys.argv[1]
SAI = sys.argv[2]
SEMENTE = int(sys.argv[3]) if len(sys.argv) > 3 else 20261022
N = int(sys.argv[4]) if len(sys.argv) > 4 else 24
DIAS = float(sys.argv[5]) if len(sys.argv) > 5 else 2
FOLGA = 3  # segundos de atraso aceitos (laço de 1 s + fila de pulsos das válvulas)


def regras_json(regras):
    out = []
    for r in regras:
        if r["k"] == "f":
            out.append({"k": "f", "h": r["h"], "d": r["d"], "w": r["w"], "en": r["en"]})
        else:
            out.append({"k": "c", "a": r["a"], "b": r["b"], "on": r["on"], "off": r["off"], "w": r["w"], "en": r["en"]})
    return out


def cenario(i):
    rnd = random.Random(SEMENTE * 1000 + i)
    tz = gera.sorteia_tz(rnd)
    regras = [gera.sorteia_regras(rnd) for _ in range(4)]
    # início perto de uma virada de minuto/dia (às vezes)
    D = rnd.randint(1700000000 // 86400 + 1, 2000000000 // 86400)
    L0 = D * 86400 + rnd.choice((0, -30, 30, rnd.randrange(86400)))
    ep0 = L0 - tz * 60
    cfg = {"tz": tz, "s": [{"en": 1, "r": regras_json(regras[s])} for s in range(4)]}
    seg = int(DIAS * 86400)
    entrada = "\n".join([
        json.dumps({"t": "hora", "ep": ep0, "tz": tz}),
        "#avanca 0.5",
        json.dumps({"t": "cfg", "c": cfg}, ensure_ascii=False),
        "#avanca 1",
        "#marca cfg",
        "#avanca %d" % seg,
        "#marca fim",
    ]) + "\n"
    arq_in = os.path.join(SAI, "int_%03d.in" % i)
    arq_err = os.path.join(SAI, "int_%03d.err" % i)
    with open(arq_in, "w") as f:
        f.write(entrada)
    p = subprocess.run("'%s' < '%s' 2> '%s' | grep -F -e '\"t\":\"ev\"' -e '\"t\":\"#marca\"' -e '\"t\":\"err\"'"
                       % (BIN, arq_in, arq_err), shell=True, capture_output=True, text=True)
    linhas = [json.loads(x) for x in p.stdout.splitlines() if x.strip()]
    problemas = []
    with open(arq_err) as f:
        for ln in f:
            if ln.startswith("#ERRO"):
                problemas.append("simulador: " + ln.strip())
    for m in linhas:
        if m.get("t") == "err":
            problemas.append("firmware respondeu err: %s" % m)
    # momento em que a configuração entrou (evento 12)
    t_cfg = None
    evs = []
    for m in linhas:
        if m.get("t") == "ev":
            e = m["e"]
            if e[2] == 12 and t_cfg is None:
                t_cfg = e[0]
            if e[2] in (1, 2) and e[3] == 0 and 0 <= e[1] <= 3:
                evs.append((e[0], e[1], 1 if e[2] == 1 else 0))
    if t_cfg is None:
        return (i, ["configuração não entrou (sem evento 12)"], 0, cfg, ep0)
    t_fim = ep0 + seg  # aproximado; ignora os últimos segundos
    # esperado: estado no momento do cfg (se ligado, liga logo) e cada virada de minuto depois
    esperado = []
    for s in range(4):
        atual = ref.programa_ativo(regras[s], t_cfg + tz * 60)
        if atual:
            esperado.append((t_cfg, s, 1))
        t = (t_cfg // 60 + 1) * 60
        while t < t_fim - 10:
            e = ref.programa_ativo(regras[s], t + tz * 60)
            if e != atual:
                esperado.append((t, s, 1 if e else 0))
                atual = e
            t += 60
    evs = [x for x in evs if x[0] < t_fim - 10 + FOLGA]
    for s in range(4):
        a = [x for x in esperado if x[1] == s]
        b = [x for x in evs if x[1] == s]
        n = min(len(a), len(b))
        for k in range(n):
            if a[k][2] != b[k][2] or not (0 <= b[k][0] - a[k][0] <= FOLGA):
                problemas.append("saída %d: %dª mudança esperada %s, firmware fez %s" % (s, k + 1, a[k], b[k]))
                break
        else:
            if len(a) != len(b):
                extra = a[n] if len(a) > n else b[n]
                problemas.append("saída %d: esperadas %d mudanças, firmware fez %d (primeira sobrando: %s)"
                                 % (s, len(a), len(b), extra))
    return (i, problemas, len(esperado), cfg, ep0)


def main():
    os.makedirs(SAI, exist_ok=True)
    with Pool() as pool:
        res = pool.map(cenario, range(N))
    ruins = 0
    total = 0
    for i, probs, n, cfg, ep0 in res:
        total += n
        if probs:
            ruins += 1
            print("cenário %d (ep0=%d tz=%d): %s" % (i, ep0, cfg["tz"], "; ".join(probs[:3])))
            print("   cfg=%s" % json.dumps(cfg, ensure_ascii=False))
    print("integração: %d cenários × %.1f dia(s), %d mudanças conferidas, %d cenário(s) com diferença"
          % (N, DIAS, total, ruins))
    sys.exit(1 if ruins else 0)


if __name__ == "__main__":
    main()
