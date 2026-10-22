// nucleo.h — o "cérebro" do Controlador de Rega (PROTOCOLO.md).
//
// Aqui fica toda a lógica: configuração, regras, prioridades das saídas,
// fila de pulsos das válvulas, medição de corrente, alarmes, eventos,
// comandos do app, PIN, botão BOOT e LED.
//
// Este arquivo NÃO usa nada do Arduino (só C++17 e ArduinoJson 7).
// Ele conversa com o hardware só pela estrutura "Hal" abaixo.
// Assim o mesmo código roda no ESP32 (ControladorRega.ino) e no PC (testes/nativo).
#pragma once

#include <ArduinoJson.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <deque>
#include <memory>
#include <string>
#include <vector>

#include "agenda.h"

namespace rega {

// ===================== Constantes =====================
constexpr const char* VERSAO_FW = "1.0.0";
constexpr int NUM_SAIDAS = 4;           // 0, 1 = válvulas; 2, 3 = relés
constexpr int NUM_VALVULAS = 2;
constexpr int NUM_SENSORES = 2;
constexpr int MAX_REGRAS = 8;
constexpr int MAX_EVENTOS = 200;
constexpr int EVENTOS_POR_LOG = 20;
constexpr int64_t HORA_VALIDA = 1700000000;   // ep >= isso = hora válida
constexpr int64_t HORA_MAXIMA = 4102444800;   // 1/1/2100 (acima disso é erro)
// Maior hora que o relógio do sistema guarda. No núcleo Arduino-ESP32 2.x o time_t
// tem 32 bits: só vai até 19/01/2038 03:14:07 UTC. No 3.x (e no PC) tem 64 bits.
constexpr int64_t HORA_MAXIMA_RELOGIO = (sizeof(time_t) >= 8) ? HORA_MAXIMA : INT32_MAX;
constexpr size_t MAX_LINHA = 4096;            // linha maior é descartada
constexpr size_t MAX_FILA_ENTRADA = 16;       // linhas esperando para serem tratadas
constexpr size_t MAX_NVS = 3999;              // texto no NVS (4000 com o \0 do fim)
constexpr int MAX_FALHAS_PIN = 5;
constexpr int64_t TRAVA_PIN_MS = 60000;       // depois de 5 PINs errados: recusa auth por 60 s

constexpr int64_t TICK_MS = 1000;             // contas das saídas e "st"
constexpr int64_t CICLO_MEDIDA_MS = 250;      // uma medição de corrente a cada 250 ms
constexpr int64_t JANELA_US = 100000;         // cada medição dura 100 ms
constexpr int64_t ZERO_US = 1000000;          // zerar mede por 1 s
constexpr int64_t PASSO_AMOSTRA_US = 250;     // uma leitura do ADC a cada 250 us
constexpr int64_t INTERVALO_PULSOS_US = 300000;  // folga mínima entre dois pulsos (300 ms)
constexpr int64_t ATRASO_F2_US = 2000000;        // 2º pulso de fechar (2 s)
constexpr int64_t CARENCIA_21_MS = 5000;      // alarme 21: ligada há pelo menos 5 s
constexpr int64_t TEMPO_21_MS = 3000;         //   e corrente baixa por 3 s
constexpr int64_t TEMPO_22_MS = 2000;         // alarme 22: corrente alta por 2 s
constexpr int64_t BOTAO_FILTRO_MS = 50;       // filtro do botão (debounce)
constexpr int64_t BOTAO_SEGURAR_MS = 3000;    // segurar 3 s
constexpr int64_t ATRASO_REINICIO_MS = 500;
constexpr int64_t SEM_DIA = INT64_MIN;

// Origens (campo "o" dos eventos)
constexpr int ORIGEM_PROGRAMA = 0;
constexpr int ORIGEM_MANUAL = 1;   // também usado para ações vindas do app
constexpr int ORIGEM_PAUSA = 2;
constexpr int ORIGEM_BLOQUEIO = 3;
constexpr int ORIGEM_INICIO = 4;
constexpr int ORIGEM_BOTAO = 5;
constexpr int ORIGEM_DESABILITADA = 7;

// ===================== Ligação com o hardware =====================
// O .ino (ESP32) e o teste do PC implementam esta estrutura.
struct Hal {
  virtual ~Hal() {}
  virtual int64_t us() = 0;                     // microssegundos desde que ligou (nunca volta)
  virtual void esperaAte(int64_t us) = 0;       // espera até esse instante (us)
  virtual int64_t epoch() = 0;                  // hora do sistema, UTC em segundos
  virtual void acertaRelogio(int64_t ep) = 0;   // acerta a hora do sistema (e o DS3231)
  virtual bool temRtc() = 0;                    // DS3231 encontrado?
  virtual void ponte(int valvula, int lado) = 0;    // 0 = A e B baixos; 1 = só A alto; 2 = só B alto
  // Relé (0 ou 1). Desligado = pino solto (INPUT, sem pull). Ligado = OUTPUT em nível alto
  // (ou baixo, se inv = true: módulo "acionado em nível baixo").
  virtual void rele(int rele, bool ligado, bool inv) = 0;
  virtual int leMv(int sensor) = 0;             // uma leitura do sensor em mV
  virtual void led(bool aceso) = 0;
  virtual bool botaoApertado() = 0;             // leitura crua (sem filtro)
  virtual bool nvsLe(const char* chave, std::string& valor) = 0;
  virtual bool nvsGrava(const char* chave, const std::string& valor) = 0;
  virtual std::string idPlaca() = 0;            // 4 dígitos hex do fim do MAC
  virtual void envia(const std::string& linha) = 0;  // manda uma linha JSON (sem o \n)
  virtual void desconecta() = 0;                // derruba o celular conectado
  virtual void reinicia() = 0;                  // reinicia o ESP32
  virtual void log(const std::string& msg) = 0; // mensagem para o monitor serial
};

// ===================== Configuração (§9) =====================
struct Saida {
  std::string n;
  bool en = true;
  bool inv = false;
  agenda::Regra r[MAX_REGRAS];
  int nr = 0;  // quantas regras
};

struct Sensor {
  std::string n;
  bool en = false;
  bool ac = false;     // false = "dc", true = "ac"
  double mva = 185;    // mV por A do sensor
  double div = 0.667;  // divisor de tensão
  double aj = 1;       // ajuste fino
  int sa = -2;         // o que vigia: -1 só mostra, -2 pulso das válvulas, 0..3 saída
  double min = 0.1;    // A (0 = sem limite)
  double max = 0;      // A (0 = sem limite)
  bool corta = false;  // corrente alta bloqueia a saída
};

struct Config {
  std::string nome;
  int tz = -180;
  int pms = 80;
  bool f2 = true;
  std::string pin;  // vazio = sem PIN
  Saida s[NUM_SAIDAS];
  Sensor sen[NUM_SENSORES];
};

// Põe a configuração padrão (§9) em "c". Mexe direto em "c" para não criar
// cópias grandes na pilha (a pilha do loop() do ESP32 é pequena).
inline void poePadrao(Config& c, const std::string& id) {
  c.nome = "Rega-" + id;
  c.tz = -180;
  c.pms = 80;
  c.f2 = true;
  c.pin.clear();
  const char* nomes[NUM_SAIDAS] = {"Válvula 1", "Válvula 2", "Hidroponia", "Relé 2"};
  for (int i = 0; i < NUM_SAIDAS; i++) {
    c.s[i].n = nomes[i];
    c.s[i].en = (i != 3);
    c.s[i].inv = false;
    c.s[i].nr = 0;
  }
  for (int j = 0; j < NUM_SENSORES; j++) c.sen[j] = Sensor();
  c.sen[0].n = "Válvulas";
  c.sen[0].ac = false;
  c.sen[0].mva = 185;
  c.sen[0].div = 0.667;
  c.sen[0].sa = -2;
  c.sen[1].n = "Bomba";
  c.sen[1].ac = true;
  c.sen[1].mva = 33.3;
  c.sen[1].div = 1;
  c.sen[1].sa = 2;
}

// ===================== Ajudantes =====================

// Arredonda para 3 casas (correntes) e evita "-0".
inline double r3(double x) {
  double r = std::round(x * 1000.0) / 1000.0;
  return (r == 0) ? 0.0 : r;
}
inline double r2(double x) {
  double r = std::round(x * 100.0) / 100.0;
  return (r == 0) ? 0.0 : r;
}

// Corta um texto em até "max" bytes sem partir um caractere acentuado (UTF-8)
// e tira caracteres de controle.
inline std::string limpaTexto(const std::string& s, size_t max) {
  std::string limpo;
  for (char ch : s) {
    const unsigned char u = static_cast<unsigned char>(ch);
    if (u < 0x20 || u == 0x7F) continue;
    limpo += ch;
  }
  if (limpo.size() <= max) return limpo;
  size_t n = max;
  while (n > 0 && (static_cast<unsigned char>(limpo[n]) & 0xC0) == 0x80) n--;
  return limpo.substr(0, n);
}

enum class Leitura { Ausente, Ok, Erro };

// Lê um número de um campo JSON. true/false contam como 1/0 só se aceitaSimNao.
inline Leitura leNumero(JsonVariantConst v, double& x, bool aceitaSimNao = false) {
  if (v.isNull()) return Leitura::Ausente;
  if (v.is<bool>()) {
    if (!aceitaSimNao) return Leitura::Erro;
    x = v.as<bool>() ? 1 : 0;
    return Leitura::Ok;
  }
  if (!v.is<double>()) return Leitura::Erro;
  x = v.as<double>();
  if (!std::isfinite(x)) return Leitura::Erro;
  return Leitura::Ok;
}

// Lê a configuração que veio do app (ou do NVS), corrigindo os limites.
// Campo que não veio = fica como estava. Tipo errado = erro.
class LeitorConfig {
 public:
  std::string erro;

