/*
  ============================================================
   IRRIGA HORTA  —  firmware do ESP32  (versão 1.0.0)
  ============================================================
  Controla 2 válvulas de trinco (latch, por ponte H), 2 relés (bomba da
  hidroponia e uma saída livre), mede corrente e conversa com o app do
  celular por Bluetooth (BLE). Detalhes: docs/PROTOCOLO.md.

  COMO GRAVAR (Arduino IDE)
  - Placa: "ESP32 Dev Module" (pacote "esp32" da Espressif, versão 2.0.x ou 3.x).
  - Partition Scheme (Esquema de partição): "Huge APP (3MB No OTA/1MB SPIFFS)".
    (O padrão "Default 4MB with spiffs" ainda serve, mas o programa já ocupa ~90% dele.)
  - Biblioteca: "ArduinoJson" versão 7, de Benoit Blanchon (Gerenciador de Bibliotecas).
  - Monitor serial: 115200.

  PINOS
    Válvula 1  lado A (IN1 da ponte H) .... GPIO 25
    Válvula 1  lado B (IN2 da ponte H) .... GPIO 26
    Válvula 2  lado A (IN3 da ponte H) .... GPIO 27
    Válvula 2  lado B (IN4 da ponte H) .... GPIO 33
    Relé 1 (saída 3, Hidroponia) .......... GPIO 16
    Relé 2 (saída 4, livre) ............... GPIO 17
    Sensor de corrente 1 .................. GPIO 34 (só entrada)
    Sensor de corrente 2 .................. GPIO 35 (só entrada)
    Relógio DS3231 (opcional) ............. SDA 21, SCL 22
    LED azul da placa ..................... GPIO 2
    Botão BOOT da placa ................... GPIO 0 (segurar 3 s = pausa da rega: só as válvulas)

  ARQUIVOS DESTA PASTA
    ControladorRega.ino  liga o "cérebro" ao hardware: pinos, ADC, Bluetooth,
                         memória (NVS), relógio DS3231, LED e botão.
    nucleo.h             o "cérebro": regras, prioridades, válvulas, corrente,
                         alarmes, eventos e comandos do app.
    agenda.h             as contas dos horários (fixo e ciclo).
    relogio.h            as contas do relógio DS3231 (datas, BCD, modo 12 h).
*/

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>
#include <Wire.h>
#include <driver/gpio.h>
#include <esp_gap_ble_api.h>
#include <esp_gatts_api.h>
#include <esp_mac.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <sys/time.h>

#include <deque>
#include <string>

#include "nucleo.h"
#include "relogio.h"

// ---------------- pinos ----------------
const int PINO_A[2] = {25, 27};      // lado A da ponte H de cada válvula
const int PINO_B[2] = {26, 33};      // lado B
const int PINO_RELE[2] = {16, 17};   // relés (saídas 3 e 4)
const int PINO_SENSOR[2] = {34, 35}; // sensores de corrente (ADC1)
const int PINO_SDA = 21;
const int PINO_SCL = 22;
const int PINO_LED = 2;
const int PINO_BOTAO = 0;

// ---------------- Bluetooth (§7) ----------------
#define UUID_SERVICO "7a3e0001-9c4b-4f8e-b3a1-2d6c5e4f1a90"
#define UUID_RX      "7a3e0002-9c4b-4f8e-b3a1-2d6c5e4f1a90"
#define UUID_TX      "7a3e0003-9c4b-4f8e-b3a1-2d6c5e4f1a90"
const uint16_t MTU_LOCAL = 517;
const size_t MAX_PEDACO = 500;           // maior pedaço de uma notificação
const uint32_t PAUSA_PEDACOS_MS = 4;     // pausa entre pedaços de uma mesma linha
const uint32_t ESPERA_MAX_LINHA_MS = 1500;  // tempo máximo tentando mandar uma linha
const size_t MAX_LINHAS_RX = 16;         // linhas esperando o loop()

// ---------------- relógio DS3231 ----------------
const uint8_t ENDERECO_DS3231 = 0x68;
const uint32_t SINCRONIZA_RTC_MS = 6UL * 3600UL * 1000UL;  // confere o DS3231 a cada 6 h

const size_t TAM_BUFFER_NVS = 4096;      // texto do NVS: no máximo 4000 bytes

Preferences prefs;
bool rtcPresente = false;

