// agenda.h — contas das regras de programação (PROTOCOLO.md §3 e §4).
// C++ puro, sem nada do Arduino: o mesmo arquivo é usado no ESP32 e no teste do PC.
// É a mesma conta do app (agenda.js). Se mudar aqui, mude lá também.
#pragma once

#include <cstdint>
#include <utility>
#include <vector>

namespace agenda {

constexpr int64_t SEG_DIA = 86400;
constexpr int MIN_DIA = 1440;

// Divisão que arredonda para baixo (funciona com números negativos).
inline int64_t divChao(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
  return q;
}

// Dia da semana do dia D (dias desde 1/1/1970): 0 = domingo ... 6 = sábado.
inline int wd(int64_t D) {
  return static_cast<int>(((D + 4) % 7 + 7) % 7);
}

// Uma regra. k = 'f' (horário fixo) ou 'c' (ciclo).
struct Regra {
  char k = 'f';
  int h = 0;     // fixo: início (minuto do dia)
  int d = 1;     // fixo: duração (min)
  int a = 0;     // ciclo: começo da janela (minuto do dia)
  int b = 0;     // ciclo: fim da janela (minuto do dia)
  int on = 1;    // ciclo: minutos ligado
  int off = 0;   // ciclo: minutos desligado (0 = ligado direto)
  int w = 127;   // dias da semana (bit 0 = domingo)
  bool en = true;
};

// A regra está ativa na hora local L (segundos)?
inline bool regraAtiva(const Regra& r, int64_t L) {
  if (!r.en || (r.w & 127) == 0) return false;
  const int64_t D = divChao(L, SEG_DIA);
  for (int k = 0; k <= 1; k++) {
    const int64_t Dk = D - k;  // o dia que conta é o dia em que começou
    if (((r.w >> wd(Dk)) & 1) == 0) continue;
    if (r.k == 'f') {
      const int64_t ini = Dk * SEG_DIA + static_cast<int64_t>(r.h) * 60;
      if (L >= ini && L < ini + static_cast<int64_t>(r.d) * 60) return true;
    } else if (r.k == 'c') {
      const int64_t W = Dk * SEG_DIA + static_cast<int64_t>(r.a) * 60;
      int64_t len = ((r.b - r.a) % MIN_DIA + MIN_DIA) % MIN_DIA;
      if (len == 0) len = MIN_DIA;
      if (L >= W && L < W + len * 60) {
        if (r.off == 0) return true;
        const int64_t periodo = static_cast<int64_t>(r.on + r.off) * 60;
        if ((L - W) % periodo < static_cast<int64_t>(r.on) * 60) return true;
      }
    }
  }
  return false;
}

// O programa (lista de regras) está ligado na hora local L?
inline bool programaAtivo(const Regra* regras, int n, int64_t L) {
  for (int i = 0; i < n; i++) {
    if (regraAtiva(regras[i], L)) return true;
  }
  return false;
}

// Primeiro minuto depois de ep (UTC) em que o programa muda de estado.
// Devolve false se não muda dentro de maxMin minutos.
inline bool proximaMudanca(const Regra* regras, int n, int64_t ep, int tz,
                           int64_t& epMudanca, bool& onNovo,
                           int maxMin = 8 * MIN_DIA) {
  const int64_t desloc = static_cast<int64_t>(tz) * 60;
  const bool atual = programaAtivo(regras, n, ep + desloc);
  const int64_t primeiro = (divChao(ep, 60) + 1) * 60;
  for (int m = 0; m < maxMin; m++) {
    const int64_t t = primeiro + static_cast<int64_t>(m) * 60;
    const bool on = programaAtivo(regras, n, t + desloc);
    if (on != atual) {
      epMudanca = t;
      onNovo = on;
      return true;
    }
  }
  return false;
}

// Intervalos ligados dentro do dia local D: pares [início, fim) em minutos (0..1440).
inline std::vector<std::pair<int, int>> blocosDoDia(const Regra* regras, int n,
                                                    int64_t D) {
  std::vector<std::pair<int, int>> blocos;
  int inicio = -1;
  for (int m = 0; m <= MIN_DIA; m++) {
    const bool on = (m < MIN_DIA) &&
                    programaAtivo(regras, n, D * SEG_DIA + static_cast<int64_t>(m) * 60);
    if (on && inicio < 0) inicio = m;
    if (!on && inicio >= 0) {
      blocos.push_back(std::make_pair(inicio, m));
      inicio = -1;
    }
  }
  return blocos;
}

}  // namespace agenda
