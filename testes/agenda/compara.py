#!/usr/bin/env python3
# Compara a resposta esperada (referência Python = a especificação) com o C++ e o JS.
# Uso: compara.py <pasta>   (lê casos.txt, esperado.txt, cpp.txt, js.txt)
# Sai com código 1 se houver qualquer diferença.
import os
import sys
from collections import Counter, defaultdict

pasta = sys.argv[1]


def le(nome):
    with open(os.path.join(pasta, nome)) as f:
        return f.read().split("\n")[:-1]


casos = le("casos.txt")
esp = le("esperado.txt")
impl = {"C++ (agenda.h)": le("cpp.txt"), "JS (agenda.js)": le("js.txt")}
for nome, v in impl.items():
    if len(v) != len(casos):
        print("ERRO: %s respondeu %d linhas para %d casos" % (nome, len(v), len(casos)))
        sys.exit(1)

total = Counter(c[0] for c in casos)
erros = defaultdict(list)
for i, c in enumerate(casos):
    t = c[0]
    for nome, v in impl.items():
        got = v[i]
        if got == "skip" and t == "Q" and nome.startswith("C++"):
            continue  # Q = ep com casas decimais: só o JS recebe isso
        if got != esp[i]:
            erros[(nome, t)].append(i)

NOMES = {"R": "regraAtiva/programaAtivo", "P": "proximaMudanca", "Q": "proximaMudanca (ep quebrado)", "B": "blocosDoDia"}
print("casos por tipo: " + ", ".join("%s=%d" % (NOMES[k], total[k]) for k in sorted(total)))
print("total de casos: %d" % len(casos))
# cobertura: quantos casos dão ligado/desligado, quantos param no limite da busca etc.
ligR = sum(1 for c, e in zip(casos, esp) if c[0] == "R" and e.endswith(" 1"))
nulP = sum(1 for c, e in zip(casos, esp) if c[0] in "PQ" and e == "null")
vazB = sum(1 for c, e in zip(casos, esp) if c[0] == "B" and e == "-")
print("cobertura: R ligado=%d desligado=%d · P/Q null=%d · B dia vazio=%d" % (ligR, total["R"] - ligR, nulP, vazB))


def regra_txt(p, j):
    k, en, w, p1, p2, p3, p4 = p[j:j + 7]
    if k == "0":
        return '{"k":"f","h":%s,"d":%s,"w":%s,"en":%s}' % (p1, p2, w, en)
    return '{"k":"c","a":%s,"b":%s,"on":%s,"off":%s,"w":%s,"en":%s}' % (p1, p2, p3, p4, w, en)


def mostra(i, nome):
    p = casos[i].split(" ")
    n = int(p[1])
    regras = [regra_txt(p, 2 + 7 * j) for j in range(n)]
    resto = p[2 + 7 * n:]
    got = impl[nome][i]
    e = esp[i]
    if p[0] == "R":
        # caso mínimo: a regra (sozinha) em que as duas respostas discordam
        L = resto[0]
        for j in range(n):
            if j < len(got) and got[j] != e[j]:
                return "    L=%s regra=%s → esperado %s, %s deu %s" % (L, regras[j], e[j], nome, got[j])
        return "    L=%s regras=[%s] → esperado %s, deu %s" % (L, ",".join(regras), e, got)
    return "    %s regras=[%s] args=%s → esperado %s, deu %s" % (p[0], ",".join(regras), " ".join(resto), e, got)


falhou = False
for nome in impl:
    for t in sorted(total):
        lst = erros.get((nome, t), [])
        if t == "Q" and nome.startswith("C++"):
            continue
        print("%-15s %-30s %7d/%-7d %s" % (nome, NOMES[t], total[t] - len(lst), total[t], "ok" if not lst else "DIFERENTE: %d" % len(lst)))
        if lst:
            falhou = True
            # os menores casos primeiro (menos regras)
            lst = sorted(lst, key=lambda i: (int(casos[i].split(" ")[1]), len(casos[i])))
            for i in lst[:5]:
                print(mostra(i, nome))
sys.exit(1 if falhou else 0)