// ---- estado do Bluetooth (mexido pelas tarefas do Bluetooth: cuidado) ----
BLEServer* servidor = nullptr;
BLECharacteristic* carTx = nullptr;
BLECharacteristic* carRx = nullptr;
BLE2902* cccdTx = nullptr;              // onde o app liga as notificações do TX
volatile bool bleConectado = false;
volatile uint32_t geracaoConexao = 0;   // aumenta a cada conexão nova
volatile uint16_t idConexao = 0;
volatile uint16_t mtuCombinado = 23;
volatile bool bleCongestionado = false;  // o Bluetooth pediu para esperar (fila cheia)
volatile esp_gatt_if_t interfaceGatts = ESP_GATT_IF_NONE;  // "endereço" do nosso servidor no Bluetooth
SemaphoreHandle_t travaRx = nullptr;    // protege bufferRx e filaRx
std::string bufferRx;
bool descartandoRx = false;
std::deque<std::string> filaRx;

// ---- estado usado só no loop() ----
uint32_t geracaoNoNucleo = 0;   // conexão que o núcleo conhece (0 = nenhuma)
uint32_t geracaoVista = 0;      // última conexão que o loop() viu
uint16_t mtuNoNucleo = 23;
bool anunciar = false;
uint32_t momentoDesconexao = 0;
uint32_t ultimoAnuncio = 0;
std::string nomeAnunciado;      // nome que está no anúncio agora
bool pararAnuncioDeNovo = false;
uint32_t momentoConexao = 0;
bool linhaQuebrada = false;     // o último envio parou no meio de uma linha
uint32_t ultimaSincronizacaoRtc = 0;

// =============================================================
//  Relógio: hora do sistema e DS3231 (UTC)
// =============================================================
int64_t epochSistema() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return static_cast<int64_t>(tv.tv_sec);
}

void acertaSistema(int64_t ep) {
  if (ep < 0 || ep > rega::HORA_MAXIMA_RELOGIO) return;  // não cabe no time_t (núcleo 2.x: só até 2038)
  struct timeval tv;
  tv.tv_sec = static_cast<time_t>(ep);
  tv.tv_usec = 0;
  settimeofday(&tv, nullptr);
}

bool rtcLeRegistros(uint8_t primeiro, uint8_t* dados, size_t n) {
  Wire.beginTransmission(ENDERECO_DS3231);
  Wire.write(primeiro);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom(ENDERECO_DS3231, n, true) != n) return false;
  for (size_t i = 0; i < n; i++) dados[i] = static_cast<uint8_t>(Wire.read());
  return true;
}

bool rtcGravaRegistro(uint8_t registro, uint8_t valor) {
  Wire.beginTransmission(ENDERECO_DS3231);
  Wire.write(registro);
  Wire.write(valor);
  return Wire.endTransmission() == 0;
}

bool rtcExiste() {
  Wire.beginTransmission(ENDERECO_DS3231);
  return Wire.endTransmission() == 0;
}

// Lê a hora do DS3231. Devolve false se não respondeu ou se a hora não vale (OSF ligado).
bool rtcLe(int64_t& ep) {
  uint8_t status = 0;
  if (!rtcLeRegistros(relogio::REG_STATUS, &status, 1)) return false;
  if (relogio::osfLigado(status)) return false;  // o relógio parou em algum momento
  uint8_t r[7];
  if (!rtcLeRegistros(relogio::REG_HORA, r, 7)) return false;
  if (!relogio::decodifica(r, ep)) return false;
  return ep <= rega::HORA_MAXIMA_RELOGIO;  // núcleo 2.x: o sistema só guarda até 2038
}

// Grava a hora no DS3231 (24 h), deixa o relógio rodar na bateria e limpa o OSF.
bool rtcGrava(int64_t ep) {
  uint8_t r[7];
  if (!relogio::codifica(ep, r)) return false;
  Wire.beginTransmission(ENDERECO_DS3231);
  Wire.write(relogio::REG_HORA);
  Wire.write(r, 7);
  if (Wire.endTransmission() != 0) return false;
  uint8_t reg = 0;
  if (rtcLeRegistros(relogio::REG_CONTROLE, &reg, 1)) {
    rtcGravaRegistro(relogio::REG_CONTROLE, static_cast<uint8_t>(reg & ~relogio::BIT_EOSC));
  }
  if (!rtcLeRegistros(relogio::REG_STATUS, &reg, 1)) return false;
  return rtcGravaRegistro(relogio::REG_STATUS, static_cast<uint8_t>(reg & ~relogio::BIT_OSF));
}