  bool aplica(JsonObjectConst c, Config& cfg) {
    erro.clear();
    if (!c["nome"].isNull()) {
      std::string nome;
      texto(c["nome"], "nome", 20, nome);
      if (ok() && nome.empty()) erro = "O nome não pode ficar vazio";
      if (ok()) cfg.nome = nome;
    }
    inteiro(c["tz"], "tz", -720, 840, cfg.tz);
    inteiro(c["pms"], "pms", 10, 1000, cfg.pms);
    simNao(c["f2"], "f2", cfg.f2);
    JsonVariantConst pin = c["pin"];
    if (!pin.isNull()) {
      const char* p = pin.as<const char*>();
      bool valido = (p != nullptr);
      std::string novo = p ? p : "";
      if (novo.size() > 8) valido = false;
      for (char ch : novo) {
        if (ch < '0' || ch > '9') valido = false;
      }
      if (!valido) falha("O PIN deve ter de 0 a 8 números");
      else cfg.pin = novo;
    }
    JsonVariantConst s = c["s"];
    if (!s.isNull()) {
      if (!s.is<JsonArrayConst>()) {
        campoErrado("s");
      } else {
        int i = 0;
        for (JsonVariantConst item : s.as<JsonArrayConst>()) {
          if (i >= NUM_SAIDAS) break;  // a mais é ignorada
          leSaida(item, i, cfg.s[i]);
          i++;
        }
      }
    }
    JsonVariantConst sen = c["sen"];
    if (!sen.isNull()) {
      if (!sen.is<JsonArrayConst>()) {
        campoErrado("sen");
      } else {
        int j = 0;
        for (JsonVariantConst item : sen.as<JsonArrayConst>()) {
          if (j >= NUM_SENSORES) break;
          leSensor(item, j, cfg.sen[j]);
          j++;
        }
      }
    }
    return ok();
  }

 private:
  bool ok() const { return erro.empty(); }
  void falha(const std::string& msg) {
    if (erro.empty()) erro = msg;
  }
  void campoErrado(const std::string& campo) { falha("Valor inválido no campo " + campo); }

  // inteiro: arredonda e corta nos limites
  void inteiro(JsonVariantConst v, const std::string& campo, int lo, int hi, int& dest) {
    double x = 0;
    const Leitura l = leNumero(v, x);
    if (l == Leitura::Ausente) return;
    if (l == Leitura::Erro) {
      campoErrado(campo);
      return;
    }
    x = std::round(x);
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    dest = static_cast<int>(x);
  }
  void decimal(JsonVariantConst v, const std::string& campo, double lo, double hi, double& dest) {
    double x = 0;
    const Leitura l = leNumero(v, x);
    if (l == Leitura::Ausente) return;
    if (l == Leitura::Erro) {
      campoErrado(campo);
      return;
    }
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    dest = x;
  }
  // 0/1 (aceita true/false; qualquer número diferente de 0 vira 1)
  void simNao(JsonVariantConst v, const std::string& campo, bool& dest) {
    double x = 0;
    const Leitura l = leNumero(v, x, true);
    if (l == Leitura::Ausente) return;
    if (l == Leitura::Erro) {
      campoErrado(campo);
      return;
    }
    dest = (x != 0);
  }
  void texto(JsonVariantConst v, const std::string& campo, size_t max, std::string& dest) {
    if (v.isNull()) return;
    const char* p = v.as<const char*>();
    if (p == nullptr) {
      campoErrado(campo);
      return;
    }
    dest = limpaTexto(p, max);
  }

  void leSaida(JsonVariantConst item, int i, Saida& sd) {
    const std::string pre = "s[" + std::to_string(i) + "]";
    if (!item.is<JsonObjectConst>()) {
      campoErrado(pre);
      return;
    }
    JsonObjectConst o = item.as<JsonObjectConst>();
    texto(o["n"], pre + ".n", 24, sd.n);
    simNao(o["en"], pre + ".en", sd.en);
    simNao(o["inv"], pre + ".inv", sd.inv);
    JsonVariantConst r = o["r"];
    if (r.isNull()) return;
    if (!r.is<JsonArrayConst>()) {
      campoErrado(pre + ".r");
      return;
    }
    int nr = 0;
    int k = 0;
    for (JsonVariantConst item2 : r.as<JsonArrayConst>()) {
      agenda::Regra rg;
      const bool fica = leRegra(item2, pre + ".r[" + std::to_string(k) + "]", rg);
      k++;
      if (fica && nr < MAX_REGRAS) sd.r[nr++] = rg;  // a partir da 9ª é cortada
    }
    sd.nr = nr;
  }

  // Devolve false se a regra deve ser descartada (tipo desconhecido ou faltando campo).
  bool leRegra(JsonVariantConst item, const std::string& pre, agenda::Regra& rg) {
    if (!item.is<JsonObjectConst>()) return false;
    JsonObjectConst o = item.as<JsonObjectConst>();
    const char* k = o["k"].as<const char*>();
    if (k == nullptr) return false;
    const std::string tipo = k;
    bool completa = true;
    if (tipo == "f") {
      rg.k = 'f';
      completa &= obrigatorio(o["h"], pre + ".h", 0, 1439, rg.h);
      completa &= obrigatorio(o["d"], pre + ".d", 1, 1440, rg.d);
    } else if (tipo == "c") {
      rg.k = 'c';
      completa &= obrigatorio(o["a"], pre + ".a", 0, 1439, rg.a);
      completa &= obrigatorio(o["b"], pre + ".b", 0, 1439, rg.b);
      completa &= obrigatorio(o["on"], pre + ".on", 1, 1440, rg.on);
      completa &= obrigatorio(o["off"], pre + ".off", 0, 1440, rg.off);
    } else {
      return false;  // tipo desconhecido: descarta
    }
    inteiro(o["w"], pre + ".w", 0, 127, rg.w);
    simNao(o["en"], pre + ".en", rg.en);
    return completa;
  }
  bool obrigatorio(JsonVariantConst v, const std::string& campo, int lo, int hi, int& dest) {
    if (v.isNull()) return false;
    inteiro(v, campo, lo, hi, dest);
    return true;
  }

