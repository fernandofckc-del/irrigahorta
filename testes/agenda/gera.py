#!/usr/bin/env python3
# Gera os casos do teste diferencial da agenda (semente fixa) e a resposta esperada,
# calculada pela referência em Python (referencia.py, escrita direto do PROTOCOLO §3–§4).
#
# Uso: gera.py <pasta de saída> [semente] [nR] [nP] [nB]
#
# Formato de cada linha de casos.txt (números separados por espaço):
#   regra = k en w p1 p2 p3 p4   (k: 0 = fixo "f" [p1=h p2=d], 1 = ciclo "c" [p1=a p2=b p3=on p4=off])
#   R n regra*n L            → regraAtiva de cada regra + programaAtivo em L
#   P n regra*n ep tz maxMin → proximaMudanca (maxMin = -1: usa o padrão)
#   B n regra*n D            → blocosDoDia
#   Q n regra*n ep tz maxMin → proximaMudanca com ep quebrado (só JS; ep com casas decimais)
# Saída de cada linha (esperado.txt e saídas dos programas):
#   R: bits das regras, espaço, bit do programa   ex.: "010 1"
#   P/Q: "<ep> <on>" ou "null"                    ex.: "1792584060 1"
#   B: "ini-fim,ini-fim" ou "-"
import os
import random
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import referencia as ref  # noqa: E402

DIA = 86400


def sorteia_w(rnd):
    x = rnd.random()
    if x < 0.12:
        return 0
    if x < 0.22:
        return 1
    if x < 0.32:
        return 64
    if x < 0.55:
        return 127
    if x < 0.70:
        return 1 << rnd.randrange(7)
    if x < 0.80:
        return 127 & ~(1 << rnd.randrange(7))
    return rnd.randrange(128)


def sorteia_min_dia(rnd):
    x = rnd.random()
    if x < 0.15:
        return 0
    if x < 0.30:
        return 1439
    if x < 0.36:
        return 1
    if x < 0.42:
        return 1438
    if x < 0.47:
        return 720
    return rnd.randrange(1440)


def sorteia_regra(rnd):
    en = 1 if rnd.random() < 0.9 else 0
    w = sorteia_w(rnd)
    if rnd.random() < 0.5:
        h = sorteia_min_dia(rnd)
        x = rnd.random()
        if x < 0.15:
            d = 1
        elif x < 0.30:
            d = 1440
        elif x < 0.36:
            d = 2
        elif x < 0.42:
            d = 1439
        elif x < 0.52:
            d = max(1, min(1440, 1440 - h + rnd.choice((-1, 0, 1))))  # termina na meia-noite ±1
        elif x < 0.70:
            d = rnd.randint(1, 120)
        else:
            d = rnd.randint(1, 1440)
        return {"k": "f", "en": en, "w": w, "h": h, "d": d}
    a = sorteia_min_dia(rnd)
    x = rnd.random()
    if x < 0.15:
        b = a
    elif x < 0.25:
        b = (a + 1) % 1440
    elif x < 0.35:
        b = (a - 1) % 1440
    elif x < 0.45:
        b = 0
    elif x < 0.52:
        b = 1439
    elif x < 0.65:
        b = rnd.randrange(0, a + 1)  # b <= a: passa da meia-noite
    else:
        b = rnd.randrange(1440)
    x = rnd.random()
    if x < 0.15:
        on = 1
    elif x < 0.25:
        on = 1440
    elif x < 0.30:
        on = 1439
    elif x < 0.60:
        on = rnd.randint(1, 30)
    else:
        on = rnd.randint(1, 1440)
    x = rnd.random()
    if x < 0.25:
        off = 0
    elif x < 0.32:
        off = 1440
    elif x < 0.40:
        off = 1
    elif x < 0.70:
        off = rnd.randint(1, 60)
    else:
        off = rnd.randint(0, 1440)
    return {"k": "c", "en": en, "w": w, "a": a, "b": b, "on": on, "off": off}