// De vez em quando acerta a hora do sistema pelo DS3231 (que é mais preciso).
void sincronizaRtc() {
  if (!rtcPresente) return;
  if (millis() - ultimaSincronizacaoRtc < SINCRONIZA_RTC_MS) return;
  ultimaSincronizacaoRtc = millis();
  int64_t ep = 0;
  if (!rtcLe(ep) || ep < rega::HORA_VALIDA) return;
  const int64_t dif = ep - epochSistema();
  if (dif >= 2 || dif <= -2) {
    acertaSistema(ep);
    Serial.printf("Hora acertada pelo DS3231 (%d s)\n", static_cast<int>(dif));
  }
}

// =============================================================
//  Bluetooth
// =============================================================

// Bytes que chegaram no RX: junta até o \n e guarda a linha na fila.
// Roda na tarefa do Bluetooth, por isso usa a trava.
void recebeBytes(const char* p, size_t n) {
  if (travaRx == nullptr) return;
  xSemaphoreTake(travaRx, portMAX_DELAY);
  for (size_t i = 0; i < n; i++) {
    const char ch = p[i];
    if (ch == '\n') {
      if (!descartandoRx && !bufferRx.empty()) {
        if (filaRx.size() < MAX_LINHAS_RX) filaRx.push_back(bufferRx);
      }
      bufferRx.clear();
      descartandoRx = false;
    } else if (!descartandoRx) {
      if (bufferRx.size() >= rega::MAX_LINHA) {  // linha grande demais: joga fora até o \n
        bufferRx.clear();
        descartandoRx = true;
      } else {
        bufferRx += ch;
      }
    }
  }
  xSemaphoreGive(travaRx);
}

void limpaRx() {
  if (travaRx == nullptr) return;
  xSemaphoreTake(travaRx, portMAX_DELAY);
  bufferRx.clear();
  descartandoRx = false;
  filaRx.clear();
  xSemaphoreGive(travaRx);
}

// Um celular por vez (§7). As funções abaixo rodam na tarefa do Bluetooth.
class CallbacksServidor : public BLEServerCallbacks {
  void onConnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) override {
    if (bleConectado) {
      s->disconnect(param->connect.conn_id);  // já tem um celular: recusa o segundo
      return;
    }
    idConexao = param->connect.conn_id;
    mtuCombinado = 23;
    // conexão nova começa com as notificações desligadas (o app liga quando estiver pronto)
    if (cccdTx != nullptr) cccdTx->setNotifications(false);
    geracaoConexao = geracaoConexao + 1;
    bleConectado = true;
  }
  void onDisconnect(BLEServer* s, esp_ble_gatts_cb_param_t* param) override {
    (void)s;
    if (!bleConectado || param->disconnect.conn_id != idConexao) return;  // era um 2º celular (recusado)
    bleConectado = false;
    limpaRx();  // o que sobrou desta conexão não vale para a próxima
  }
  void onMtuChanged(BLEServer* s, esp_ble_gatts_cb_param_t* param) override {
    (void)s;
    if (bleConectado && param->mtu.conn_id == idConexao) mtuCombinado = param->mtu.mtu;
  }
};

// Vê os eventos do Bluetooth: guarda a interface do servidor (para mandar as notificações)
// e fica sabendo quando a fila de envio está cheia.
void eventoGatts(esp_gatts_cb_event_t evento, esp_gatt_if_t interfaceGatt, esp_ble_gatts_cb_param_t* param) {
  if (evento == ESP_GATTS_REG_EVT || evento == ESP_GATTS_CONNECT_EVT) interfaceGatts = interfaceGatt;
  if (evento == ESP_GATTS_CONGEST_EVT && param->congest.conn_id == idConexao) {
    bleCongestionado = param->congest.congested;
  } else if (evento == ESP_GATTS_DISCONNECT_EVT && param->disconnect.conn_id == idConexao) {
    bleCongestionado = false;
  } else if (evento == ESP_GATTS_CONNECT_EVT && param->connect.conn_id == idConexao) {
    bleCongestionado = false;
  }
}

class CallbacksRx : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c, esp_ble_gatts_cb_param_t* param) override {
    if (!bleConectado || param->write.conn_id != idConexao) return;  // só o celular conectado
    auto valor = c->getValue();  // std::string no núcleo 2.x, String no núcleo 3.x
    recebeBytes(valor.c_str(), valor.length());
  }
};