  void leSensor(JsonVariantConst item, int j, Sensor& sn) {
    const std::string pre = "sen[" + std::to_string(j) + "]";
    if (!item.is<JsonObjectConst>()) {
      campoErrado(pre);
      return;
    }
    JsonObjectConst o = item.as<JsonObjectConst>();
    texto(o["n"], pre + ".n", 24, sn.n);
    simNao(o["en"], pre + ".en", sn.en);
    JsonVariantConst tp = o["tp"];
    if (!tp.isNull()) {
      const char* p = tp.as<const char*>();
      const std::string t = p ? p : "";
      if (t == "dc") sn.ac = false;
      else if (t == "ac") sn.ac = true;
      else campoErrado(pre + ".tp");
    }
    decimal(o["mva"], pre + ".mva", 1, 2000, sn.mva);
    decimal(o["div"], pre + ".div", 0.05, 1, sn.div);
    decimal(o["aj"], pre + ".aj", 0.5, 2, sn.aj);
    inteiro(o["sa"], pre + ".sa", -2, 3, sn.sa);
    decimal(o["min"], pre + ".min", 0, 100, sn.min);
    decimal(o["max"], pre + ".max", 0, 100, sn.max);
    simNao(o["corta"], pre + ".corta", sn.corta);
  }
};

// Escreve a configuração em JSON. paraNvs = true grava o PIN; senão manda só "temPin".
inline void escreveConfig(JsonObject c, const Config& cfg, bool paraNvs) {
  c["v"] = 1;
  c["nome"] = cfg.nome;
  c["tz"] = cfg.tz;
  c["pms"] = cfg.pms;
  c["f2"] = cfg.f2 ? 1 : 0;
  if (paraNvs) c["pin"] = cfg.pin;
  else c["temPin"] = cfg.pin.empty() ? 0 : 1;
  JsonArray sa = c["s"].to<JsonArray>();
  for (int i = 0; i < NUM_SAIDAS; i++) {
    const Saida& sd = cfg.s[i];
    JsonObject o = sa.add<JsonObject>();
    o["n"] = sd.n;
    o["en"] = sd.en ? 1 : 0;
    o["inv"] = sd.inv ? 1 : 0;
    JsonArray ra = o["r"].to<JsonArray>();
    for (int k = 0; k < sd.nr; k++) {
      const agenda::Regra& rg = sd.r[k];
      JsonObject ro = ra.add<JsonObject>();
      if (rg.k == 'f') {
        ro["k"] = "f";
        ro["h"] = rg.h;
        ro["d"] = rg.d;
      } else {
        ro["k"] = "c";
        ro["a"] = rg.a;
        ro["b"] = rg.b;
        ro["on"] = rg.on;
        ro["off"] = rg.off;
      }
      ro["w"] = rg.w;
      ro["en"] = rg.en ? 1 : 0;
    }
  }
  JsonArray se = c["sen"].to<JsonArray>();
  for (int j = 0; j < NUM_SENSORES; j++) {
    const Sensor& sn = cfg.sen[j];
    JsonObject o = se.add<JsonObject>();
    o["n"] = sn.n;
    o["en"] = sn.en ? 1 : 0;
    o["tp"] = sn.ac ? "ac" : "dc";
    o["mva"] = sn.mva;
    o["div"] = sn.div;
    o["aj"] = sn.aj;
    o["sa"] = sn.sa;
    o["min"] = sn.min;
    o["max"] = sn.max;
    o["corta"] = sn.corta ? 1 : 0;
  }
}

inline std::string configParaTexto(const Config& cfg, bool paraNvs) {
  JsonDocument d;
  escreveConfig(d.to<JsonObject>(), cfg, paraNvs);
  std::string txt;
  serializeJson(d, txt);
  return txt;
}

// ===================== Estado =====================

// Estado de cada saída (§5)
struct EstadoSaida {
  bool on = false;        // estado atual (válvula: o último pulso mandado)
  bool mo = false;        // manual: ligado/desligado
  int64_t ma = 0;         // manual até (epoch); 0 = sem manual
  int64_t pa = 0;         // pausada até (epoch); 0 = sem pausa
  bool b = false;         // bloqueada por corrente alta
  int64_t hjMs = 0;       // tempo ligada hoje (ms)
  double pk = -1;         // pico do último pulso (A); -1 = sem medida
  int64_t ligouMs = 0;    // quando ligou (ms desde o boot)
  uint32_t vez = 0;       // conta quantas vezes ligou (para os alarmes)
  bool desejado = false;  // resultado da última conta
  int origem = 0;         // origem do estado desejado
};

// Um pulso esperando na fila das válvulas
struct Pulso {
  int valvula = 0;
  bool abrir = false;
  int origem = 0;
  bool segundo = false;  // 2º pulso de fechar (f2), sem evento
  bool forcado = false;  // fechamento do boot: não pode ser cancelado
  int64_t quandoUs = 0;  // a partir de quando pode ser feito (us)
};

struct Evento {
  int64_t ep = 0;  // 0 = ainda sem hora
  int64_t up = 0;  // segundos desde o boot (para corrigir o ep depois)
  int s = -1;
  int c = 0;
  int o = 0;
  double v = 0;
};

struct Medida {
  double z = 0;        // zero (mV)
  double ruido = 0;    // ruído no zero (desvio padrão, mV)
  double i = 0;        // última corrente (A)
  bool medida = false; // já tem medida desde que foi habilitado
};

struct AlarmeSensor {
  uint32_t vez = 0;
  bool avisou21 = false;
  bool avisou22 = false;
  int64_t baixoDesdeMs = -1;
  int64_t altoDesdeMs = -1;
};

// ===================== O núcleo =====================
class Nucleo {
 public:
  explicit Nucleo(Hal& h) : hal(h) {}

  // ---------- chamado pelo .ino ----------

  // Boot: carrega configuração, deixa tudo desligado, zera sensores, fecha as válvulas.
  void inicia() {
    idPlaca = hal.idPlaca();
    poePadrao(cfg, idPlaca);
    carregaConfig();
    carregaEstado();
    desligaReles();  // relés soltos (INPUT) até o programa mandar ligar
    for (int v = 0; v < NUM_VALVULAS; v++) hal.ponte(v, 0);
    ledAceso = false;
    hal.led(false);

    // primeira leitura da hora (sem correções)
    agora = hal.epoch();
    horaValida = agora >= HORA_VALIDA;
    ultimoEp = agora;
    ultimoEpMs = ms();

    zera();  // tudo desligado: bom momento para achar o zero dos sensores
    registra(10, -1, ORIGEM_INICIO, 0);

    // fecha as duas válvulas (não sabemos a posição real)
    for (int v = 0; v < NUM_VALVULAS; v++) {
      Pulso p;
      p.valvula = v;
      p.abrir = false;
      p.origem = ORIGEM_INICIO;
      p.forcado = true;
      p.quandoUs = hal.us();
      fila.push_back(p);
    }
    const int64_t t = ms();
    ultimoTickMs = t;
    proxTickMs = t;
    proxJanelaMs = t;
    hal.log(std::string("Controlador ligado. Nome: ") + cfg.nome +
            (horaValida ? " (hora ok)" : " (sem hora)"));
  }

  // Chamar sempre no loop().
  void passo() {
    while (!entrada.empty()) {
      std::string linha = entrada.front();
      entrada.pop_front();
      trataLinha(linha);
    }
    int64_t t = ms();
    if (t >= proxTickMs) {
      proxTickMs += TICK_MS;
      if (proxTickMs <= t) proxTickMs = t + TICK_MS;
      tick();
    }
    fazPulso();
    t = ms();
    if (t >= proxJanelaMs) {
      proxJanelaMs += CICLO_MEDIDA_MS;
      if (proxJanelaMs <= t) proxJanelaMs = t + CICLO_MEDIDA_MS;
      janela();
    }
    botao();
    atualizaLed();
    if (reiniciarEmMs >= 0 && ms() >= reiniciarEmMs) {
      reiniciarEmMs = -1;
      hal.log("Reiniciando...");
      desligaReles();
      hal.reinicia();
    }
  }

