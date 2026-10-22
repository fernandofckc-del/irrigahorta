# Referência das contas de agenda, escrita direto do PROTOCOLO §3–§4.
# Não olha o agenda.h nem o agenda.js: é a "verdade" do teste diferencial.
# Python usa divisão inteira com piso (//) e resto sempre positivo (%),
# que é exatamente o floor e o mod da especificação.

DIA = 86400


def dia_semana(D):
    # §3: wd(D) = ((D + 4) mod 7 + 7) mod 7  (0 = domingo)
    return ((D + 4) % 7 + 7) % 7


def dia_marcado(w, D):
    # §3: bit 0 = domingo … bit 6 = sábado
    return ((w >> dia_semana(D)) & 1) == 1


def regra_ativa(r, L):
    # §4.3: en = 0 ou w = 0 nunca fica ativa
    if not r["en"] or r["w"] == 0:
        return False
    D = int(L // DIA)  # floor (int() para aceitar L com casas decimais)
    for k in (0, 1):
        Dk = D - k
        if not dia_marcado(r["w"], Dk):
            continue
        if r["k"] == "f":
            # §4.1
            ini = Dk * DIA + r["h"] * 60
            if ini <= L < ini + r["d"] * 60:
                return True
        elif r["k"] == "c":
            # §4.2
            tam = (r["b"] - r["a"] + 1440) % 1440
            if tam == 0:
                tam = 1440
            W = Dk * DIA + r["a"] * 60
            if W <= L < W + tam * 60:
                if r["off"] == 0 or (L - W) % ((r["on"] + r["off"]) * 60) < r["on"] * 60:
                    return True
    return False


def programa_ativo(regras, L):
    # §4: ligada se qualquer regra habilitada estiver ativa
    return any(regra_ativa(r, L) for r in regras)


def proxima_mudanca(regras, ep, tz, max_min=8 * 1440):
    # §4.3: primeiro minuto (> ep, alinhado ao minuto) em que o estado muda.
    # Busca minuto a minuto, no máximo max_min minutos.
    atual = programa_ativo(regras, ep + tz * 60)
    t = (int(ep // 60) + 1) * 60
    for _ in range(max_min):
        e = programa_ativo(regras, t + tz * 60)
        if e != atual:
            return (t, e)
        t += 60
    return None


def blocos_do_dia(regras, D):
    # §4.3: intervalos ligados dentro do dia local D, em minutos 0–1440, fim exclusivo
    blocos = []
    ini = None
    for m in range(1440):
        on = programa_ativo(regras, D * DIA + m * 60)
        if on and ini is None:
            ini = m
        elif not on and ini is not None:
            blocos.append((ini, m))
            ini = None
    if ini is not None:
        blocos.append((ini, 1440))
    return blocos