// Manda um pedaço numa notificação. Se o Bluetooth estiver ocupado (fila cheia),
// tenta de novo um pouco depois, até o prazo da linha. Devolve false se não conseguiu.
bool enviaPedaco(uint8_t* p, size_t n, uint32_t inicioLinha) {
  for (;;) {
    if (!bleConectado) return false;
    if (!bleCongestionado) {
      const esp_err_t r = esp_ble_gatts_send_indicate(interfaceGatts, idConexao, carTx->getHandle(),
                                                      static_cast<uint16_t>(n), p, false);
      if (r == ESP_OK) return true;
    }
    if (millis() - inicioLinha >= ESPERA_MAX_LINHA_MS) return false;
    delay(5);
  }
}

// Manda uma linha para o app, em pedaços que cabem numa notificação.
// Se um pedaço não sai, o resto da linha é descartado (nunca manda pedaços com
// buraco no meio). A próxima linha começa com um \n: assim o pedaço que ficou
// sozinho vira uma linha estragada, que o app joga fora, e a próxima chega inteira.
void bleEnvia(const std::string& linha) {
  if (!bleConectado || carTx == nullptr || interfaceGatts == ESP_GATT_IF_NONE) return;
  if (cccdTx != nullptr && !cccdTx->getNotifications()) return;  // o app ainda não ligou as notificações
  std::string dados;
  if (linhaQuebrada) dados += '\n';
  dados += linha;
  dados += '\n';
  const uint16_t mtu = mtuCombinado;
  size_t tam = (mtu > 23) ? static_cast<size_t>(mtu - 3) : 20;  // MTU desconhecido: 20 bytes
  if (tam > MAX_PEDACO) tam = MAX_PEDACO;
  const uint32_t inicio = millis();
  for (size_t pos = 0; pos < dados.size(); pos += tam) {
    if (pos > 0) delay(PAUSA_PEDACOS_MS);  // dá tempo do Bluetooth mandar o pedaço anterior
    const size_t n = (dados.size() - pos < tam) ? dados.size() - pos : tam;
    if (!enviaPedaco(reinterpret_cast<uint8_t*>(&dados[pos]), n, inicio)) {
      if (pos > 0) linhaQuebrada = true;  // um pedaço desta linha já foi
      if (bleConectado) {
        Serial.printf("Bluetooth ocupado: mensagem perdida (%u de %u bytes)\n", static_cast<unsigned>(pos),
                      static_cast<unsigned>(dados.size()));
      }
      return;
    }
  }
  linhaQuebrada = false;
}

// Monta o anúncio (flags + UUID do serviço; nome na resposta do scan) e começa a anunciar.
// Só chamar SEM celular conectado: no núcleo 3.x, gravar os dados do anúncio
// faz o Bluetooth voltar a anunciar sozinho logo depois.
void configuraAnuncio(const std::string& nome) {
  esp_ble_gap_set_device_name(nome.c_str());
  BLEAdvertising* anuncio = BLEDevice::getAdvertising();
  anuncio->stop();
  BLEAdvertisementData dados;
  dados.setFlags(0x06);  // descobrível + sem Bluetooth clássico
  dados.setCompleteServices(BLEUUID(UUID_SERVICO));
  BLEAdvertisementData resposta;
  resposta.setName(nome.c_str());
  anuncio->setAdvertisementData(dados);
  anuncio->setScanResponseData(resposta);
  anuncio->start();
  nomeAnunciado = nome;
  ultimoAnuncio = millis();
}

// Volta a anunciar (sem celular conectado). Se o nome mudou, monta o anúncio de novo.
void comecaAnuncio(const std::string& nome) {
  if (nome != nomeAnunciado) {
    configuraAnuncio(nome);
    return;
  }
  BLEDevice::getAdvertising()->start();
  ultimoAnuncio = millis();
}