  void conectou(int mtuNovo) {
    conectado = true;
    autenticado = false;
    mtu = mtuNovo;
    hal.log("Celular conectado");
  }
  void mudouMtu(int mtuNovo) { mtu = mtuNovo; }
  void desconectou() {
    if (conectado) hal.log("Celular desconectado");
    conectado = false;
    autenticado = false;
    entrada.clear();
  }

  // Uma linha que chegou do app (sem o \n).
  void recebeLinha(const std::string& linha) {
    if (linha.size() > MAX_LINHA) {
      hal.log("Linha grande demais: descartada");
      return;
    }
    if (entrada.size() >= MAX_FILA_ENTRADA) {
      hal.log("Muitas mensagens de uma vez: descartada");
      return;
    }
    entrada.push_back(linha);
  }

  const Config& config() const { return cfg; }
  bool estaConectado() const { return conectado; }
  int mtuAtual() const { return mtu; }

 private:
  Hal& hal;
  Config cfg;
  std::string idPlaca;
  EstadoSaida est[NUM_SAIDAS];
  Medida med[NUM_SENSORES];
  AlarmeSensor alarmes[NUM_SENSORES];
  std::vector<Pulso> fila;
  std::deque<std::string> entrada;
  Evento eventos[MAX_EVENTOS];
  int inicioEv = 0;
  int qtdEv = 0;
  std::string ultimoEstGravado;

  // hora
  int64_t agora = 0;
  bool horaValida = false;
  int64_t ultimoEp = 0;
  int64_t ultimoEpMs = 0;
  int64_t diaAtual = SEM_DIA;

  // agenda interna
  int64_t ultimoTickMs = 0;
  int64_t proxTickMs = 0;
  int64_t proxJanelaMs = 0;
  int64_t fimUltimoPulsoUs = -1000000000;
  int64_t reiniciarEmMs = -1;

  // conexão
  bool conectado = false;
  bool autenticado = false;
  int falhasPin = 0;          // PINs errados seguidos (vale para todas as conexões, §7.1)
  int64_t travaPinAteMs = 0;  // até quando "auth" é recusado (ms desde o boot)
  int mtu = 23;

  // botão e LED
  bool botaoCru = false;
  bool botaoFirme = false;
  int64_t botaoMudouMs = 0;
  int64_t botaoApertouMs = 0;
  bool botaoJaAgiu = false;
  bool ledAceso = false;

  // ---------- tempo ----------
  int64_t ms() { return hal.us() / 1000; }

  // Lê a hora do sistema. Se ela acabou de ficar válida, corrige o que foi
  // guardado com a hora de antes (eventos, manual e pausa).
  void atualizaHora() {
    const int64_t ep = hal.epoch();
    const int64_t t = ms();
    const bool valida = ep >= HORA_VALIDA;
    if (valida && !horaValida) {
      const int64_t antigo = ultimoEp + (t - ultimoEpMs) / 1000;
      corrigeHora(ep, antigo);
    }
    agora = ep;
    horaValida = valida;
    ultimoEp = ep;
    ultimoEpMs = t;
  }

  void corrigeHora(int64_t novo, int64_t antigo) {
    const int64_t upAgora = ms() / 1000;
    int corrigidos = 0;
    for (int k = 0; k < qtdEv; k++) {
      Evento& e = eventos[(inicioEv + k) % MAX_EVENTOS];
      if (e.ep == 0) {
        e.ep = novo - (upAgora - e.up);
        corrigidos++;
      }
    }
    // manual/pausa marcados com a hora inválida: passam para a hora certa
    const int64_t desloc = novo - antigo;
    bool mudouEst = false;
    for (int s = 0; s < NUM_SAIDAS; s++) {
      if (est[s].ma > 0 && est[s].ma < HORA_VALIDA) est[s].ma += desloc;
      if (est[s].pa > 0 && est[s].pa < HORA_VALIDA) {
        est[s].pa += desloc;
        mudouEst = true;
      }
    }
    if (mudouEst) gravaEstado();
    hal.log("Hora ficou valida. Eventos corrigidos: " + std::to_string(corrigidos));
  }

  // ---------- a cada segundo ----------
  void tick() {
    atualizaHora();
    const int64_t t = ms();
    int64_t dt = t - ultimoTickMs;
    if (dt < 0) dt = 0;
    ultimoTickMs = t;
    if (horaValida) {
      const int64_t D = agenda::divChao(agora + static_cast<int64_t>(cfg.tz) * 60, agenda::SEG_DIA);
      if (D != diaAtual) {
        if (diaAtual != SEM_DIA) {
          for (int s = 0; s < NUM_SAIDAS; s++) est[s].hjMs = 0;  // virou o dia
        }
        diaAtual = D;
      }
    }
    for (int s = 0; s < NUM_SAIDAS; s++) {
      if (est[s].on) est[s].hjMs += dt;
    }
    avalia();
    if (online()) enviaSt();
  }

  // Calcula o estado desejado de cada saída (§5) e aplica.
  void avalia() {
    bool mudouEst = false;
    for (int s = 0; s < NUM_SAIDAS; s++) {
      EstadoSaida& e = est[s];
      if (e.ma != 0 && agora >= e.ma) {  // manual venceu: volta ao programa
        e.ma = 0;
        e.mo = false;
      }
      if (e.pa != 0 && agora >= e.pa) {  // pausa acabou
        e.pa = 0;
        mudouEst = true;
      }
    }
    if (mudouEst) gravaEstado();
    const int64_t L = agora + static_cast<int64_t>(cfg.tz) * 60;
    for (int s = 0; s < NUM_SAIDAS; s++) {
      EstadoSaida& e = est[s];
      bool quer = false;
      int o = ORIGEM_PROGRAMA;
      if (!cfg.s[s].en) {
        o = ORIGEM_DESABILITADA;
      } else if (e.b) {
        o = ORIGEM_BLOQUEIO;
      } else if (e.ma != 0) {
        quer = e.mo;
        o = ORIGEM_MANUAL;
      } else if (e.pa != 0) {
        o = ORIGEM_PAUSA;
      } else if (!horaValida) {
        o = ORIGEM_PROGRAMA;
      } else {
        quer = agenda::programaAtivo(cfg.s[s].r, cfg.s[s].nr, L);
        o = ORIGEM_PROGRAMA;
      }
      e.desejado = quer;
      e.origem = o;
      if (s >= NUM_VALVULAS) aplicaRele(s, quer, o);
      else pedeValvula(s, quer, o);
    }
  }

  // ---------- relés ----------
  // Desligado = pino solto (INPUT); ligado = OUTPUT no nível certo (§1).
  void poeRele(int s, bool ligado) { hal.rele(s - NUM_VALVULAS, ligado, cfg.s[s].inv); }

  void aplicaRele(int s, bool quer, int o) {
    EstadoSaida& e = est[s];
    if (quer == e.on) return;
    e.on = quer;
    poeRele(s, quer);
    if (quer) {
      e.ligouMs = ms();
      e.vez++;
    }
    registra(quer ? 1 : 2, s, o, 0);
  }
  void reaplicaReles() {
    for (int s = NUM_VALVULAS; s < NUM_SAIDAS; s++) poeRele(s, est[s].on);
  }
  void desligaReles() {
    for (int s = NUM_VALVULAS; s < NUM_SAIDAS; s++) poeRele(s, false);
  }

