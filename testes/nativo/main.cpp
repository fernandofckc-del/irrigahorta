// testes/nativo/main.cpp — roda o núcleo do firmware (nucleo.h + agenda.h) no PC,
// com um hardware de mentira (PROTOCOLO.md §10).
//
// ENTRADA (stdin), uma linha por vez:
//   {...}                   linha JSON do app (como chegaria pelo RX)
//   #avanca <segundos>      avança o relógio rodando o laço (passos de 1 ms; aceita fração: 0.3)
//   #corrente <sensor> <A>  corrente que o sensor (0 ou 1) passa a ler (AC: RMS; DC: valor com sinal)
//                           Sensor com sa = -2 (pulso das válvulas) só lê essa corrente DURANTE os
//                           pulsos; fora deles lê 0 (no aparelho a ponte H só puxa corrente no pulso).
//   #reinicia               reinício (mantém o NVS simulado e a hora do sistema)
//   #hora <ep>              põe o relógio do sistema nesse epoch (0 = sem hora)
//   #pinos                  imprime em stderr os pinos e todos os pulsos feitos:
//                           #pinos 25=0 26=0 27=0 33=0 16=Z 17=Z 2=1   (Z = pino solto, INPUT)
// Extras deste simulador (não estão no PROTOCOLO):
//   #desconecta             o celular desconecta
//   #conecta [mtu]          o celular conecta (MTU padrão 517)
//   #botao <1|0>            aperta (1) ou solta (0) o botão BOOT
//   #marca <texto>          escreve {"t":"#marca","m":"<texto>"} em stdout e "#marca <texto>" em
//                           stderr (os testes usam para saber que tudo antes já foi tratado)
//   #nvs                    imprime em stderr o NVS simulado
//   #nvsgrava <chave> <txt> grava um texto no NVS simulado (para testar dados estragados)
//   #led                    imprime em stderr: #led aceso=0|1 acendeu=<vezes> aceso_ms=<tempo aceso>
//                           (contagem desde o último #led)
//   #agenda <s>             imprime em stderr as contas de agenda.h para a saída s (0..3), com a hora atual:
//                           #agenda s=.. ativo=0|1 prox=<ep ou -1> on=0|1 blocos=[[ini,fim],...]
//                           (blocos = intervalos ligados do dia local de hoje, em minutos)
//
// SAÍDA: stdout = linhas JSON que o ESP32 mandaria pelo TX (inteiras).
//        stderr = depuração. Linhas especiais em stderr:
//          #pulso n=.. valvula=.. gpio=.. lado=A|B ini=<ms> fim=<ms> dur=<ms>   (ao fim de cada pulso)
//          #desconectado / #conectado / #reiniciou
//          #ERRO <texto>   (algo proibido: A e B altos juntos, pino alto depois do pulso,
//                           pulsos com menos de 300 ms de folga...). O programa termina com código 3.
//
// Opções: --sem-hora (começa sem hora; senão a hora é 1792584000), --mtu N.
// O simulador começa "ligando" (boot) e já com o celular conectado.
//
// --teste-relogio: em vez de simular, testa as contas do DS3231 (relogio.h): todos os dias
// de 1970 a 2100 ida e volta, horas aleatórias, modo 12 h, BCD estragado e OSF.
// Escreve {"t":"#relogio","ok":1,...} em stdout; erros saem como "#ERRO ..." em stderr (código 3).

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "../../firmware/ControladorRega/nucleo.h"
#include "../../firmware/ControladorRega/relogio.h"

namespace {

const int PINO_A[2] = {25, 27};
const int PINO_B[2] = {26, 33};
const int PINO_RELE[2] = {16, 17};
const int PINO_LED = 2;

struct PulsoFeito {
  int n;
  int valvula;
  int gpio;
  char lado;
  double iniMs;
  double fimMs;
};

int64_t divChao(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
  return q;
}

class HalFalso : public rega::Hal {
 public:
  // relógio
  int64_t relogioUs = 0;    // desde o último boot
  int64_t totalUs = 0;      // desde que o processo começou (nunca volta)
  int64_t epocaBaseUs = 0;  // epoch(us) = epocaBaseUs + totalUs

