#!/usr/bin/env python3
"""Gera os ícones do Irriga Horta (gota d'água com broto) com o Pillow.

Uso: python3 testes/gera-icones.py
Grava icon-192.png, icon-512.png e icon-maskable-512.png na raiz do repositório.
"""
import math
import os

from PIL import Image, ImageChops, ImageDraw

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FUNDO = (11, 93, 115)        # azul-petróleo da marca (#0b5d73)
FUNDO_ESCURO = (8, 66, 82)   # faixa de baixo (água)
GOTA = (255, 255, 255)
BROTO = (11, 93, 115)

ESCALA = 4  # desenha grande e reduz (bordas lisas)


def pontos_gota(cx, cy, r, ponta_y, passos=120):
    """Contorno de uma gota: círculo embaixo e ponta em cima."""
    d = cy - ponta_y                    # distância da ponta ao centro
    ang = math.asin(r / d)              # ângulo da tangente
    # pontos de tangência no círculo
    inicio = -math.pi / 2 + (math.pi / 2 - ang)
    fim = -math.pi / 2 - (math.pi / 2 - ang) + 2 * math.pi
    pts = [(cx, ponta_y)]
    for i in range(passos + 1):
        a = inicio + (fim - inicio) * i / passos
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def desenha(tam, mascaravel):
    T = tam * ESCALA
    img = Image.new('RGBA', (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if mascaravel:
        d.rectangle([0, 0, T, T], fill=FUNDO)
        conteudo = 0.62   # cabe no círculo seguro (80%)
    else:
        raio = int(T * 0.22)
        d.rounded_rectangle([0, 0, T - 1, T - 1], radius=raio, fill=FUNDO)
        conteudo = 0.78

    # faixa de água embaixo, recortada pela forma do fundo
    faixa = Image.new('RGBA', (T, T), (0, 0, 0, 0))
    fd = ImageDraw.Draw(faixa)
    onda_y = T * (0.5 + conteudo * 0.36)
    pts = [(0, T)]
    for i in range(0, 101):
        x = T * i / 100
        y = onda_y + math.sin(i / 100 * math.pi * 2) * T * 0.018
        pts.append((x, y))
    pts.append((T, T))
    fd.polygon(pts, fill=FUNDO_ESCURO)
    # só onde existe fundo (respeita os cantos arredondados)
    alfa = ImageChops.multiply(faixa.split()[3], img.split()[3])
    img.paste(faixa, (0, 0), alfa)

    d = ImageDraw.Draw(img)
    c = T / 2
    alt = T * conteudo            # altura total da gota
    r = alt * 0.34
    ponta_y = c - alt / 2
    cy = c + alt / 2 - r
    d.polygon(pontos_gota(c, cy, r, ponta_y), fill=GOTA)

    # broto dentro da gota: caule + duas folhas
    # broto grande e grosso: precisa ser reconhecível com 48 px na tela do celular
    larg = max(2, int(r * 0.20))
    base_y = cy + r * 0.66
    topo_y = cy - r * 0.10
    d.line([(c, base_y), (c, topo_y)], fill=BROTO, width=larg)
    d.ellipse([c - larg / 2, base_y - larg / 2, c + larg / 2, base_y + larg / 2], fill=BROTO)

    def folha(px, py, ang_graus, comp, larg_f):
        """Folha em forma de lente, presa em (px, py), apontando no ângulo dado."""
        a = math.radians(ang_graus)
        ux, uy = math.cos(a), -math.sin(a)      # direção da folha (y da tela é para baixo)
        nx, ny = -uy, ux                        # normal
        pts = []
        n = 40
        for i in range(n + 1):
            t = i / n
            e = larg_f * math.sin(math.pi * t) ** 0.8
            pts.append((px + ux * comp * t + nx * e, py + uy * comp * t + ny * e))
        for i in range(n, -1, -1):
            t = i / n
            e = larg_f * math.sin(math.pi * t) ** 0.8
            pts.append((px + ux * comp * t - nx * e, py + uy * comp * t - ny * e))
        d.polygon(pts, fill=BROTO)

    folha(c, topo_y + r * 0.30, 152, r * 0.70, r * 0.27)
    folha(c, topo_y + r * 0.06, 28, r * 0.74, r * 0.27)
    d.ellipse([c - larg / 2, topo_y - larg / 2, c + larg / 2, topo_y + larg / 2], fill=BROTO)

    return img.resize((tam, tam), Image.LANCZOS)


def main():
    desenha(192, False).save(os.path.join(RAIZ, 'icon-192.png'), optimize=True)
    desenha(512, False).save(os.path.join(RAIZ, 'icon-512.png'), optimize=True)
    m = desenha(512, True)
    # ícone mascarável não pode ter transparência
    fundo = Image.new('RGB', m.size, FUNDO)
    fundo.paste(m, (0, 0), m)
    fundo.save(os.path.join(RAIZ, 'icon-maskable-512.png'), optimize=True)
    print('ícones gravados em', RAIZ)


if __name__ == '__main__':
    main()