  // ---------- válvulas (fila de pulsos) ----------
  // Regra: a fila nunca faz um pulso que contrarie o último estado mandado para a
  // válvula. A única exceção é o fechamento do boot (não sabemos a posição real):
  // ele sempre é feito, e um "abrir" pedido logo depois vai para a fila atrás dele.

  // Último estado mandado: como a válvula vai ficar depois de tudo que está na fila.
  bool estadoFinal(int v) const {
    bool f = est[v].on;
    for (const Pulso& p : fila) {
      if (p.valvula == v && !p.segundo) f = p.abrir;
    }
    return f;
  }
  void tiraSegundos(int v) {
    for (size_t i = 0; i < fila.size();) {
      if (fila[i].valvula == v && fila[i].segundo) fila.erase(fila.begin() + i);
      else i++;
    }
  }
  void pedeValvula(int v, bool quer, int o) {
    if (quer == estadoFinal(v)) return;
    // se o último pedido ainda não foi feito, basta cancelá-lo
    int idx = -1;
    for (size_t i = 0; i < fila.size(); i++) {
      if (fila[i].valvula == v && !fila[i].segundo) idx = static_cast<int>(i);
    }
    if (idx >= 0 && !fila[idx].forcado) {
      fila.erase(fila.begin() + idx);
      if (quer == estadoFinal(v)) {
        if (quer) tiraSegundos(v);
        return;
      }
    }
    Pulso p;
    p.valvula = v;
    p.abrir = quer;
    p.origem = o;
    p.quandoUs = hal.us();
    fila.push_back(p);
    if (quer) tiraSegundos(v);
  }

  // Faz um pulso da fila, se já pode (um de cada vez, com 300 ms de folga).
  void fazPulso() {
    if (fila.empty()) return;
    const int64_t t = hal.us();
    if (t < fimUltimoPulsoUs + INTERVALO_PULSOS_US) return;
    int escolhido = -1;
    for (size_t i = 0; i < fila.size(); i++) {
      if (fila[i].quandoUs > t) continue;
      if (escolhido < 0 || fila[i].quandoUs < fila[escolhido].quandoUs) escolhido = static_cast<int>(i);
    }
    if (escolhido < 0) return;
    const Pulso p = fila[escolhido];
    fila.erase(fila.begin() + escolhido);
    if (p.segundo && estadoFinal(p.valvula)) {
      // a válvula foi mandada abrir depois daquele fechamento: o 2º pulso não vale mais
      hal.log("2º pulso de fechar cancelado (a válvula foi mandada abrir)");
      return;
    }
    executaPulso(p);
  }

  void executaPulso(const Pulso& p) {
    const int v = p.valvula;
    // abrir = lado A; com inv = 1 troca
    const int lado = (p.abrir != cfg.s[v].inv) ? 1 : 2;
    int lista[NUM_SENSORES];
    int n = 0;
    for (int j = 0; j < NUM_SENSORES; j++) {
      if (cfg.sen[j].en && cfg.sen[j].sa == -2) lista[n++] = j;
    }
    double pico[NUM_SENSORES] = {0, 0};
    double ultimas[NUM_SENSORES][4] = {{0, 0, 0, 0}, {0, 0, 0, 0}};
    int conta[NUM_SENSORES] = {0, 0};

    // ----- pulso: liga um lado, lê o sensor, desliga os dois -----
    hal.ponte(v, lado);
    const int64_t t0 = hal.us();
    const int64_t fim = t0 + static_cast<int64_t>(cfg.pms) * 1000;
    if (n > 0) {
      for (int64_t k = 0;; k++) {
        const int64_t alvo = t0 + k * PASSO_AMOSTRA_US;
        if (alvo >= fim) break;
        hal.esperaAte(alvo);
        const int j = lista[k % n];
        ultimas[j][conta[j] % 4] = hal.leMv(j);
        conta[j]++;
        // pico da média das últimas 4 leituras (tira picos falsos do ADC)
        if (conta[j] >= 4) {
          const double media = (ultimas[j][0] + ultimas[j][1] + ultimas[j][2] + ultimas[j][3]) / 4.0;
          const double a = correntePico(j, media);
          if (a > pico[j]) pico[j] = a;
        }
      }
    }
    hal.esperaAte(fim);
    hal.ponte(v, 0);
    // ----- fim do pulso -----

    fimUltimoPulsoUs = hal.us();
    for (int q = 0; q < n; q++) {
      const int j = lista[q];
      if (conta[j] > 0 && conta[j] < 4) {  // pulso curto demais: usa a média do que leu
        double soma = 0;
        for (int k = 0; k < conta[j]; k++) soma += ultimas[j][k];
        pico[j] = correntePico(j, soma / conta[j]);
      }
    }
    if (p.segundo) return;  // 2º pulso de fechar: sem evento

    EstadoSaida& e = est[v];
    e.on = p.abrir;
    if (p.abrir) {
      e.ligouMs = ms();
      e.vez++;
    }
    double v1 = 0;
    if (n > 0) {
      double maior = 0;
      for (int q = 0; q < n; q++) maior = std::max(maior, pico[lista[q]]);
      e.pk = r3(maior);
      v1 = e.pk;
    }
    registra(p.abrir ? 1 : 2, v, p.origem, v1);
    for (int q = 0; q < n; q++) {
      const Sensor& sn = cfg.sen[lista[q]];
      if (sn.min > 0 && pico[lista[q]] < sn.min) {
        registra(20, v, p.origem, r3(pico[lista[q]]));  // pulso sem corrente
        break;
      }
    }
    tiraSegundos(v);  // um 2º pulso antigo desta válvula não vale mais
    // 2º pulso de fechar só se ninguém mandou abrir de novo enquanto isso
    if (!p.abrir && cfg.f2 && !estadoFinal(v)) {
      Pulso p2;
      p2.valvula = v;
      p2.abrir = false;
      p2.origem = p.origem;
      p2.segundo = true;
      p2.quandoUs = fimUltimoPulsoUs + ATRASO_F2_US;
      fila.push_back(p2);
    }
  }

  // ---------- corrente (§6.1) ----------
  double sens(int j) const { return cfg.sen[j].mva * cfg.sen[j].div; }

  double correntePico(int j, double mv) const {
    return std::fabs(mv - med[j].z) / sens(j) * cfg.sen[j].aj;
  }

  double calculaCorrente(int j, double soma, double soma2, long n) const {
    const Sensor& sn = cfg.sen[j];
    const double media = soma / n;
    if (!sn.ac) {
      double I = (media - med[j].z) / sens(j) * sn.aj;
      const double zonaMorta = std::max(0.01, 3.0 * med[j].ruido / sens(j) * sn.aj);
      if (std::fabs(I) < zonaMorta) I = 0;
      return I;
    }
    double rms2 = soma2 / n - media * media;  // variância = rms² sem a parte contínua
    if (rms2 < 0) rms2 = 0;
    const double limpo = std::max(0.0, rms2 - med[j].ruido * med[j].ruido);
    return std::sqrt(limpo) / sens(j) * sn.aj;
  }

  // Janela de 100 ms lendo os sensores habilitados, um de cada vez.
  void janela() {
    int lista[NUM_SENSORES];
    int n = 0;
    for (int j = 0; j < NUM_SENSORES; j++) {
      if (cfg.sen[j].en) lista[n++] = j;
      else med[j].medida = false;
    }
    if (n > 0) {
      double soma[NUM_SENSORES] = {0, 0};
      double soma2[NUM_SENSORES] = {0, 0};
      long conta[NUM_SENSORES] = {0, 0};
      const int64_t t0 = hal.us();
      for (int64_t k = 0;; k++) {
        const int64_t alvo = t0 + k * PASSO_AMOSTRA_US;
        if (alvo >= t0 + JANELA_US) break;
        hal.esperaAte(alvo);
        const int j = lista[k % n];
        const double v = hal.leMv(j);
        soma[j] += v;
        soma2[j] += v * v;
        conta[j]++;
      }
      for (int q = 0; q < n; q++) {
        const int j = lista[q];
        if (conta[j] > 0) {
          med[j].i = calculaCorrente(j, soma[j], soma2[j], conta[j]);
          med[j].medida = true;
        }
      }
      checaAlarmes();
    }
    if (online()) enviaI();
  }