  // "hardware"
  const rega::Nucleo* nucleo = nullptr;
  bool nivelA[2] = {false, false};
  bool nivelB[2] = {false, false};
  bool releSaida[2] = {false, false};  // false = pino solto (INPUT, "Z")
  bool nivelRele[2] = {false, false};
  bool nivelLed = false;
  int vezesLed = 0;          // quantas vezes o LED acendeu
  int64_t ledAcesoUs = 0;    // tempo total aceso
  int64_t ledMudouUs = 0;    // quando o LED mudou pela última vez
  bool botao = false;
  double corrente[2] = {0, 0};
  std::map<std::string, std::string> nvs;
  bool conectado = false;
  bool querReiniciar = false;
  bool erro = false;
  std::vector<PulsoFeito> pulsos;
  int64_t inicioPulsoUs = -1;
  int64_t fimUltimoPulsoUs = -1;
  uint32_t semente = 12345;

  void avanca(int64_t d) {
    relogioUs += d;
    totalUs += d;
  }
  void falha(const std::string& msg) {
    erro = true;
    std::fprintf(stderr, "#ERRO %s (t=%.3f ms)\n", msg.c_str(), totalUs / 1000.0);
  }
  void reiniciaHardware() {
    relogioUs = 0;
    for (int v = 0; v < 2; v++) {
      nivelA[v] = false;
      nivelB[v] = false;
    }
    for (int r = 0; r < 2; r++) {
      releSaida[r] = false;  // no reset os pinos dos relés ficam soltos (INPUT)
      nivelRele[r] = false;
    }
    led(false);
    inicioPulsoUs = -1;
  }
  bool algumLadoAlto() const { return nivelA[0] || nivelB[0] || nivelA[1] || nivelB[1]; }

  // ---------- Hal ----------
  int64_t us() override { return relogioUs; }
  void esperaAte(int64_t alvo) override {
    if (alvo > relogioUs) avanca(alvo - relogioUs);
  }
  int64_t epoch() override { return divChao(epocaBaseUs + totalUs, 1000000); }
  void acertaRelogio(int64_t ep) override { epocaBaseUs = ep * 1000000 - totalUs; }
  bool temRtc() override { return false; }

  void ponte(int v, int lado) override {
    if (v < 0 || v > 1 || lado < 0 || lado > 2) {
      falha("ponte com valores errados");
      return;
    }
    if (lado == 0) {
      if (nivelA[v] || nivelB[v]) {  // fim de um pulso
        PulsoFeito p;
        p.n = static_cast<int>(pulsos.size()) + 1;
        p.valvula = v;
        p.lado = nivelA[v] ? 'A' : 'B';
        p.gpio = nivelA[v] ? PINO_A[v] : PINO_B[v];
        p.iniMs = inicioPulsoUs / 1000.0;
        p.fimMs = totalUs / 1000.0;
        pulsos.push_back(p);
        fimUltimoPulsoUs = totalUs;
        std::fprintf(stderr, "#pulso n=%d valvula=%d gpio=%d lado=%c ini=%.3f fim=%.3f dur=%.3f\n", p.n, v,
                     p.gpio, p.lado, p.iniMs, p.fimMs, p.fimMs - p.iniMs);
      }
      nivelA[v] = false;
      nivelB[v] = false;
      return;
    }
    if (algumLadoAlto()) falha("pulso começou com outro pulso ainda ligado");
    if (fimUltimoPulsoUs >= 0 && totalUs - fimUltimoPulsoUs < 300000) {
      falha("menos de 300 ms entre dois pulsos");
    }
    // igual ao .ino: baixa o outro lado primeiro, depois sobe este
    if (lado == 1) {
      nivelB[v] = false;
      nivelA[v] = true;
    } else {
      nivelA[v] = false;
      nivelB[v] = true;
    }
    if (nivelA[v] && nivelB[v]) falha("A e B altos ao mesmo tempo");
    inicioPulsoUs = totalUs;
  }
  // igual ao .ino: desligado = pino solto (INPUT); ligado = saída no nível que aciona
  void rele(int r, bool ligado, bool inv) override {
    if (r < 0 || r > 1) {
      falha("relé com número errado");
      return;
    }
    releSaida[r] = ligado;
    nivelRele[r] = ligado ? !inv : false;
  }

