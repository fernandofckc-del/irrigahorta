// relogio.h — contas do relógio DS3231 (PROTOCOLO.md §3): datas, BCD, século,
// modo 12 h e o bit OSF. C++ puro, sem nada do Arduino: o .ino só lê e grava os
// registradores pelo I²C, e estas contas são testadas no PC (testes/nativo).
#pragma once

#include <cstdint>

#include "agenda.h"

namespace relogio {

// Registradores do DS3231 que usamos
constexpr uint8_t REG_HORA = 0x00;      // 0x00..0x06: segundo, minuto, hora, dia da semana, dia, mês, ano
constexpr uint8_t REG_CONTROLE = 0x0E;  // bit 7 (EOSC) = 1: o relógio para quando está só na bateria
constexpr uint8_t REG_STATUS = 0x0F;    // bit 7 (OSF) = 1: o relógio parou em algum momento
constexpr uint8_t BIT_EOSC = 0x80;
constexpr uint8_t BIT_OSF = 0x80;
constexpr uint8_t BIT_SECULO = 0x80;    // no registrador do mês
constexpr uint8_t BIT_12H = 0x40;       // no registrador da hora: 1 = modo 12 h
constexpr uint8_t BIT_PM = 0x20;        // no modo 12 h: 1 = depois do meio-dia

// OSF ligado = a hora guardada no DS3231 não vale.
inline bool osfLigado(uint8_t status) { return (status & BIT_OSF) != 0; }

// BCD: cada metade do byte é um algarismo (0x59 = 59).
inline bool bcdValido(uint8_t b) { return (b & 0x0F) <= 9 && (b >> 4) <= 9; }
inline int bcdParaNumero(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }
inline uint8_t numeroParaBcd(int n) { return static_cast<uint8_t>(((n / 10) << 4) | (n % 10)); }

inline bool anoBissexto(int ano) { return (ano % 4 == 0 && ano % 100 != 0) || ano % 400 == 0; }
inline int diasNoMes(int ano, int mes) {
  static const int dias[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (mes == 2 && anoBissexto(ano)) return 29;
  return dias[mes - 1];
}

// Dias desde 1/1/1970 de uma data (conta de calendário, sem usar timegm).
inline int64_t diasDesde1970(int ano, int mes, int dia) {
  ano -= (mes <= 2) ? 1 : 0;
  const int64_t era = (ano >= 0 ? ano : ano - 399) / 400;
  const int64_t anoDaEra = ano - era * 400;
  const int64_t diaDoAno = (153 * (mes + (mes > 2 ? -3 : 9)) + 2) / 5 + dia - 1;
  const int64_t diaDaEra = anoDaEra * 365 + anoDaEra / 4 - anoDaEra / 100 + diaDoAno;
  return era * 146097 + diaDaEra - 719468;
}

// O contrário: a data de um número de dias desde 1/1/1970.
inline void dataDosDias(int64_t dias, int& ano, int& mes, int& dia) {
  dias += 719468;
  const int64_t era = (dias >= 0 ? dias : dias - 146096) / 146097;
  const int64_t diaDaEra = dias - era * 146097;
  const int64_t anoDaEra = (diaDaEra - diaDaEra / 1460 + diaDaEra / 36524 - diaDaEra / 146096) / 365;
  const int64_t diaDoAno = diaDaEra - (365 * anoDaEra + anoDaEra / 4 - anoDaEra / 100);
  const int64_t mp = (5 * diaDoAno + 2) / 153;
  dia = static_cast<int>(diaDoAno - (153 * mp + 2) / 5 + 1);
  mes = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
  ano = static_cast<int>(anoDaEra + era * 400 + (mes <= 2 ? 1 : 0));
}

// Os 7 registradores de hora do DS3231 (0x00..0x06, em UTC) → epoch em segundos.
// Entende o modo 12 h e o bit do século. Devolve false se algum valor for impossível.
inline bool decodifica(const uint8_t r[7], int64_t& ep) {
  const uint8_t seg = r[0] & 0x7F;
  const uint8_t min = r[1] & 0x7F;
  const uint8_t dia = r[4] & 0x3F;
  const uint8_t mes = r[5] & 0x1F;
  const uint8_t ano = r[6];
  if (!bcdValido(seg) || !bcdValido(min) || !bcdValido(dia) || !bcdValido(mes) || !bcdValido(ano)) return false;
  int hora;
  if (r[2] & BIT_12H) {  // modo 12 h (nós gravamos em 24 h, mas por garantia)
    const uint8_t h = r[2] & 0x1F;
    if (!bcdValido(h)) return false;
    hora = bcdParaNumero(h);
    if (hora < 1 || hora > 12) return false;
    hora %= 12;                     // 12 AM = 0 h
    if (r[2] & BIT_PM) hora += 12;  // 12 PM = 12 h; 1 PM = 13 h
  } else {
    const uint8_t h = r[2] & 0x3F;
    if (!bcdValido(h)) return false;
    hora = bcdParaNumero(h);
  }
  const int s = bcdParaNumero(seg);
  const int m = bcdParaNumero(min);
  const int d = bcdParaNumero(dia);
  const int me = bcdParaNumero(mes);
  const int a = 2000 + bcdParaNumero(ano) + ((r[5] & BIT_SECULO) ? 100 : 0);
  if (s > 59 || m > 59 || hora > 23 || me < 1 || me > 12 || d < 1 || d > diasNoMes(a, me)) return false;
  ep = diasDesde1970(a, me, d) * 86400 + hora * 3600 + m * 60 + s;
  return true;
}

// epoch (UTC) → os 7 registradores, em modo 24 h. Devolve false se o ano não cabe
// no DS3231 (2000 a 2199).
inline bool codifica(int64_t ep, uint8_t r[7]) {
  const int64_t dias = agenda::divChao(ep, agenda::SEG_DIA);
  const int64_t resto = ep - dias * agenda::SEG_DIA;
  int ano, mes, dia;
  dataDosDias(dias, ano, mes, dia);
  if (ano < 2000 || ano > 2199) return false;
  r[0] = numeroParaBcd(static_cast<int>(resto % 60));
  r[1] = numeroParaBcd(static_cast<int>((resto / 60) % 60));
  r[2] = numeroParaBcd(static_cast<int>(resto / 3600));  // bit 6 = 0: modo 24 h
  r[3] = static_cast<uint8_t>(agenda::wd(dias) + 1);     // 1 = domingo
  r[4] = numeroParaBcd(dia);
  r[5] = static_cast<uint8_t>(numeroParaBcd(mes) | (ano >= 2100 ? BIT_SECULO : 0));
  r[6] = numeroParaBcd(ano % 100);
  return true;
}

}  // namespace relogio