  // Zerar: mede 1 s com tudo desligado e guarda zero e ruído de cada sensor.
  void zera() {
    double soma[NUM_SENSORES] = {0, 0};
    double soma2[NUM_SENSORES] = {0, 0};
    long conta[NUM_SENSORES] = {0, 0};
    const int64_t t0 = hal.us();
    for (int64_t k = 0;; k++) {
      const int64_t alvo = t0 + k * PASSO_AMOSTRA_US;
      if (alvo >= t0 + ZERO_US) break;
      hal.esperaAte(alvo);
      const int j = static_cast<int>(k % NUM_SENSORES);
      const double v = hal.leMv(j);
      soma[j] += v;
      soma2[j] += v * v;
      conta[j]++;
    }
    for (int j = 0; j < NUM_SENSORES; j++) {
      if (conta[j] == 0) continue;
      const double media = soma[j] / conta[j];
      const double var = soma2[j] / conta[j] - media * media;
      med[j].z = media;
      med[j].ruido = std::sqrt(var > 0 ? var : 0);
      med[j].medida = false;
      char txt[96];
      snprintf(txt, sizeof(txt), "Sensor %d zerado: zero %.1f mV, ruido %.2f mV", j + 1, med[j].z,
               med[j].ruido);
      hal.log(txt);
    }
  }

  // ---------- alarmes (§6.2) ----------
  void checaAlarmes() {
    const int64_t t = ms();
    for (int j = 0; j < NUM_SENSORES; j++) {
      const Sensor& sn = cfg.sen[j];
      AlarmeSensor& a = alarmes[j];
      if (!sn.en || sn.sa < 0 || sn.sa >= NUM_SAIDAS || !med[j].medida) {
        a.baixoDesdeMs = -1;
        a.altoDesdeMs = -1;
        continue;
      }
      const int s = sn.sa;
      EstadoSaida& e = est[s];
      if (a.vez != e.vez) {  // a saída ligou de novo: alarmes podem avisar de novo
        a.vez = e.vez;
        a.avisou21 = false;
        a.avisou22 = false;
        a.baixoDesdeMs = -1;
        a.altoDesdeMs = -1;
      }
      if (!e.on) {
        a.baixoDesdeMs = -1;
        a.altoDesdeMs = -1;
        continue;
      }
      const double I = std::fabs(med[j].i);
      // 21: ligada há 5 s ou mais e sem corrente por 3 s
      if (sn.min > 0 && t - e.ligouMs >= CARENCIA_21_MS && I < sn.min) {
        if (a.baixoDesdeMs < 0) a.baixoDesdeMs = t;
        if (!a.avisou21 && t - a.baixoDesdeMs >= TEMPO_21_MS) {
          a.avisou21 = true;
          registra(21, s, e.origem, r3(I));
        }
      } else {
        a.baixoDesdeMs = -1;
      }
      // 22: corrente alta por 2 s (e 23: bloqueia, se "corta")
      if (sn.max > 0 && I > sn.max) {
        if (a.altoDesdeMs < 0) a.altoDesdeMs = t;
        if (!a.avisou22 && t - a.altoDesdeMs >= TEMPO_22_MS) {
          a.avisou22 = true;
          registra(22, s, e.origem, r3(I));
          if (sn.corta && !e.b) {
            e.b = true;
            gravaEstado();
            registra(23, s, ORIGEM_BLOQUEIO, r3(I));
            avalia();
            if (online()) enviaSt();
          }
        }
      } else {
        a.altoDesdeMs = -1;
      }
    }
  }

  // ---------- eventos (§8.3) ----------
  void registra(int c, int s, int o, double v) {
    atualizaHora();
    Evento e;
    e.ep = horaValida ? agora : 0;
    e.up = ms() / 1000;
    e.s = s;
    e.c = c;
    e.o = o;
    e.v = v;
    if (qtdEv < MAX_EVENTOS) {
      eventos[(inicioEv + qtdEv) % MAX_EVENTOS] = e;
      qtdEv++;
    } else {
      eventos[inicioEv] = e;  // cheio: substitui o mais antigo
      inicioEv = (inicioEv + 1) % MAX_EVENTOS;
    }
    char txt[80];
    snprintf(txt, sizeof(txt), "Evento %d saida %d origem %d valor %.3f", c, s, o, v);
    hal.log(txt);
    if (online()) {
      JsonDocument d;
      d["t"] = "ev";
      escreveEvento(d["e"].to<JsonArray>(), e);
      envia(d);
    }
  }
  static void escreveEvento(JsonArray a, const Evento& e) {
    a.add(e.ep);
    a.add(e.s);
    a.add(e.c);
    a.add(e.o);
    a.add(r3(e.v));
  }

  // ---------- gravação no NVS ----------
  void carregaConfig() {
    std::string txt;
    if (!hal.nvsLe("cfg", txt) || txt.empty()) {
      hal.log("Sem configuração gravada: usando a padrão");
      return;
    }
    JsonDocument d;
    if (deserializeJson(d, txt) || !d.is<JsonObject>()) {
      hal.log("Configuração gravada com defeito: usando a padrão");
      return;
    }
    std::unique_ptr<Config> c(new Config(cfg));  // no heap: a Config é grande para a pilha
    LeitorConfig leitor;
    if (leitor.aplica(d.as<JsonObjectConst>(), *c)) cfg = std::move(*c);
    else hal.log("Configuração gravada com defeito (" + leitor.erro + "): usando a padrão");
  }
  bool gravaConfig(const Config& c) {
    const std::string txt = configParaTexto(c, true);
    if (txt.size() > MAX_NVS) return false;
    return hal.nvsGrava("cfg", txt);
  }
  void carregaEstado() {
    std::string txt;
    if (!hal.nvsLe("est", txt) || txt.empty()) return;
    JsonDocument d;
    if (deserializeJson(d, txt) || !d.is<JsonObject>()) {
      hal.log("Pausas/bloqueios gravados com defeito: ignorados");
      return;
    }
    JsonArrayConst pa = d["pa"];
    JsonArrayConst b = d["b"];
    for (int s = 0; s < NUM_SAIDAS; s++) {
      double x = 0;
      if (leNumero(pa[s], x) == Leitura::Ok && x > 0 && x < HORA_MAXIMA) est[s].pa = static_cast<int64_t>(x);
      if (leNumero(b[s], x, true) == Leitura::Ok) est[s].b = (x != 0);
    }
    ultimoEstGravado = txt;
  }
  void gravaEstado() {
    JsonDocument d;
    JsonArray pa = d["pa"].to<JsonArray>();
    JsonArray b = d["b"].to<JsonArray>();
    for (int s = 0; s < NUM_SAIDAS; s++) {
      pa.add(est[s].pa);
      b.add(est[s].b ? 1 : 0);
    }
    std::string txt;
    serializeJson(d, txt);
    if (txt == ultimoEstGravado) return;  // nada mudou: poupa o NVS
    if (hal.nvsGrava("est", txt)) ultimoEstGravado = txt;
    else hal.log("Erro ao gravar pausas/bloqueios");
  }

  // ---------- envio ----------
  bool precisaPin() const { return !cfg.pin.empty(); }
  bool online() const { return conectado && (autenticado || !precisaPin()); }