void iniciaBle(const std::string& nome) {
  BLEDevice::init(nome.c_str());
  BLEDevice::setMTU(MTU_LOCAL);
  BLEDevice::setCustomGattsHandler(eventoGatts);
  servidor = BLEDevice::createServer();
  servidor->setCallbacks(new CallbacksServidor());
  BLEService* servico = servidor->createService(UUID_SERVICO);
  carRx = servico->createCharacteristic(UUID_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  carRx->setCallbacks(new CallbacksRx());
  carTx = servico->createCharacteristic(UUID_TX, BLECharacteristic::PROPERTY_NOTIFY);
  cccdTx = new BLE2902();
  carTx->addDescriptor(cccdTx);
  servico->start();
  configuraAnuncio(nome);
  Serial.printf("Bluetooth pronto: %s\n", nome.c_str());
}

// =============================================================
//  Ligação do núcleo com o hardware
// =============================================================
class HalEsp32 : public rega::Hal {
 public:
  int64_t us() override { return esp_timer_get_time(); }

  void esperaAte(int64_t alvo) override {
    for (;;) {
      const int64_t falta = alvo - esp_timer_get_time();
      if (falta <= 0) return;
      // espera longa: dorme e deixa as outras tarefas rodarem; curta: fica conferindo
      if (falta > 2000) delay(static_cast<uint32_t>((falta - 1000) / 1000));
    }
  }

  int64_t epoch() override { return epochSistema(); }

  void acertaRelogio(int64_t ep) override {
    acertaSistema(ep);
    if (rtcPresente) {
      if (rtcGrava(ep)) Serial.println("Hora gravada no DS3231");
      else Serial.println("Erro ao gravar a hora no DS3231");
    }
  }

  bool temRtc() override { return rtcPresente; }

  // Ponte H: primeiro baixa os dois lados, depois sobe só um.
  // Assim A e B nunca ficam altos juntos.
  void ponte(int v, int lado) override {
    if (v < 0 || v > 1) return;
    digitalWrite(PINO_A[v], LOW);
    digitalWrite(PINO_B[v], LOW);
    if (lado == 1) digitalWrite(PINO_A[v], HIGH);
    else if (lado == 2) digitalWrite(PINO_B[v], HIGH);
  }

  // Relé desligado = pino solto (INPUT, sem pull): nenhum tipo de módulo liga sozinho.
  // Ligado = saída no nível que aciona o módulo (alto; baixo com inv = 1).
  void rele(int r, bool ligado, bool inv) override {
    if (r < 0 || r > 1) return;
    const int pino = PINO_RELE[r];
    if (!ligado) {
      pinMode(pino, INPUT);
      return;
    }
    const int nivel = inv ? LOW : HIGH;
    gpio_set_level(static_cast<gpio_num_t>(pino), nivel);  // já vira saída no nível certo
    pinMode(pino, OUTPUT);
    digitalWrite(pino, nivel);
  }

  int leMv(int j) override { return static_cast<int>(analogReadMilliVolts(PINO_SENSOR[j])); }

  void led(bool aceso) override { digitalWrite(PINO_LED, aceso ? HIGH : LOW); }

  bool botaoApertado() override { return digitalRead(PINO_BOTAO) == LOW; }

  bool nvsLe(const char* chave, std::string& valor) override {
    if (!prefs.isKey(chave)) return false;
    // lê para um espaço no heap (o getString(chave) do Arduino usa a pilha, que é pequena)
    std::string buf(TAM_BUFFER_NVS, '\0');
    if (prefs.getString(chave, &buf[0], buf.size()) == 0) return false;
    valor.assign(buf.c_str());
    return true;
  }

  bool nvsGrava(const char* chave, const std::string& valor) override {
    const size_t gravados = prefs.putString(chave, valor.c_str());
    if (gravados != valor.size()) {
      Serial.printf("Erro ao gravar '%s' no NVS\n", chave);
      return false;
    }
    return true;
  }

  std::string idPlaca() override {
    uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
    esp_read_mac(mac, ESP_MAC_BT);
    char txt[8];
    snprintf(txt, sizeof(txt), "%02X%02X", mac[4], mac[5]);
    return std::string(txt);
  }

  void envia(const std::string& linha) override { bleEnvia(linha); }

  void desconecta() override {
    if (servidor != nullptr && bleConectado) servidor->disconnect(idConexao);
  }

  void reinicia() override {
    Serial.flush();
    delay(100);
    ESP.restart();
  }

  void log(const std::string& msg) override { Serial.println(msg.c_str()); }
};

HalEsp32 hal;
rega::Nucleo nucleo(hal);

// Acompanha conexão/desconexão (avisadas pelas tarefas do Bluetooth) e passa as linhas ao núcleo.
void cuidaBle() {
  const bool conectado = bleConectado;
  const uint32_t geracao = geracaoConexao;
  // a conexão que o núcleo conhecia acabou?
  if (geracaoNoNucleo != 0 && (!conectado || geracao != geracaoNoNucleo)) {
    nucleo.desconectou();
    geracaoNoNucleo = 0;
    anunciar = true;
    momentoDesconexao = millis();
  }
  // conexão nova
  if (conectado && geracaoNoNucleo == 0 && geracao != 0) {
    BLEDevice::getAdvertising()->stop();  // um celular por vez: para de anunciar
    pararAnuncioDeNovo = true;            // e de novo daqui a 1 s (o núcleo 3.x pode religar sozinho)
    momentoConexao = millis();
    anunciar = false;
    geracaoNoNucleo = geracao;
    geracaoVista = geracao;
    mtuNoNucleo = mtuCombinado;
    linhaQuebrada = false;
    nucleo.conectou(mtuNoNucleo);
  } else if (!conectado && geracao != geracaoVista) {
    // um celular conectou e já saiu entre duas voltas do loop(): volta a anunciar
    geracaoVista = geracao;
    anunciar = true;
    momentoDesconexao = millis();
  }
  if (conectado && pararAnuncioDeNovo && millis() - momentoConexao > 1000) {
    pararAnuncioDeNovo = false;
    BLEDevice::getAdvertising()->stop();
  }
  if (geracaoNoNucleo != 0 && mtuCombinado != mtuNoNucleo) {
    mtuNoNucleo = mtuCombinado;
    nucleo.mudouMtu(mtuNoNucleo);
  }
  if (geracaoNoNucleo != 0) {
    // passa as linhas recebidas
    std::deque<std::string> linhas;
    xSemaphoreTake(travaRx, portMAX_DELAY);
    linhas.swap(filaRx);
    xSemaphoreGive(travaRx);
    for (const std::string& l : linhas) nucleo.recebeLinha(l);
  }
  // volta a anunciar depois de desconectar (daqui, nunca de dentro do callback)
  if (!conectado) {
    if (anunciar && millis() - momentoDesconexao > 300) {
      anunciar = false;
      comecaAnuncio(nucleo.config().nome);
      Serial.println("Anunciando de novo");
    } else if (!anunciar && millis() - ultimoAnuncio > 60000) {
      comecaAnuncio(nucleo.config().nome);  // de tempos em tempos, por garantia
    }
  }
}

// Pino da ponte H: saída em nível baixo.
void saidaBaixa(int pino) {
  gpio_set_level(static_cast<gpio_num_t>(pino), 0);
  pinMode(pino, OUTPUT);
  digitalWrite(pino, LOW);
}

void setup() {
  // 1º de tudo: ponte H em nível baixo (válvulas paradas)
  for (int v = 0; v < 2; v++) {
    saidaBaixa(PINO_A[v]);
    saidaBaixa(PINO_B[v]);
  }
  // relés desligados = pino solto (INPUT, sem pull), desde o começo (§1)
  pinMode(PINO_RELE[0], INPUT);
  pinMode(PINO_RELE[1], INPUT);
  pinMode(PINO_LED, OUTPUT);
  digitalWrite(PINO_LED, LOW);
  pinMode(PINO_BOTAO, INPUT_PULLUP);

  Serial.begin(115200);
  delay(50);
  Serial.println();
  Serial.printf("Controlador de Rega - firmware %s\n", rega::VERSAO_FW);

  analogSetPinAttenuation(PINO_SENSOR[0], ADC_11db);  // lê até uns 3,1 V
  analogSetPinAttenuation(PINO_SENSOR[1], ADC_11db);

  travaRx = xSemaphoreCreateMutex();
  if (!prefs.begin("rega", false)) Serial.println("Erro ao abrir a memória (NVS)");

  // relógio: DS3231 se tiver; senão a hora que sobrou de um reinício
  Wire.begin(PINO_SDA, PINO_SCL);
  Wire.setClock(100000);
  rtcPresente = rtcExiste();
  int64_t ep = 0;
  if (rtcPresente && rtcLe(ep) && ep >= rega::HORA_VALIDA) {
    acertaSistema(ep);
    Serial.println("Hora lida do DS3231");
  } else if (rtcPresente) {
    Serial.println("DS3231 encontrado, mas sem hora certa (espera o app)");
  } else if (epochSistema() >= rega::HORA_VALIDA) {
    Serial.println("Sem DS3231; hora mantida do reinício");
  } else {
    Serial.println("Sem DS3231 e sem hora (espera o app)");
  }
  ultimaSincronizacaoRtc = millis();

  nucleo.inicia();  // lê a configuração, zera sensores, fecha as válvulas
  iniciaBle(nucleo.config().nome);
}

void loop() {
  cuidaBle();
  nucleo.passo();
  sincronizaRtc();
  delay(1);
}