  // ADC de mentira: usa mva/div/tp do sensor configurado no núcleo.
  int leMv(int j) override {
    double I = corrente[j];
    double mva = 185, div = 0.667;
    bool ac = false;
    int sa = -1;
    if (nucleo != nullptr) {
      const rega::Sensor& sn = nucleo->config().sen[j];
      mva = sn.mva;
      div = sn.div;
      ac = sn.ac;
      sa = sn.sa;
    }
    if (sa == -2 && !algumLadoAlto()) I = 0;  // sensor das válvulas: só tem corrente no pulso
    const double sens = mva * div;
    semente = semente * 1103515245u + 12345u;
    const double ruido = ((semente >> 8) % 4001) / 1000.0 - 2.0;  // ±2 mV
    double v;
    if (!ac) {
      v = 2500.0 * div + I * sens + ruido;  // ACS712: 2,5 V no zero, depois do divisor
    } else {
      const double t = totalUs / 1e6;
      v = 1650.0 + std::sqrt(2.0) * I * sens * std::sin(2.0 * M_PI * 60.0 * t) + ruido;
    }
    if (v < 0) v = 0;
    if (v > 3300) v = 3300;
    return static_cast<int>(std::lround(v));
  }

  void led(bool aceso) override {
    if (aceso == nivelLed) return;
    if (nivelLed) ledAcesoUs += totalUs - ledMudouUs;
    else vezesLed++;
    nivelLed = aceso;
    ledMudouUs = totalUs;
  }
  void imprimeLed() {
    int64_t aceso = ledAcesoUs;
    if (nivelLed) aceso += totalUs - ledMudouUs;
    std::fprintf(stderr, "#led aceso=%d acendeu=%d aceso_ms=%.0f\n", nivelLed ? 1 : 0, vezesLed, aceso / 1000.0);
    vezesLed = 0;
    ledAcesoUs = 0;
    ledMudouUs = totalUs;
  }
  bool botaoApertado() override { return botao; }

  bool nvsLe(const char* chave, std::string& valor) override {
    auto it = nvs.find(chave);
    if (it == nvs.end()) return false;
    valor = it->second;
    return true;
  }
  bool nvsGrava(const char* chave, const std::string& valor) override {
    if (valor.size() >= 4000) {  // limite do NVS do ESP32 (com o \0)
      std::fprintf(stderr, "#nvs recusou %s (%zu bytes)\n", chave, valor.size());
      return false;
    }
    nvs[chave] = valor;
    std::fprintf(stderr, "#nvs grava %s (%zu bytes)\n", chave, valor.size());
    return true;
  }
  std::string idPlaca() override { return "1A2B"; }
  void envia(const std::string& linha) override {
    if (!conectado) {
      falha("mandou mensagem sem celular conectado");
      return;
    }
    std::fwrite(linha.data(), 1, linha.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
  }
  void desconecta() override {
    conectado = false;
    std::fprintf(stderr, "#desconectado (pelo ESP32)\n");
  }
  void reinicia() override { querReiniciar = true; }
  void log(const std::string& msg) override {
    std::fprintf(stderr, "[%10.3f] %s\n", relogioUs / 1000.0, msg.c_str());
  }

  void imprimePinos() {
    std::fprintf(stderr, "#pinos %d=%d %d=%d %d=%d %d=%d", PINO_A[0], nivelA[0], PINO_B[0], nivelB[0],
                 PINO_A[1], nivelA[1], PINO_B[1], nivelB[1]);
    for (int r = 0; r < 2; r++) {
      if (releSaida[r]) std::fprintf(stderr, " %d=%d", PINO_RELE[r], nivelRele[r]);
      else std::fprintf(stderr, " %d=Z", PINO_RELE[r]);
    }
    std::fprintf(stderr, " %d=%d\n", PINO_LED, nivelLed);
    for (const PulsoFeito& p : pulsos) {
      std::fprintf(stderr, "#pinos-pulso n=%d valvula=%d gpio=%d lado=%c ini=%.3f fim=%.3f dur=%.3f\n", p.n,
                   p.valvula, p.gpio, p.lado, p.iniMs, p.fimMs, p.fimMs - p.iniMs);
    }
  }
};

class Simulador {
 public:
  HalFalso hal;
  std::unique_ptr<rega::Nucleo> nucleo;
  int mtu = 517;