  void envia(JsonDocument& d) {
    if (!conectado) return;
    std::string txt;
    serializeJson(d, txt);
    hal.envia(txt);
  }
  void enviaOk(const std::string& r) {
    JsonDocument d;
    d["t"] = "ok";
    d["r"] = r;
    envia(d);
  }
  void enviaErro(const std::string& r, const std::string& m) {
    JsonDocument d;
    d["t"] = "err";
    d["r"] = r;
    d["m"] = m;
    envia(d);
  }
  void escreveCorrentes(JsonArray a) {
    for (int j = 0; j < NUM_SENSORES; j++) {
      if (cfg.sen[j].en) a.add(med[j].medida ? r3(med[j].i) : 0.0);
      else a.add<JsonVariant>();  // null
    }
  }
  bool temSensorPulso() const {
    for (int j = 0; j < NUM_SENSORES; j++) {
      if (cfg.sen[j].en && cfg.sen[j].sa == -2) return true;
    }
    return false;
  }
  void enviaSt() {
    atualizaHora();
    JsonDocument d;
    d["t"] = "st";
    d["ep"] = horaValida ? agora : 0;
    d["hv"] = horaValida ? 1 : 0;
    d["up"] = ms() / 1000;
    d["rtc"] = hal.temRtc() ? 1 : 0;
    JsonArray sa = d["s"].to<JsonArray>();
    const bool comPico = temSensorPulso();
    for (int s = 0; s < NUM_SAIDAS; s++) {
      const EstadoSaida& e = est[s];
      JsonObject o = sa.add<JsonObject>();
      o["on"] = e.on ? 1 : 0;
      o["mo"] = (e.ma != 0 && e.mo) ? 1 : 0;
      o["ma"] = e.ma;
      o["pa"] = e.pa;
      o["b"] = e.b ? 1 : 0;
      o["hj"] = e.hjMs / 1000;
      o["pk"] = (s < NUM_VALVULAS && comPico) ? e.pk : -1;
    }
    escreveCorrentes(d["i"].to<JsonArray>());
    envia(d);
  }
  void enviaI() {
    JsonDocument d;
    d["t"] = "i";
    escreveCorrentes(d["i"].to<JsonArray>());
    envia(d);
  }
  void enviaCfg() {
    JsonDocument d;
    d["t"] = "cfg";
    escreveConfig(d["c"].to<JsonObject>(), cfg, false);
    envia(d);
  }

  // ---------- comandos do app (§8.1) ----------
  void trataLinha(std::string linha) {
    while (!linha.empty() && (linha.back() == '\r' || linha.back() == ' ' || linha.back() == '\t')) linha.pop_back();
    if (linha.empty()) return;
    JsonDocument doc;
    if (deserializeJson(doc, linha) || !doc.is<JsonObject>()) {
      enviaErro("", "Mensagem inválida");
      return;
    }
    const char* tp = doc["t"].as<const char*>();
    const std::string t = tp ? tp : "";
    if (t.empty()) {
      enviaErro("", "Falta o tipo da mensagem (t)");
      return;
    }
    atualizaHora();
    if (precisaPin() && !autenticado && t != "oi" && t != "auth") {
      enviaErro(t, "pin");
      return;
    }
    if (t == "oi") cmdOi();
    else if (t == "auth") cmdAuth(doc);
    else if (t == "hora") cmdHora(doc);
    else if (t == "cfg?") enviaCfg();
    else if (t == "cfg") cmdCfg(doc);
    else if (t == "man") cmdMan(doc);
    else if (t == "pausa") cmdPausa(doc);
    else if (t == "lib") cmdLib(doc);
    else if (t == "zero") cmdZero();
    else if (t == "log?") cmdLog(doc);
    else if (t == "reiniciar") cmdReiniciar();
    else enviaErro(t, "Comando desconhecido");
  }

  // Lê um inteiro dentro dos limites; false se faltou ou está errado.
  static bool campoInteiro(JsonVariantConst v, int64_t lo, int64_t hi, int64_t& dest) {
    double x = 0;
    if (leNumero(v, x) != Leitura::Ok) return false;
    x = std::round(x);
    if (x < static_cast<double>(lo) || x > static_cast<double>(hi)) return false;
    dest = static_cast<int64_t>(x);
    return true;
  }

  void cmdOi() {
    JsonDocument d;
    d["t"] = "oi";
    d["fw"] = VERSAO_FW;
    d["id"] = idPlaca;
    d["nome"] = cfg.nome;
    d["mtu"] = mtu;
    d["pin"] = precisaPin() ? 1 : 0;
    d["hv"] = horaValida ? 1 : 0;
    d["rtc"] = hal.temRtc() ? 1 : 0;
    d["ep"] = horaValida ? agora : 0;
    envia(d);
  }

  // §7.1: 5 PINs errados seguidos → desconecta e recusa qualquer "auth" por 60 s
  // (a trava fica em memória e vale também para as próximas conexões).
  void cmdAuth(JsonDocument& doc) {
    JsonDocument d;
    d["t"] = "auth";
    if (!precisaPin()) {
      autenticado = true;
      d["ok"] = 1;
      envia(d);
      return;
    }
    const int64_t t = ms();
    if (t < travaPinAteMs) {  // travado: nem confere o PIN
      d["ok"] = 0;
      d["espera"] = (travaPinAteMs - t + 999) / 1000;  // segundos que faltam (arredonda para cima)
      envia(d);
      return;
    }
    const char* p = doc["pin"].as<const char*>();
    if (p != nullptr && cfg.pin == p) {
      autenticado = true;
      falhasPin = 0;
      d["ok"] = 1;
      envia(d);
      return;
    }
    falhasPin++;
    d["ok"] = 0;
    const bool travar = (falhasPin >= MAX_FALHAS_PIN);
    if (travar) {
      falhasPin = 0;  // depois da trava, mais 5 tentativas
      travaPinAteMs = t + TRAVA_PIN_MS;
      d["espera"] = TRAVA_PIN_MS / 1000;
    }
    envia(d);
    hal.log("PIN errado (" + std::to_string(travar ? MAX_FALHAS_PIN : falhasPin) + ")");
    if (travar) {
      hal.log("PIN errado 5 vezes: desconectando e recusando o PIN por 60 s");
      hal.desconecta();
      desconectou();
    }
  }

  void cmdHora(JsonDocument& doc) {
    int64_t ep = 0;
    if (!campoInteiro(doc["ep"], HORA_VALIDA, HORA_MAXIMA, ep)) {
      enviaErro("hora", "Hora inválida");
      return;
    }
    if (ep > HORA_MAXIMA_RELOGIO) {  // só no núcleo 2.x (time_t de 32 bits)
      enviaErro("hora", "Esta placa só aceita datas até 2038 (grave o firmware com o pacote esp32 versão 3)");
      return;
    }
    int64_t tz = cfg.tz;
    const bool temTz = !doc["tz"].isNull();
    if (temTz && !campoInteiro(doc["tz"], -720, 840, tz)) {
      enviaErro("hora", "Fuso horário inválido");
      return;
    }
    const int64_t antigo = hal.epoch();
    const bool eraValida = antigo >= HORA_VALIDA;
    ultimoEp = antigo;
    ultimoEpMs = ms();
    hal.acertaRelogio(ep);
    atualizaHora();  // corrige eventos/manual/pausa se a hora era inválida
    if (!eraValida) registra(11, -1, ORIGEM_MANUAL, 0);
    else if (ep - antigo > 60 || antigo - ep > 60) registra(11, -1, ORIGEM_MANUAL, static_cast<double>(ep - antigo));
    if (temTz && tz != cfg.tz) {  // fuso mudou: grava na configuração
      cfg.tz = static_cast<int>(tz);
      if (!gravaConfig(cfg)) hal.log("Erro ao gravar o fuso");
    }
    hal.log("Hora acertada pelo app");
    avalia();
    enviaOk("hora");
    enviaSt();
  }