def sorteia_regras(rnd):
    x = rnd.random()
    if x < 0.55:
        n = 1
    elif x < 0.80:
        n = 2
    elif x < 0.90:
        n = 3
    elif x < 0.97:
        n = rnd.randint(4, 8)
    else:
        n = 0
    return [sorteia_regra(rnd) for _ in range(n)]


def sorteia_dia_base(rnd):
    # dias locais em várias semanas, com hora válida (ep >= 1700000000)
    x = rnd.random()
    if x < 0.80:
        return rnd.randint(1700000000 // DIA, 2100000000 // DIA)
    if x < 0.90:
        return rnd.randint(19670, 19690)  # poucas semanas: muitos dias da semana repetidos
    if x < 0.98:
        return rnd.randint(2100000000 // DIA, 4300000000 // DIA)  # passa de 2^31 e 2^32
    return rnd.randint(-1000000, 1000000)  # ±2700 anos: L até ~10^11 (int64 no C++, precisão no JS)


def pontos_da_regra(r, D):
    # instantes locais onde a regra muda (para enviesar L)
    pts = []
    for Dk in (D - 1, D, D + 1):
        base = Dk * DIA
        if r["k"] == "f":
            pts += [base + r["h"] * 60, base + (r["h"] + r["d"]) * 60]
        else:
            tam = (r["b"] - r["a"] + 1440) % 1440 or 1440
            W = base + r["a"] * 60
            pts += [W, W + tam * 60]
            per = r["on"] + r["off"]
            if r["off"] > 0:
                nmax = max(0, tam // per)
                for n in {0, 1, 2, nmax - 1, nmax, nmax + 1}:
                    if n >= 0:
                        pts += [W + n * per * 60, W + (n * per + r["on"]) * 60]
        pts += [base]
    return pts


DESLOCS = (0, 0, 0, 1, -1, 1, -1, 59, -59, 60, -60, 61, -61)


def sorteia_L(rnd, regras):
    D = sorteia_dia_base(rnd)
    x = rnd.random()
    if x < 0.04:
        return rnd.randint(-40 * DIA, 40 * DIA)  # L perto de 0 ou negativo (robustez)
    if x < 0.15 or not regras:
        return D * DIA + rnd.choice(DESLOCS) + rnd.choice((0, 0, rnd.randrange(DIA)))
    if x < 0.30:
        return D * DIA + rnd.randrange(DIA)
    r = rnd.choice(regras)
    pts = pontos_da_regra(r, D)
    return rnd.choice(pts) + rnd.choice(DESLOCS)


def sorteia_tz(rnd):
    x = rnd.random()
    if x < 0.15:
        return -720
    if x < 0.30:
        return 840
    if x < 0.40:
        return 0
    if x < 0.60:
        return -180
    return rnd.randint(-720, 840)


def fmt_regras(regras):
    p = [str(len(regras))]
    for r in regras:
        if r["k"] == "f":
            p += ["0", str(r["en"]), str(r["w"]), str(r["h"]), str(r["d"]), "0", "0"]
        else:
            p += ["1", str(r["en"]), str(r["w"]), str(r["a"]), str(r["b"]), str(r["on"]), str(r["off"])]
    return " ".join(p)


def esperado(caso):
    tipo = caso[0]
    if tipo == "R":
        _, regras, L = caso
        bits = "".join("1" if ref.regra_ativa(r, L) else "0" for r in regras)
        return bits + " " + ("1" if ref.programa_ativo(regras, L) else "0")
    if tipo in ("P", "Q"):
        _, regras, ep, tz, mx = caso
        res = ref.proxima_mudanca(regras, ep, tz) if mx < 0 else ref.proxima_mudanca(regras, ep, tz, mx)
        if res is None:
            return "null"
        t, on = res
        return "%d %d" % (int(t), 1 if on else 0)
    if tipo == "B":
        _, regras, D = caso
        bl = ref.blocos_do_dia(regras, D)
        return ",".join("%d-%d" % b for b in bl) if bl else "-"
    raise ValueError(tipo)


def linha(caso):
    tipo = caso[0]
    if tipo == "R":
        return "R %s %d" % (fmt_regras(caso[1]), caso[2])
    if tipo == "P":
        return "P %s %d %d %d" % (fmt_regras(caso[1]), caso[2], caso[3], caso[4])
    if tipo == "Q":
        return "Q %s %.3f %d %d" % (fmt_regras(caso[1]), caso[2], caso[3], caso[4])
    return "B %s %d" % (fmt_regras(caso[1]), caso[2])


def regras_sem_mudanca(rnd):
    # programas que nunca mudam (sempre ligado ou sempre desligado) → null
    x = rnd.random()
    if x < 0.3:
        return [{"k": "f", "en": 1, "w": 127, "h": rnd.randrange(1440), "d": 1440}]
    if x < 0.6:
        return [{"k": "c", "en": 1, "w": 127, "a": (a := rnd.randrange(1440)), "b": a, "on": rnd.randint(1, 1440), "off": 0}]
    if x < 0.8:
        return [{"k": "f", "en": 1, "w": 0, "h": rnd.randrange(1440), "d": rnd.randint(1, 1440)}]
    return []


def gera_P(rnd):
    regras = sorteia_regras(rnd) if rnd.random() < 0.93 else regras_sem_mudanca(rnd)
    tz = sorteia_tz(rnd)
    L = sorteia_L(rnd, regras)
    if L < 1700000000:  # proximaMudanca só é usada com hora válida
        L = sorteia_dia_base(rnd) * DIA + rnd.randrange(DIA)
    ep = L - tz * 60
    x = rnd.random()
    if x < 0.65:
        mx = -1
    elif x < 0.85:
        # maxMin colado na primeira mudança (testa o limite exato da busca)
        r0 = ref.proxima_mudanca(regras, ep, tz, 3 * 1440)
        if r0 is None:
            mx = rnd.randint(1, 3 * 1440)
        else:
            idx = (r0[0] - ((ep // 60) + 1) * 60) // 60 + 1  # a mudança é o idx-ésimo minuto testado
            mx = max(1, idx + rnd.choice((-1, 0, 0, 1)))
    else:
        mx = rnd.choice((1, 2, rnd.randint(1, 3000)))
    return ("P", regras, ep, tz, mx)


def gera_Q(rnd):
    c = gera_P(rnd)
    ep = c[2] + rnd.choice((0.001, 0.5, 0.999, round(0.001 + 0.998 * rnd.random(), 3)))
    return ("Q", c[1], ep, c[3], c[4])


def gera_B(rnd):
    regras = sorteia_regras(rnd)
    x = rnd.random()
    if x < 0.85:
        D = sorteia_dia_base(rnd)
    else:
        D = rnd.randint(-30, 30)
    return ("B", regras, D)


def main():
    saida = sys.argv[1]
    semente = int(sys.argv[2]) if len(sys.argv) > 2 else 20261022
    nR = int(sys.argv[3]) if len(sys.argv) > 3 else 320000
    nP = int(sys.argv[4]) if len(sys.argv) > 4 else 20000
    nB = int(sys.argv[5]) if len(sys.argv) > 5 else 8000
    nQ = max(1, nP // 10)
    rnd = random.Random(semente)
    casos = []
    for _ in range(nR):
        regras = sorteia_regras(rnd)
        casos.append(("R", regras, sorteia_L(rnd, regras)))
    for _ in range(nP):
        casos.append(gera_P(rnd))
    for _ in range(nQ):
        casos.append(gera_Q(rnd))
    for _ in range(nB):
        casos.append(gera_B(rnd))
    os.makedirs(saida, exist_ok=True)
    with Pool() as pool:
        esp = pool.map(esperado, casos, chunksize=500)
    with open(os.path.join(saida, "casos.txt"), "w") as f:
        for c in casos:
            f.write(linha(c) + "\n")
    with open(os.path.join(saida, "esperado.txt"), "w") as f:
        for e in esp:
            f.write(e + "\n")
    print("casos: R=%d P=%d Q=%d B=%d total=%d (semente %d)" % (nR, nP, nQ, nB, len(casos), semente))


if __name__ == "__main__":
    main()