  void liga() {
    nucleo.reset();
    hal.reiniciaHardware();
    nucleo.reset(new rega::Nucleo(hal));
    hal.nucleo = nucleo.get();
    nucleo->inicia();
    conecta(mtu);
  }
  void conecta(int m) {
    if (hal.conectado) return;
    hal.conectado = true;
    nucleo->conectou(m);
    std::fprintf(stderr, "#conectado mtu=%d\n", m);
  }
  void desconecta() {
    if (!hal.conectado) return;
    hal.conectado = false;
    nucleo->desconectou();
    std::fprintf(stderr, "#desconectado\n");
  }
  void passo() {
    nucleo->passo();
    if (hal.algumLadoAlto()) hal.falha("ponte H ficou com um lado alto depois do passo");
    if (hal.querReiniciar) {
      hal.querReiniciar = false;
      std::fprintf(stderr, "#reiniciou\n");
      hal.conectado = false;
      liga();
    }
  }
  void avanca(double segundos) {
    if (!(segundos >= 0) || segundos > 1e8) {
      hal.falha("#avanca com valor errado");
      return;
    }
    const int64_t alvo = hal.totalUs + static_cast<int64_t>(std::llround(segundos * 1e6));
    while (hal.totalUs < alvo) {
      passo();
      if (hal.totalUs < alvo) hal.avanca(std::min<int64_t>(1000, alvo - hal.totalUs));
    }
  }

