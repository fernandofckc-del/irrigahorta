#!/usr/bin/env python3
# Teste do teste: estraga de propósito uma coisa de cada vez no agenda.h / agenda.js
# (um "mutante") e confere que o testa.sh percebe (tem que FALHAR em todos).
# Uso: testes/agenda/mutantes.py [números dos mutantes]   (usa menos casos que o teste normal; ~3 min)
import os
import shutil
import subprocess
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.abspath(os.path.join(AQUI, "..", ".."))
SAI = os.path.join(RAIZ, "testes", ".saida", "agenda-mutantes")
H = os.path.join(RAIZ, "firmware", "ControladorRega", "agenda.h")
JS = os.path.join(RAIZ, "agenda.js")

# (arquivo, texto original, texto estragado, o que o mutante simula)
MUTANTES = [
    (H, "((D + 4) % 7 + 7) % 7", "((D + 3) % 7 + 7) % 7", "dia da semana errado"),
    (H, "for (int k = 0; k <= 1; k++)", "for (int k = 0; k <= 0; k++)", "esquece o horário que passa da meia-noite"),
    (H, "L < ini + static_cast<int64_t>(r.d) * 60", "L <= ini + static_cast<int64_t>(r.d) * 60", "fixo: fim inclusivo"),
    (H, "if (len == 0) len = MIN_DIA;", "", "ciclo: b == a vira janela vazia"),
    (H, "% periodo < static_cast<int64_t>(r.on) * 60", "% periodo <= static_cast<int64_t>(r.on) * 60", "ciclo: 1 s a mais ligado"),
    (H, "for (int m = 0; m < maxMin; m++)", "for (int m = 0; m <= maxMin; m++)", "busca 1 minuto além do limite"),
    (H, "for (int m = 0; m <= MIN_DIA; m++)", "for (int m = 0; m < MIN_DIA; m++)", "blocos: perde o bloco que vai até 24:00"),
    (H, "const int64_t D = divChao(L, SEG_DIA);", "const int64_t D = L / SEG_DIA;", "dia com divisão truncada (L negativo)"),
    (JS, "for (; t <= limite; t += 60)", "for (; t < limite; t += 60)", "busca 1 minuto a menos"),
    (JS, "var t = Math.floor(ep / 60) * 60 + 60;", "var t = Math.round(ep / 60) * 60 + 60;", "pula o 1º minuto quando ep está no fim do minuto"),
    (JS, "return Math.floor(L / DIA);", "return Math.trunc(L / DIA);", "dia truncado (L negativo)"),
    (JS, "if (ini >= 0) blocos.push([ini, 1440]);", "", "blocos: perde o bloco que vai até 24:00"),
    (JS, "if (len === 0) len = 1440;", "", "ciclo: b == a vira janela vazia"),
    (JS, "var len = (((b - a) % 1440) + 1440) % 1440;", "var len = (b - a + 1440) % 1440 - (b < a ? 1 : 0);", "janela 1 min menor quando passa da meia-noite"),
    (JS, "if ((L - W) % periodo < on * 60) return true;", "if ((L - W) % periodo < off * 60) return true;", "ciclo: troca ligado e desligado"),
    (H, "const int64_t primeiro = (divChao(ep, 60) + 1) * 60;", "const int64_t primeiro = divChao(ep, 60) * 60 + 120;", "pula o 1º minuto da busca"),
]

# mutantes que não mudam o resultado (nenhum aqui; se houver, é esperado que passem)
EQUIVALENTES = set()


def main():
    os.makedirs(SAI, exist_ok=True)
    pegos = 0
    ruins = []
    so = {int(x) for x in sys.argv[1:]}  # opcional: só estes números
    for i, (arq, de, para, nome) in enumerate(MUTANTES):
        if so and i not in so:
            continue
        src = open(arq).read()
        if src.count(de) != 1:
            print("?? mutante %d (%s): texto não achado (o arquivo mudou?)" % (i, nome))
            ruins.append(nome)
            continue
        pasta = os.path.join(SAI, "m%02d" % i)
        os.makedirs(pasta, exist_ok=True)
        env = dict(os.environ, SAIDA_AGENDA=pasta, PYTHONDONTWRITEBYTECODE="1")
        if arq == H:
            shutil.copy(H, os.path.join(pasta, "agenda.h"))
            open(os.path.join(pasta, "agenda.h"), "w").write(src.replace(de, para))
            env["AGENDA_H_DIR"] = pasta
        else:
            mjs = os.path.join(pasta, "agenda.js")
            open(mjs, "w").write(src.replace(de, para))
            env["AGENDA_JS"] = mjs
        r = subprocess.run(["sh", os.path.join(AQUI, "testa.sh"), "7", "40000", "4000", "1500"],
                           env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        pego = r.returncode != 0
        equiv = nome in EQUIVALENTES
        if pego:
            pegos += 1
        ok = pego != equiv
        print("%s mutante %2d %-4s %-60s %s" % ("ok" if ok else "XX", i, "h" if arq == H else "js", nome,
                                                "pego" if pego else "passou"))
        if not ok:
            ruins.append(nome)
    rodados = len(so) if so else len(MUTANTES)
    print("mutantes pegos: %d de %d" % (pegos, rodados))
    sys.exit(1 if ruins else 0)


if __name__ == "__main__":
    main()
