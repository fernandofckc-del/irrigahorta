// Driver C++ do teste diferencial: lê casos.txt (stdin) e responde usando o agenda.h do firmware.
// Formato das linhas: ver gera.py.
#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "agenda.h"

static bool leRegras(std::istringstream& in, std::vector<agenda::Regra>& rs) {
  int n = 0;
  if (!(in >> n)) return false;
  rs.clear();
  for (int i = 0; i < n; i++) {
    long long k, en, w, p1, p2, p3, p4;
    if (!(in >> k >> en >> w >> p1 >> p2 >> p3 >> p4)) return false;
    agenda::Regra r;
    r.w = static_cast<int>(w);
    r.en = en != 0;
    if (k == 0) {
      r.k = 'f';
      r.h = static_cast<int>(p1);
      r.d = static_cast<int>(p2);
    } else {
      r.k = 'c';
      r.a = static_cast<int>(p1);
      r.b = static_cast<int>(p2);
      r.on = static_cast<int>(p3);
      r.off = static_cast<int>(p4);
    }
    rs.push_back(r);
  }
  return true;
}

int main() {
  std::ios::sync_with_stdio(false);
  std::string linha;
  std::string saida;
  std::vector<agenda::Regra> rs;
  while (std::getline(std::cin, linha)) {
    std::istringstream in(linha);
    std::string tipo;
    in >> tipo;
    if (!leRegras(in, rs)) {
      saida += "ERRO\n";
      continue;
    }
    const agenda::Regra* p = rs.empty() ? nullptr : rs.data();
    const int n = static_cast<int>(rs.size());
    if (tipo == "R") {
      long long L;
      in >> L;
      for (int i = 0; i < n; i++) saida += agenda::regraAtiva(rs[i], L) ? '1' : '0';
      saida += ' ';
      saida += agenda::programaAtivo(p, n, L) ? '1' : '0';
    } else if (tipo == "P") {
      long long ep, tz, mx;
      in >> ep >> tz >> mx;
      int64_t epM = -1;
      bool onM = false;
      const bool achou = mx < 0 ? agenda::proximaMudanca(p, n, ep, static_cast<int>(tz), epM, onM)
                                : agenda::proximaMudanca(p, n, ep, static_cast<int>(tz), epM, onM,
                                                         static_cast<int>(mx));
      if (achou) saida += std::to_string(epM) + (onM ? " 1" : " 0");
      else saida += "null";
    } else if (tipo == "B") {
      long long D;
      in >> D;
      const auto bl = agenda::blocosDoDia(p, n, D);
      if (bl.empty()) saida += "-";
      for (size_t i = 0; i < bl.size(); i++) {
        if (i) saida += ',';
        saida += std::to_string(bl[i].first) + "-" + std::to_string(bl[i].second);
      }
    } else {
      saida += "skip";  // Q = ep com casas decimais: o firmware só usa segundos inteiros
    }
    saida += '\n';
    if (saida.size() > (1 << 20)) {
      std::fwrite(saida.data(), 1, saida.size(), stdout);
      saida.clear();
    }
  }
  std::fwrite(saida.data(), 1, saida.size(), stdout);
  return 0;
}