  void cmdCfg(JsonDocument& doc) {
    JsonVariantConst c = doc["c"];
    if (!c.is<JsonObjectConst>()) {
      enviaErro("cfg", "Falta a configuração (c)");
      return;
    }
    std::unique_ptr<Config> nova(new Config(cfg));  // no heap: a Config é grande para a pilha
    LeitorConfig leitor;
    if (!leitor.aplica(c.as<JsonObjectConst>(), *nova)) {
      enviaErro("cfg", leitor.erro);
      return;
    }
    if (configParaTexto(*nova, true).size() > MAX_NVS) {
      enviaErro("cfg", "Configuração grande demais");
      return;
    }
    if (!gravaConfig(*nova)) {
      enviaErro("cfg", "Não foi possível gravar a configuração");
      return;
    }
    cfg = std::move(*nova);
    autenticado = true;  // quem mudou a configuração (e talvez o PIN) continua liberado
    reaplicaReles();     // "inv" pode ter mudado
    registra(12, -1, ORIGEM_MANUAL, 0);
    hal.log("Configuração salva");
    avalia();
    enviaOk("cfg");
    enviaCfg();
    enviaSt();
  }

  void cmdMan(JsonDocument& doc) {
    int64_t s = 0;
    int64_t ate = 0;
    double on = 0;
    if (!campoInteiro(doc["s"], 0, NUM_SAIDAS - 1, s)) {
      enviaErro("man", "Saída inválida (use 0 a 3)");
      return;
    }
    if (!campoInteiro(doc["ate"], 0, HORA_MAXIMA, ate)) {
      enviaErro("man", "Horário final inválido");
      return;
    }
    EstadoSaida& e = est[s];
    if (ate == 0) {
      e.ma = 0;  // cancela: volta ao programa
      e.mo = false;
    } else {
      if (leNumero(doc["on"], on, true) != Leitura::Ok) {
        enviaErro("man", "Falta o campo on (0 ou 1)");
        return;
      }
      if (ate <= agora) {
        enviaErro("man", "Esse horário já passou");
        return;
      }
      e.ma = ate;
      e.mo = (on != 0);
      if (e.mo && e.b) {  // ligar na mão tira o bloqueio
        e.b = false;
        gravaEstado();
        registra(24, static_cast<int>(s), ORIGEM_MANUAL, 0);
      }
    }
    avalia();
    enviaOk("man");
    enviaSt();
  }

  void cmdPausa(JsonDocument& doc) {
    int64_t s = 0;
    int64_t ate = 0;
    if (!campoInteiro(doc["s"], -1, NUM_SAIDAS - 1, s)) {
      enviaErro("pausa", "Saída inválida (use -1 a 3)");
      return;
    }
    if (!campoInteiro(doc["ate"], 0, HORA_MAXIMA, ate)) {
      enviaErro("pausa", "Horário final inválido");
      return;
    }
    const int de = (s < 0) ? 0 : static_cast<int>(s);
    const int ateS = (s < 0) ? NUM_SAIDAS - 1 : static_cast<int>(s);
    if (ate == 0) {
      bool tinha = false;
      for (int k = de; k <= ateS; k++) {
        if (est[k].pa != 0) tinha = true;
        est[k].pa = 0;
      }
      gravaEstado();
      if (tinha) registra(14, static_cast<int>(s), ORIGEM_MANUAL, 0);
    } else {
      if (ate <= agora) {
        enviaErro("pausa", "Esse horário já passou");
        return;
      }
      for (int k = de; k <= ateS; k++) {
        est[k].pa = ate;
        est[k].ma = 0;  // pausar cancela o manual
        est[k].mo = false;
      }
      gravaEstado();
      registra(13, static_cast<int>(s), ORIGEM_MANUAL, r2(static_cast<double>(ate - agora) / 3600.0));
    }
    avalia();
    enviaOk("pausa");
    enviaSt();
  }

  void cmdLib(JsonDocument& doc) {
    int64_t s = 0;
    if (!campoInteiro(doc["s"], -1, NUM_SAIDAS - 1, s)) {
      enviaErro("lib", "Saída inválida (use 0 a 3)");
      return;
    }
    const int de = (s < 0) ? 0 : static_cast<int>(s);
    const int ateS = (s < 0) ? NUM_SAIDAS - 1 : static_cast<int>(s);
    for (int k = de; k <= ateS; k++) {
      if (!est[k].b) continue;
      est[k].b = false;
      registra(24, k, ORIGEM_MANUAL, 0);
    }
    gravaEstado();
    avalia();
    enviaOk("lib");
    enviaSt();
  }

  void cmdZero() {
    for (int s = 0; s < NUM_SAIDAS; s++) {
      if (est[s].on) {
        enviaErro("zero", "Desligue todas as saídas antes de zerar");
        return;
      }
    }
    zera();
    registra(30, -1, ORIGEM_MANUAL, 0);
    enviaOk("zero");
  }

  void cmdLog(JsonDocument& doc) {
    int64_t de = 0;
    if (!doc["de"].isNull() && !campoInteiro(doc["de"], 0, HORA_MAXIMA, de)) {
      enviaErro("log?", "Valor inválido no campo de");
      return;
    }
    std::vector<int> escolhidos;
    for (int k = 0; k < qtdEv; k++) {
      const int idx = (inicioEv + k) % MAX_EVENTOS;
      if (eventos[idx].ep >= de) escolhidos.push_back(idx);
    }
    size_t pos = 0;
    do {
      JsonDocument d;
      d["t"] = "log";
      JsonArray l = d["l"].to<JsonArray>();
      for (int q = 0; q < EVENTOS_POR_LOG && pos < escolhidos.size(); q++, pos++) {
        escreveEvento(l.add<JsonArray>(), eventos[escolhidos[pos]]);
      }
      d["fim"] = (pos >= escolhidos.size()) ? 1 : 0;
      envia(d);
    } while (pos < escolhidos.size());
  }

  void cmdReiniciar() {
    enviaOk("reiniciar");
    reiniciarEmMs = ms() + ATRASO_REINICIO_MS;
  }

  // ---------- botão BOOT (§6.4) ----------
  void botao() {
    const bool cru = hal.botaoApertado();
    const int64_t t = ms();
    if (cru != botaoCru) {
      botaoCru = cru;
      botaoMudouMs = t;
    }
    if (cru != botaoFirme && t - botaoMudouMs >= BOTAO_FILTRO_MS) {
      botaoFirme = cru;
      if (cru) {
        botaoApertouMs = botaoMudouMs;
        botaoJaAgiu = false;
      }
    }
    if (botaoFirme && !botaoJaAgiu && t - botaoApertouMs >= BOTAO_SEGURAR_MS) {
      botaoJaAgiu = true;
      acaoBotao();
    }
  }
  // Pausa da rega: só as 2 válvulas. Os relés (bomba da hidroponia) seguem o programa.
  void acaoBotao() {
    atualizaHora();
    bool algumaPausada = false;
    for (int v = 0; v < NUM_VALVULAS; v++) {
      if (est[v].pa != 0 && agora < est[v].pa) algumaPausada = true;
    }
    if (!algumaPausada) {
      for (int v = 0; v < NUM_VALVULAS; v++) {
        est[v].pa = agora + 86400;
        est[v].ma = 0;  // pausar cancela o manual
        est[v].mo = false;
      }
      gravaEstado();
      for (int v = 0; v < NUM_VALVULAS; v++) registra(13, v, ORIGEM_BOTAO, 24);
      hal.log("Botao: valvulas pausadas por 24 h");
    } else {
      for (int v = 0; v < NUM_VALVULAS; v++) {
        if (est[v].pa == 0) continue;
        est[v].pa = 0;
        registra(14, v, ORIGEM_BOTAO, 0);
      }
      gravaEstado();
      hal.log("Botao: pausa das valvulas cancelada");
    }
    avalia();
    if (online()) enviaSt();
  }

  // ---------- LED (§6.5) ----------
  void atualizaLed() {
    const int64_t t = ms();
    bool aceso;
    if (conectado) aceso = true;
    else if (!horaValida) aceso = ((t / 250) % 2) == 0;
    else aceso = (t % 3000) < 100;
    if (aceso != ledAceso) {
      ledAceso = aceso;
      hal.led(aceso);
    }
  }
};

}  // namespace rega