  void controle(const std::string& linha) {
    std::istringstream in(linha);
    std::string cmd;
    in >> cmd;
    if (cmd == "#avanca") {
      double s = -1;
      in >> s;
      avanca(s);
    } else if (cmd == "#corrente") {
      int j = -1;
      double a = 0;
      in >> j >> a;
      if (j < 0 || j > 1 || !std::isfinite(a)) hal.falha("#corrente com valores errados");
      else hal.corrente[j] = a;
    } else if (cmd == "#reinicia") {
      std::fprintf(stderr, "#reiniciou\n");
      hal.conectado = false;
      liga();
    } else if (cmd == "#hora") {
      long long ep = -1;
      in >> ep;
      if (ep < 0 || ep > 100000000000LL) hal.falha("#hora com valor errado");
      else hal.acertaRelogio(ep);  // ep = 0: relógio sem hora, contando a partir de 0
    } else if (cmd == "#pinos") {
      hal.imprimePinos();
    } else if (cmd == "#desconecta") {
      desconecta();
    } else if (cmd == "#conecta") {
      int m = mtu;
      if (!(in >> m)) m = mtu;
      conecta(m);
    } else if (cmd == "#botao") {
      int b = 0;
      in >> b;
      hal.botao = (b != 0);
    } else if (cmd == "#marca") {
      std::string resto;
      std::getline(in, resto);
      while (!resto.empty() && resto[0] == ' ') resto.erase(0, 1);
      JsonDocument d;
      d["t"] = "#marca";
      d["m"] = resto;
      std::string txt;
      serializeJson(d, txt);
      std::fprintf(stdout, "%s\n", txt.c_str());
      std::fflush(stdout);
      std::fprintf(stderr, "#marca %s\n", resto.c_str());
    } else if (cmd == "#agenda") {
      int sd = -1;
      in >> sd;
      if (sd < 0 || sd > 3) {
        hal.falha("#agenda com saída errada");
        return;
      }
      const rega::Config& c = nucleo->config();
      const int64_t ep = hal.epoch();
      const int64_t L = ep + static_cast<int64_t>(c.tz) * 60;
      const bool ativo = agenda::programaAtivo(c.s[sd].r, c.s[sd].nr, L);
      int64_t prox = -1;
      bool on = false;
      if (!agenda::proximaMudanca(c.s[sd].r, c.s[sd].nr, ep, c.tz, prox, on)) prox = -1;
      std::string blocos = "[";
      for (const auto& b : agenda::blocosDoDia(c.s[sd].r, c.s[sd].nr, agenda::divChao(L, agenda::SEG_DIA))) {
        if (blocos.size() > 1) blocos += ",";
        blocos += "[" + std::to_string(b.first) + "," + std::to_string(b.second) + "]";
      }
      blocos += "]";
      std::fprintf(stderr, "#agenda s=%d ativo=%d prox=%lld on=%d blocos=%s\n", sd, ativo ? 1 : 0,
                   static_cast<long long>(prox), on ? 1 : 0, blocos.c_str());
    } else if (cmd == "#led") {
      hal.imprimeLed();
    } else if (cmd == "#nvsgrava") {
      std::string chave, resto;
      in >> chave;
      std::getline(in, resto);
      if (!resto.empty() && resto[0] == ' ') resto.erase(0, 1);
      hal.nvs[chave] = resto;
    } else if (cmd == "#nvs") {
      for (const auto& kv : hal.nvs) std::fprintf(stderr, "#nvs %s = %s\n", kv.first.c_str(), kv.second.c_str());
    } else {
      hal.falha("controle desconhecido: " + cmd);
    }
  }
};

// ---------- teste das contas do DS3231 (relogio.h) ----------
int errosRelogio = 0;
void erroRelogio(const std::string& msg) {
  if (errosRelogio < 20) std::fprintf(stderr, "#ERRO relogio: %s\n", msg.c_str());
  errosRelogio++;
}

// Registradores na mão: hora em BCD (byte já pronto), dia/mês/ano em número.
bool decodificaManual(int seg, int min, uint8_t hora, int dia, int mes, int ano, int64_t& ep) {
  uint8_t r[7];
  r[0] = relogio::numeroParaBcd(seg);
  r[1] = relogio::numeroParaBcd(min);
  r[2] = hora;
  r[3] = 1;
  r[4] = relogio::numeroParaBcd(dia);
  r[5] = static_cast<uint8_t>(relogio::numeroParaBcd(mes) | (ano >= 2100 ? relogio::BIT_SECULO : 0));
  r[6] = relogio::numeroParaBcd(ano % 100);
  return relogio::decodifica(r, ep);
}

int testaRelogio() {
  // 1) todos os dias de 1/1/1970 a 31/12/2100: ida e volta, contra um calendário contado à mão
  int ano = 1970, mes = 1, dia = 1;
  int semana = 4;  // 1/1/1970 foi quinta-feira
  int64_t dias = 0;
  uint32_t semente = 20261022;
  int64_t idaVolta = 0;
  for (;; dias++) {
    if (relogio::diasDesde1970(ano, mes, dia) != dias) {
      erroRelogio("diasDesde1970 " + std::to_string(ano) + "-" + std::to_string(mes) + "-" + std::to_string(dia));
    }
    int a2 = 0, m2 = 0, d2 = 0;
    relogio::dataDosDias(dias, a2, m2, d2);
    if (a2 != ano || m2 != mes || d2 != dia) erroRelogio("dataDosDias " + std::to_string(dias));
    if (agenda::wd(dias) != semana) erroRelogio("dia da semana " + std::to_string(dias));
    // 2) dias que o DS3231 guarda: hora aleatória (e os extremos do dia) ida e volta pelos registradores
    if (ano >= 2000) {
      semente = semente * 1103515245u + 12345u;
      const int64_t segs[3] = {0, 86399, static_cast<int64_t>((semente >> 8) % 86400)};
      for (int64_t sg : segs) {
        const int64_t ep = dias * 86400 + sg;
        uint8_t r[7];
        int64_t volta = -1;
        if (!relogio::codifica(ep, r)) {
          erroRelogio("codifica recusou " + std::to_string(ep));
          continue;
        }
        if (r[2] & relogio::BIT_12H) erroRelogio("codifica não usou o modo 24 h");
        if (r[3] != semana + 1) erroRelogio("registrador do dia da semana " + std::to_string(ep));
        if (((r[5] & relogio::BIT_SECULO) != 0) != (ano >= 2100)) erroRelogio("bit do século " + std::to_string(ep));
        if (!relogio::decodifica(r, volta) || volta != ep) erroRelogio("ida e volta " + std::to_string(ep));
        idaVolta++;
      }
    }
    if (ano == 2100 && mes == 12 && dia == 31) break;
    // próximo dia no calendário contado à mão
    static const int nDias[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const bool bissexto = (ano % 4 == 0 && ano % 100 != 0) || ano % 400 == 0;
    const int fimMes = (mes == 2 && bissexto) ? 29 : nDias[mes - 1];
    semana = (semana + 1) % 7;
    if (++dia > fimMes) {
      dia = 1;
      if (++mes > 12) {
        mes = 1;
        ano++;
      }
    }
  }
  // 3) fora do que o DS3231 guarda
  uint8_t r[7];
  if (relogio::codifica(relogio::diasDesde1970(2000, 1, 1) * 86400 - 1, r)) erroRelogio("aceitou 1999");
  if (relogio::codifica(relogio::diasDesde1970(2200, 1, 1) * 86400, r)) erroRelogio("aceitou 2200");
  // 4) modo 12 h: byte da hora → hora certa
  const int64_t base = relogio::diasDesde1970(2026, 10, 21) * 86400 + 34 * 60 + 56;  // 21/10/2026 xx:34:56
  struct {
    uint8_t byte;
    int hora;  // -1 = tem que recusar
  } doze[] = {{0x52, 0},  {0x41, 1},  {0x49, 9},  {0x50, 10}, {0x51, 11}, {0x72, 12}, {0x61, 13},
              {0x69, 21}, {0x70, 22}, {0x71, 23}, {0x40, -1}, {0x60, -1}, {0x53, -1}, {0x73, -1}, {0x4A, -1},
              {0x00, 0},  {0x09, 9},  {0x10, 10}, {0x12, 12}, {0x19, 19}, {0x23, 23}, {0x24, -1}, {0x2A, -1}};
  for (const auto& c : doze) {
    int64_t ep = -1;
    const bool ok = decodificaManual(56, 34, c.byte, 21, 10, 2026, ep);
    char txt[64];
    std::snprintf(txt, sizeof(txt), "byte da hora 0x%02X", c.byte);
    if (c.hora < 0 && ok) erroRelogio(std::string(txt) + " devia ser recusado");
    if (c.hora >= 0 && (!ok || ep != base + c.hora * 3600)) erroRelogio(std::string(txt) + " deu hora errada");
  }
  // 5) registradores impossíveis são recusados; os válidos de borda passam
  int64_t ep = 0;
  if (decodificaManual(60, 0, 0x00, 1, 1, 2026, ep)) erroRelogio("segundo 60");
  if (decodificaManual(0, 60, 0x00, 1, 1, 2026, ep)) erroRelogio("minuto 60");
  if (decodificaManual(0, 0, 0x00, 0, 1, 2026, ep)) erroRelogio("dia 0");
  if (decodificaManual(0, 0, 0x00, 32, 1, 2026, ep)) erroRelogio("dia 32");
  if (decodificaManual(0, 0, 0x00, 31, 4, 2026, ep)) erroRelogio("31 de abril");
  if (decodificaManual(0, 0, 0x00, 29, 2, 2023, ep)) erroRelogio("29/02/2023");
  if (decodificaManual(0, 0, 0x00, 29, 2, 2100, ep)) erroRelogio("29/02/2100 (o DS3231 acha que 2100 é bissexto)");
  if (decodificaManual(0, 0, 0x00, 1, 0, 2026, ep)) erroRelogio("mês 0");
  if (decodificaManual(0, 0, 0x00, 1, 13, 2026, ep)) erroRelogio("mês 13");
  if (!decodificaManual(0, 0, 0x00, 29, 2, 2024, ep) || ep != relogio::diasDesde1970(2024, 2, 29) * 86400) erroRelogio("29/02/2024");
  if (!decodificaManual(0, 0, 0x00, 29, 2, 2000, ep) || ep != relogio::diasDesde1970(2000, 2, 29) * 86400) erroRelogio("29/02/2000");
  uint8_t ruim[7] = {0x5A, 0x00, 0x00, 1, 0x01, 0x01, 0x26};  // segundo com algarismo 10 (BCD estragado)
  if (relogio::decodifica(ruim, ep)) erroRelogio("BCD estragado no segundo");
  uint8_t ruim2[7] = {0x00, 0x1A, 0x00, 1, 0x01, 0x01, 0x26};
  if (relogio::decodifica(ruim2, ep)) erroRelogio("BCD estragado no minuto");
  uint8_t ruim3[7] = {0x00, 0x00, 0x00, 1, 0x01, 0x01, 0xA0};
  if (relogio::decodifica(ruim3, ep)) erroRelogio("BCD estragado no ano");
  // 21/10/2026 12:00:00 UTC = 1792584000 (a hora inicial do simulador), com lixo nos bits que não contam
  uint8_t certo[7] = {0x80, 0x00, 0x12, 4, 0x21, 0x10, 0x26};
  if (!relogio::decodifica(certo, ep) || ep != 1792584000LL) erroRelogio("21/10/2026 12:00");
  // 6) OSF (registrador 0x0F, bit 7)
  if (!relogio::osfLigado(0x80) || !relogio::osfLigado(0x88) || relogio::osfLigado(0x00) || relogio::osfLigado(0x7F)) {
    erroRelogio("OSF");
  }
  std::printf("{\"t\":\"#relogio\",\"ok\":%d,\"dias\":%lld,\"idaVolta\":%lld,\"erros\":%d}\n", errosRelogio ? 0 : 1,
              static_cast<long long>(dias + 1), static_cast<long long>(idaVolta), errosRelogio);
  return errosRelogio ? 3 : 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--teste-relogio") return testaRelogio();
  Simulador sim;
  bool semHora = false;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--sem-hora") semHora = true;
    else if (a == "--mtu" && i + 1 < argc) sim.mtu = std::atoi(argv[++i]);
    else {
      std::fprintf(stderr, "uso: %s [--sem-hora] [--mtu N]  |  %s --teste-relogio\n", argv[0], argv[0]);
      return 2;
    }
  }
  sim.hal.acertaRelogio(semHora ? 0 : 1792584000LL);
  sim.liga();

  std::string linha;
  while (std::getline(std::cin, linha)) {
    if (!linha.empty() && linha.back() == '\r') linha.pop_back();
    if (linha.empty()) continue;
    if (linha[0] == '#') {
      sim.controle(linha);
    } else if (!sim.hal.conectado) {
      std::fprintf(stderr, "#ignorada (celular desconectado): %s\n", linha.c_str());
    } else {
      sim.nucleo->recebeLinha(linha);
      sim.passo();
    }
  }
  sim.nucleo.reset();
  return sim.hal.erro ? 3 : 0;
}
