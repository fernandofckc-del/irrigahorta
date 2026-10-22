/*
 * Web Bluetooth de mentira para testar o app sem placa (PROTOCOLO.md §11).
 *
 * Injete antes do app (Playwright: context.addInitScript({ path: 'testes/ble-falso.js' })).
 * - navigator.bluetooth falso: requestDevice(), getDevices(), aparelho com gatt.connect(),
 *   serviço e as 2 características (RX e TX).
 * - Escritas no RX viram texto e vão para window.__bleBackend.send(texto)
 *   (o texto pode vir partido: o backend junta até achar "\n").
 * - O backend entrega linhas com window.__bleEntrega(linha); aqui a linha é cortada em
 *   pedaços de window.__bleMtu - 3 bytes (padrão MTU 23) e cada pedaço dispara
 *   'characteristicvaluechanged' no TX com um DataView.
 * - Backend padrão = um ESP32 simulado simples (abaixo). Para trocar, defina
 *   window.__bleBackend = { send(texto) {…}, conectou() {…}, desconectou() {…} } (os dois
 *   últimos são opcionais).
 * - Ganchos para os testes em window.__simFalso (ver no fim do arquivo).
 * - Opções (antes de carregar, ou em localStorage '__bleFalso.opcoes' como JSON):
 *   window.__bleFalsoOpcoes = { semWatch: true, semGetDevices: true, foraDeAlcance: true, pin: '1234' }
 */
(function () {
  'use strict';
  if (window.__bleFalsoInstalado) return;
  window.__bleFalsoInstalado = true;

  var SERVICO = '7a3e0001-9c4b-4f8e-b3a1-2d6c5e4f1a90';
  var RX = '7a3e0002-9c4b-4f8e-b3a1-2d6c5e4f1a90';
  var TX = '7a3e0003-9c4b-4f8e-b3a1-2d6c5e4f1a90';
  var CHAVE_PERMITIDO = '__bleFalso.permitido';

  function lerLS(chave) {
    try { return localStorage.getItem(chave); } catch (e) { return null; }
  }
  function gravarLS(chave, valor) {
    try {
      if (valor === null) localStorage.removeItem(chave);
      else localStorage.setItem(chave, valor);
    } catch (e) { /* sem armazenamento */ }
  }

  var opcoes = window.__bleFalsoOpcoes || {};
  try {
    var salvas = JSON.parse(lerLS('__bleFalso.opcoes') || 'null');
    if (salvas) for (var k in salvas) opcoes[k] = salvas[k];
  } catch (e) { /* ignora */ }

  if (window.__bleMtu === undefined) window.__bleMtu = 23;

  var esperar = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function erroDom(nome, msg) {
    try { return new DOMException(msg, nome); } catch (e) { var x = new Error(msg); x.name = nome; return x; }
  }
  function paraBytes(dados) {
    if (dados instanceof Uint8Array) return dados;
    if (dados instanceof ArrayBuffer) return new Uint8Array(dados);
    if (ArrayBuffer.isView(dados)) return new Uint8Array(dados.buffer, dados.byteOffset, dados.byteLength);
    throw new TypeError('valor precisa ser BufferSource');
  }

  var estat = { escritas: [], colisoes: 0, notificacoes: 0, conexoes: 0, connectChamadas: 0 };
  window.__bleFalsoEstat = estat;

  // ---------- características, serviço, servidor, aparelho ----------
  var ligacao = null; // { servidor, rx, tx, decoder }
  var filaEntrega = [];
  var entregando = false;

  function Caracteristica(servico, uuid, props) {
    var alvo = new EventTarget();
    alvo.service = servico;
    alvo.uuid = uuid;
    alvo.properties = props;
    alvo.value = null;
    alvo._notificando = false;
    alvo._escrevendo = false;
    alvo.startNotifications = function () {
      if (!aparelho.gatt.connected) return Promise.reject(erroDom('NetworkError', 'GATT Server is disconnected.'));
      if (uuid !== TX) return Promise.reject(erroDom('NotSupportedError', 'GATT operation not permitted.'));
      return esperar(5).then(function () { alvo._notificando = true; return alvo; });
    };
    alvo.stopNotifications = function () { alvo._notificando = false; return Promise.resolve(alvo); };
    alvo.readValue = function () { return Promise.reject(erroDom('NotSupportedError', 'GATT operation not permitted.')); };
    function escrever(dados) {
      if (uuid !== RX) return Promise.reject(erroDom('NotSupportedError', 'GATT operation not permitted.'));
      if (!aparelho.gatt.connected || !ligacao || ligacao.rx !== alvo) {
        return Promise.reject(erroDom('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.'));
      }
      var bytes;
      try { bytes = paraBytes(dados); } catch (e) { return Promise.reject(e); }
      if (bytes.length > 512) return Promise.reject(erroDom('InvalidModificationError', 'Value can\'t exceed 512 bytes.'));
      if (alvo._escrevendo) {
        // o Chrome real falha assim quando o app escreve duas vezes ao mesmo tempo
        estat.colisoes++;
        return Promise.reject(erroDom('NetworkError', 'GATT operation already in progress.'));
      }
      if (sim.escritasPresas) {
        // ligação morta sem aviso: a escrita nunca termina
        alvo._escrevendo = true;
        return new Promise(function () {});
      }
      if (sim.falhas.pular > 0) sim.falhas.pular--;
      else if (sim.falhas.quantas > 0) {
        sim.falhas.quantas--;
        return esperar(2).then(function () { throw erroDom('NetworkError', 'GATT Error: Not supported.'); });
      }
      alvo._escrevendo = true;
      var copia = new Uint8Array(bytes); // o app pode reaproveitar o buffer
      return esperar(2).then(function () {
        alvo._escrevendo = false;
        if (!ligacao || ligacao.rx !== alvo) throw erroDom('NetworkError', 'GATT Server is disconnected.');
        estat.escritas.push(copia.length);
        var texto = ligacao.decoder.decode(copia, { stream: true });
        var be = window.__bleBackend;
        if (texto && be && typeof be.send === 'function') {
          try { be.send(texto); } catch (e) { console.warn('[ble-falso] backend falhou', e); }
        }
      });
    }
    alvo.writeValueWithResponse = escrever;
    alvo.writeValueWithoutResponse = escrever;
    alvo.writeValue = escrever;
    return alvo;
  }

  function criarLigacao(servidor) {
    var servico = { uuid: SERVICO, isPrimary: true, device: aparelho };
    var rx = Caracteristica(servico, RX, { write: true, writeWithoutResponse: true, notify: false, read: false });
    var tx = Caracteristica(servico, TX, { write: false, writeWithoutResponse: false, notify: true, read: false });
    servico.getCharacteristic = function (uuid) {
      uuid = String(uuid).toLowerCase();
      if (!aparelho.gatt.connected) return Promise.reject(erroDom('NetworkError', 'GATT Server is disconnected.'));
      if (uuid === RX) return esperar(3).then(function () { return rx; });
      if (uuid === TX) return esperar(3).then(function () { return tx; });
      return Promise.reject(erroDom('NotFoundError', 'No Characteristics matching UUID ' + uuid + ' found in Service.'));
    };
    servico.getCharacteristics = function () { return Promise.resolve([rx, tx]); };
    return { servidor: servidor, servico: servico, rx: rx, tx: tx, decoder: new TextDecoder('utf-8') };
  }

  var aparelho = new EventTarget();
  aparelho.id = 'falso-AbCdEf123456==';
  aparelho.name = 'Rega-1A2B';
  aparelho.watchingAdvertisements = false;
  var servidor = {
    device: aparelho,
    connected: false,
    connect: function () {
      estat.connectChamadas++;
      var self = this;
      if (self.connected) return Promise.resolve(self);
      if (!sim.alcance) {
        return esperar(opcoes.atrasoFora || 1200).then(function () {
          throw erroDom('NetworkError', 'Bluetooth Device is no longer in range.');
        });
      }
      return esperar(60).then(function () {
        if (!sim.alcance) throw erroDom('NetworkError', 'Bluetooth Device is no longer in range.');
        if (self.connected) return self;
        self.connected = true;
        estat.conexoes++;
        ligacao = criarLigacao(self);
        var be = window.__bleBackend;
        if (be && typeof be.conectou === 'function') {
          try { be.conectou(); } catch (e) { console.warn('[ble-falso] backend.conectou falhou', e); }
        }
        return self;
      });
    },
    disconnect: function () { cair('app'); },
    getPrimaryService: function (uuid) {
      uuid = String(uuid).toLowerCase();
      if (!this.connected || !ligacao) return Promise.reject(erroDom('NetworkError', 'GATT Server is disconnected. Cannot retrieve services.'));
      if (uuid !== SERVICO) return Promise.reject(erroDom('NotFoundError', 'No Services matching UUID ' + uuid + ' found in Device.'));
      var l = ligacao;
      return esperar(5).then(function () { return l.servico; });
    }
  };
  aparelho.gatt = servidor;

  // queda da ligação (pelo app, pelo controlador ou fora de alcance)
  function cair(motivo) {
    if (!servidor.connected) return;
    servidor.connected = false;
    ligacao = null;
    filaEntrega = [];
    var be = window.__bleBackend;
    if (be && typeof be.desconectou === 'function') {
      try { be.desconectou(motivo); } catch (e) { console.warn('[ble-falso] backend.desconectou falhou', e); }
    }
    setTimeout(function () { aparelho.dispatchEvent(new Event('gattserverdisconnected')); }, 0);
  }
  window.__bleCair = function () { cair('controlador'); };

  aparelho.forget = function () {
    gravarLS(CHAVE_PERMITIDO, null);
    cair('esquecido');
    return Promise.resolve();
  };

  if (!opcoes.semWatch) {
    aparelho.watchAdvertisements = function (op) {
      var sinal = op && op.signal;
      if (sinal && sinal.aborted) return Promise.reject(erroDom('AbortError', 'aborted'));
      aparelho.watchingAdvertisements = true;
      var timer = null;
      function anunciar() {
        if (!aparelho.watchingAdvertisements) return;
        if (sim.alcance && !servidor.connected) {
          var ev = new Event('advertisementreceived');
          ev.device = aparelho; ev.name = aparelho.name; ev.rssi = -60; ev.uuids = [SERVICO];
          aparelho.dispatchEvent(ev);
        }
        timer = setTimeout(anunciar, 500);
      }
      timer = setTimeout(anunciar, 150);
      if (sinal) {
        sinal.addEventListener('abort', function () {
          aparelho.watchingAdvertisements = false;
          clearTimeout(timer);
        });
      }
      return Promise.resolve();
    };
  }

  // ---------- entrega ESP32 → app ----------
  function bombearEntrega() {
    if (entregando) return;
    entregando = true;
    setTimeout(function passo() {
      var l = ligacao;
      if (!filaEntrega.length || !l) { entregando = false; filaEntrega = l ? filaEntrega : []; return; }
      // até 32 notificações por volta (cada pedaço continua sendo um evento separado)
      for (var n = 0; n < 32 && filaEntrega.length && ligacao === l; n++) {
        var pedaco = filaEntrega.shift();
        if (l.tx._notificando) {
          l.tx.value = new DataView(pedaco.buffer, pedaco.byteOffset, pedaco.byteLength);
          estat.notificacoes++;
          l.tx.dispatchEvent(new Event('characteristicvaluechanged'));
        }
      }
      setTimeout(passo, 0);
    }, 0);
  }

  var codificador = new TextEncoder();
  window.__bleEntrega = function (linha) {
    if (!ligacao || !servidor.connected) return false;
    var texto = String(linha);
    if (texto.charAt(texto.length - 1) !== '\n') texto += '\n';
    var bytes = codificador.encode(texto);
    var tam = Math.max(1, Math.min(500, (Number(window.__bleMtu) || 23) - 3));
    for (var i = 0; i < bytes.length; i += tam) {
      filaEntrega.push(bytes.slice(i, i + tam)); // cópia com buffer próprio
    }
    bombearEntrega();
    return true;
  };

  // ---------- navigator.bluetooth ----------
  var bluetooth = new EventTarget();
  bluetooth.getAvailability = function () { return Promise.resolve(true); };
  bluetooth.requestDevice = function (op) {
    op = op || {};
    var temServico = (op.filters || []).some(function (f) {
      return (f.services || []).some(function (s) { return String(s).toLowerCase() === SERVICO; });
    });
    if (!op.acceptAllDevices && !temServico) {
      return esperar(50).then(function () { throw erroDom('NotFoundError', 'User cancelled the requestDevice() chooser.'); });
    }
    if (sim.cancelarEscolha) {
      return esperar(50).then(function () { throw erroDom('NotFoundError', 'User cancelled the requestDevice() chooser.'); });
    }
    return esperar(80).then(function () {
      gravarLS(CHAVE_PERMITIDO, '1');
      return aparelho;
    });
  };
  if (!opcoes.semGetDevices) {
    bluetooth.getDevices = function () {
      return Promise.resolve(lerLS(CHAVE_PERMITIDO) === '1' ? [aparelho] : []);
    };
  }
  try {
    Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: function () { return bluetooth; } });
  } catch (e) {
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: bluetooth });
  }

  // =====================================================================
  // ESP32 simulado (backend padrão). Implementa o suficiente do §8.
  // =====================================================================
  function arred3(x) { return Math.round(x * 1000) / 1000; }
  function ruido(a) { return (Math.random() * 2 - 1) * a; }
  function agoraReal() { return Math.floor(Date.now() / 1000); }

  function cfgInicial() {
    return {
      v: 1, nome: 'Rega-1A2B', tz: -180, pms: 80, f2: 1,
      s: [
        { n: 'Válvula 1', en: 1, inv: 0, r: [
          { k: 'f', h: 360, d: 20, w: 42, en: 1 },
          { k: 'f', h: 540, d: 30, w: 127, en: 1 }] },
        { n: 'Válvula 2', en: 1, inv: 0, r: [{ k: 'f', h: 1080, d: 15, w: 127, en: 1 }] },
        { n: 'Hidroponia', en: 1, inv: 0, r: [
          { k: 'c', a: 360, b: 1140, on: 15, off: 15, w: 127, en: 1 },
          { k: 'c', a: 1140, b: 360, on: 15, off: 45, w: 127, en: 1 }] },
        { n: 'Relé 2', en: 0, inv: 0, r: [] }
      ],
      sen: [
        { n: 'Válvulas', en: 1, tp: 'dc', mva: 185, div: 0.667, aj: 1, sa: -2, min: 0.1, max: 0, corta: 0 },
        { n: 'Bomba', en: 1, tp: 'ac', mva: 33.3, div: 1, aj: 1, sa: 2, min: 0.1, max: 4, corta: 1 }
      ]
    };
  }

  var sim = {
    alcance: !opcoes.foraDeAlcance,
    cancelarEscolha: false,
    silencio: false,       // true = para de mandar st/i (simula sinal ruim)
    cfg: cfgInicial(),
    pin: opcoes.pin ? String(opcoes.pin) : '',
    desvio: 0,             // relógio do controlador = relógio do celular + desvio (s)
    hv: 1,
    rtc: 1,
    bootEm: Date.now(),
    saidas: [0, 1, 2, 3].map(function () {
      return { on: 0, mo: 0, ma: 0, pa: 0, b: 0, hj: 0, pk: -1, ligouEm: 0, baixa: 0, alta: 0, a21: false, a22: false };
    }),
    eventos: [],
    conectado: false,
    autenticado: false,
    errosPin: 0,            // PINs errados seguidos (vale para todas as conexões, §7.1)
    travaPinAte: 0,         // Date.now() até quando "auth" é recusado
    escritasPresas: false,  // true = as escritas no RX nunca terminam
    falhas: { pular: 0, quantas: 0 }, // depois de "pular" escritas, as próximas "quantas" falham
    buf: '',
    correnteFixa: [null, null],
    picoValvula: [1.2, 1.25],
    pulso: null,
    ultimaI: [null, null],
    diaHj: null,
    recebidos: [],
    respostasCongeladas: false, // true = não responde comandos (testa o tempo de 5 s)
    atrasoMs: 0,                // atraso para tratar cada linha recebida
    cairAntesDoCfg: false,      // true = depois do ok de um "cfg", cai (e fica fora de alcance) sem mandar a cfg
    estragarProxima: false     // true = a próxima linha chega estragada (testa o err sem tipo)
  };

  function agoraSim() { return sim.hv ? agoraReal() + sim.desvio : 0; }

  function enviar(obj) {
    if (!sim.conectado) return;
    window.__bleEntrega(JSON.stringify(obj));
  }

  function evento(s, c, o, v) {
    var e = [agoraSim(), s, c, o, arred3(v || 0)];
    sim.eventos.push(e);
    if (sim.eventos.length > 200) sim.eventos.shift();
    if (sim.conectado && sim.autenticado) enviar({ t: 'ev', e: e });
    return e;
  }

  function sensorDoPulso() {
    for (var j = 0; j < 2; j++) {
      var c = sim.cfg.sen[j];
      if (c.en && c.sa === -2) return j;
    }
    return -1;
  }

  function desejado(i, t) {
    var c = sim.cfg.s[i], s = sim.saidas[i];
    if (!c.en) return { on: 0, o: 7 };
    if (s.b) return { on: 0, o: 3 };
    if (s.ma && t < s.ma) return { on: s.mo ? 1 : 0, o: 1 };
    if (s.pa && t < s.pa) return { on: 0, o: 2 };
    if (!sim.hv) return { on: 0, o: 0 };
    var A = window.Agenda;
    var on = A ? A.programaAtivo(c.r, t + sim.cfg.tz * 60) : false;
    return { on: on ? 1 : 0, o: 0 };
  }

  function mudar(i, on, o, t) {
    var s = sim.saidas[i];
    s.on = on;
    var v = 0;
    if (i < 2) {
      var j = sensorDoPulso();
      if (j >= 0) {
        var pico = arred3(Math.max(0, sim.picoValvula[i] + ruido(0.03)));
        s.pk = pico;
        v = pico;
        sim.pulso = { ate: Date.now() + 400, sensor: j, valor: pico };
      } else {
        s.pk = -1;
      }
    }
    if (on) { s.ligouEm = t; s.a21 = false; s.a22 = false; s.baixa = 0; s.alta = 0; }
    evento(i, on ? 1 : 2, o, v);
    var js = i < 2 ? sensorDoPulso() : -1;
    if (js >= 0) {
      var min = sim.cfg.sen[js].min;
      if (min > 0 && s.pk < min) evento(i, 20, o, s.pk);
    }
  }

  function aplicar() {
    var t = agoraSim() || agoraReal();
    for (var i = 0; i < 4; i++) {
      var s = sim.saidas[i];
      if (s.ma && t >= s.ma) { s.ma = 0; s.mo = 0; }
      if (s.pa && t >= s.pa) { s.pa = 0; }
      var d = desejado(i, t);
      if (d.on !== s.on) mudar(i, d.on, d.o, t);
    }
  }

  function vigiar(t) {
    for (var j = 0; j < 2; j++) {
      var c = sim.cfg.sen[j];
      if (!c.en || c.sa < 0) continue;
      var s = sim.saidas[c.sa];
      var I = sim.ultimaI[j];
      if (I === null || !s.on) { s.baixa = 0; s.alta = 0; continue; }
      if (c.min > 0 && t - s.ligouEm >= 5 && I < c.min) {
        s.baixa++;
        if (s.baixa >= 3 && !s.a21) { s.a21 = true; evento(c.sa, 21, 0, I); }
      } else s.baixa = 0;
      if (c.max > 0 && I > c.max) {
        s.alta++;
        if (s.alta >= 2 && !s.a22) {
          s.a22 = true;
          evento(c.sa, 22, 0, I);
          if (c.corta) { s.b = 1; evento(c.sa, 23, 3, I); }
        }
      } else s.alta = 0;
    }
  }

  function estadoSt() {
    var t = agoraSim();
    var pkOk = sensorDoPulso() >= 0;
    return {
      t: 'st', ep: t, hv: sim.hv, up: Math.floor((Date.now() - sim.bootEm) / 1000), rtc: sim.rtc,
      s: sim.saidas.map(function (s, i) {
        return { on: s.on, mo: s.mo, ma: s.ma, pa: s.pa, b: s.b, hj: s.hj, pk: i < 2 && pkOk ? s.pk : -1 };
      }),
      i: sim.ultimaI.slice()
    };
  }

  function lerCorrente(j) {
    var c = sim.cfg.sen[j];
    if (!c.en) return null;
    var ms = Date.now();
    var v;
    if (sim.correnteFixa[j] !== null) v = sim.correnteFixa[j] + ruido(0.008);
    else if (c.sa === -2) v = sim.pulso && ms < sim.pulso.ate && sim.pulso.sensor === j ? sim.pulso.valor : Math.abs(ruido(0.012));
    else if (c.sa >= 0) {
      v = sim.saidas[c.sa].on
        ? 1.85 + 0.12 * Math.sin(ms / 4000) + 0.05 * Math.sin(ms / 900) + ruido(0.02)
        : Math.abs(ruido(0.012));
    } else v = 0.6 + 0.25 * Math.sin(ms / 6000) + ruido(0.02);
    if (c.tp === 'dc' && Math.abs(v) < 0.01) v = 0;
    return arred3(c.tp === 'dc' ? v : Math.max(0, v)); // DC tem sinal (sensor ligado ao contrário)
  }

  // laço de 1 s (roda sempre, como no ESP32)
  setInterval(function () {
    var t = agoraSim();
    var D = Math.floor((t + sim.cfg.tz * 60) / 86400);
    if (sim.diaHj !== D) { sim.diaHj = D; sim.saidas.forEach(function (s) { s.hj = 0; }); }
    vigiar(t);
    aplicar();
    sim.saidas.forEach(function (s) { if (s.on) s.hj++; });
    if (sim.conectado && sim.autenticado && !sim.silencio) enviar(estadoSt());
  }, 1000);

  // laço de 250 ms: corrente
  setInterval(function () {
    sim.ultimaI = [lerCorrente(0), lerCorrente(1)];
    if (sim.conectado && sim.autenticado && !sim.silencio) enviar({ t: 'i', i: sim.ultimaI.slice() });
  }, 250);

  function boot() {
    sim.bootEm = Date.now();
    sim.saidas.forEach(function (s) { s.on = 0; s.mo = 0; s.ma = 0; s.hj = 0; s.pk = -1; });
    evento(-1, 10, 4, 0);
    evento(0, 2, 4, 0);
    evento(1, 2, 4, 0);
    aplicar();
  }

  function limitar(v, a, b, padrao) {
    var n = Number(v);
    if (!isFinite(n)) return padrao;
    return Math.min(b, Math.max(a, n));
  }

  function bytesUtf8(s) { return codificador.encode(String(s)).length; }

  function validarCfg(c) {
    if (!c || typeof c !== 'object') return { erro: 'Configuração inválida' };
    var n = JSON.parse(JSON.stringify(sim.cfg));
    if (c.nome !== undefined) {
      var nome = String(c.nome).trim();
      if (!nome.length || bytesUtf8(nome) > 20) return { erro: 'Nome precisa ter de 1 a 20 letras' };
      n.nome = nome;
    }
    if (c.tz !== undefined) n.tz = Math.round(limitar(c.tz, -720, 840, n.tz));
    if (c.pms !== undefined) n.pms = Math.round(limitar(c.pms, 10, 1000, 80));
    if (c.f2 !== undefined) n.f2 = c.f2 ? 1 : 0;
    if (Array.isArray(c.s)) {
      c.s.slice(0, 4).forEach(function (s, i) {
        if (!s) return;
        var d = n.s[i];
        if (s.n !== undefined) d.n = String(s.n).slice(0, 24);
        if (s.en !== undefined) d.en = s.en ? 1 : 0;
        if (s.inv !== undefined) d.inv = s.inv ? 1 : 0;
        if (Array.isArray(s.r)) {
          d.r = [];
          s.r.forEach(function (r) {
            if (d.r.length >= 8 || !r) return;
            var w = Math.round(limitar(r.w, 0, 127, 127)), en = r.en ? 1 : 0;
            if (r.k === 'f') d.r.push({ k: 'f', h: Math.round(limitar(r.h, 0, 1439, 0)), d: Math.round(limitar(r.d, 1, 1440, 1)), w: w, en: en });
            else if (r.k === 'c') d.r.push({ k: 'c', a: Math.round(limitar(r.a, 0, 1439, 0)), b: Math.round(limitar(r.b, 0, 1439, 0)), on: Math.round(limitar(r.on, 1, 1440, 1)), off: Math.round(limitar(r.off, 0, 1440, 0)), w: w, en: en });
          });
        }
      });
    }
    if (Array.isArray(c.sen)) {
      c.sen.slice(0, 2).forEach(function (x, j) {
        if (!x) return;
        var d = n.sen[j];
        if (x.n !== undefined) d.n = String(x.n).slice(0, 24);
        if (x.en !== undefined) d.en = x.en ? 1 : 0;
        if (x.tp === 'dc' || x.tp === 'ac') d.tp = x.tp;
        if (x.mva !== undefined) d.mva = limitar(x.mva, 1, 2000, d.mva);
        if (x.div !== undefined) d.div = limitar(x.div, 0.05, 1, d.div);
        if (x.aj !== undefined) d.aj = limitar(x.aj, 0.5, 2, d.aj);
        if (x.sa !== undefined) d.sa = Math.round(limitar(x.sa, -2, 3, d.sa));
        if (x.min !== undefined) d.min = limitar(x.min, 0, 100, d.min);
        if (x.max !== undefined) d.max = limitar(x.max, 0, 100, d.max);
        if (x.corta !== undefined) d.corta = x.corta ? 1 : 0;
      });
    }
    var pin = null;
    if (c.pin !== undefined) {
      pin = String(c.pin);
      if (!/^[0-9]{0,8}$/.test(pin)) return { erro: 'O PIN deve ter até 8 números' };
    }
    return { cfg: n, pin: pin };
  }

  function cfgSaida() {
    var c = JSON.parse(JSON.stringify(sim.cfg));
    c.temPin = sim.pin ? 1 : 0;
    return c;
  }

  function ok(r) { enviar({ t: 'ok', r: r }); }
  function err(r, m) { enviar({ t: 'err', r: r, m: m }); }

  function saidaValida(s, todas) {
    return Number.isInteger(s) && s <= 3 && s >= (todas ? -1 : 0);
  }

  function processar(linha) {
    var m;
    if (sim.estragarProxima) { sim.estragarProxima = false; linha = linha.slice(0, -2); } // pedaço perdido
    // igual ao firmware: linha ilegível ou sem tipo responde com r = ""
    try { m = JSON.parse(linha); } catch (e) { err('', 'Mensagem inválida'); return; }
    if (!m || typeof m.t !== 'string' || !m.t) { err('', 'Falta o tipo da mensagem (t)'); return; }
    sim.recebidos.push(m);
    if (sim.respostasCongeladas) return;
    var t = m.t;
    if (sim.pin && !sim.autenticado && t !== 'oi' && t !== 'auth') { err(t, 'pin'); return; }
    var agora = agoraSim();
    switch (t) {
      case 'oi':
        enviar({ t: 'oi', fw: '1.0.0-sim', id: '1A2B', nome: sim.cfg.nome, mtu: Number(window.__bleMtu) || 23, pin: sim.pin ? 1 : 0, hv: sim.hv, rtc: sim.rtc, ep: agora });
        break;
      case 'auth':
        if (!sim.pin) {
          sim.autenticado = true;
          enviar({ t: 'auth', ok: 1 });
        } else if (Date.now() < sim.travaPinAte) {
          // §7.1: travado depois de 5 PINs errados (nem confere o PIN)
          enviar({ t: 'auth', ok: 0, espera: Math.ceil((sim.travaPinAte - Date.now()) / 1000) });
        } else if (String(m.pin) === sim.pin) {
          sim.autenticado = true; sim.errosPin = 0;
          enviar({ t: 'auth', ok: 1 });
        } else if (++sim.errosPin >= 5) {
          sim.errosPin = 0;
          sim.travaPinAte = Date.now() + 60000;
          enviar({ t: 'auth', ok: 0, espera: 60 });
          setTimeout(function () { cair('pin'); }, 150);
        } else {
          enviar({ t: 'auth', ok: 0 });
        }
        break;
      case 'hora': {
        var ep = Number(m.ep), tz = Number(m.tz);
        if (!isFinite(ep) || ep < 1700000000) { err(t, 'Hora inválida'); return; }
        var antes = agoraSim();
        var dif = antes ? ep - antes : 0;
        if (!sim.hv || Math.abs(dif) > 60) evento(-1, 11, 0, sim.hv ? dif : 0);
        if (!sim.hv) {
          // corrige os eventos sem hora
          var bootEp = ep - Math.floor((Date.now() - sim.bootEm) / 1000);
          sim.eventos.forEach(function (e) { if (e[0] === 0) e[0] = bootEp; });
        }
        sim.desvio = ep - agoraReal();
        sim.hv = 1;
        if (isFinite(tz) && tz >= -720 && tz <= 840 && tz !== sim.cfg.tz) sim.cfg.tz = Math.round(tz);
        aplicar();
        ok(t); enviar(estadoSt());
        break;
      }
      case 'cfg?':
        enviar({ t: 'cfg', c: cfgSaida() });
        break;
      case 'cfg': {
        var r = validarCfg(m.c);
        if (r.erro) { err(t, r.erro); return; }
        sim.cfg = r.cfg;
        if (r.pin !== null) sim.pin = r.pin;
        evento(-1, 12, 0, 0);
        aplicar();
        ok(t);
        if (sim.cairAntesDoCfg) {
          sim.cairAntesDoCfg = false;
          sim.alcance = false;
          setTimeout(function () { cair('controlador'); }, 30);
          break;
        }
        enviar({ t: 'cfg', c: cfgSaida() }); enviar(estadoSt());
        break;
      }
      case 'man': {
        var s = m.s, ate = Number(m.ate);
        if (!saidaValida(s, false)) { err(t, 'Saída inválida'); return; }
        if (!isFinite(ate) || ate < 0) { err(t, 'Campo "ate" inválido'); return; }
        var sd = sim.saidas[s];
        if (ate === 0) { sd.ma = 0; sd.mo = 0; }
        else {
          sd.ma = ate; sd.mo = m.on ? 1 : 0;
          if (m.on && sd.b) { sd.b = 0; evento(s, 24, 1, 0); }
        }
        aplicar();
        ok(t); enviar(estadoSt());
        break;
      }
      case 'pausa': {
        var sp = m.s, ateP = Number(m.ate);
        if (!saidaValida(sp, true)) { err(t, 'Saída inválida'); return; }
        if (!isFinite(ateP) || ateP < 0) { err(t, 'Campo "ate" inválido'); return; }
        var lista = sp === -1 ? [0, 1, 2, 3] : [sp];
        lista.forEach(function (i) {
          var x = sim.saidas[i];
          if (ateP > 0) { x.pa = ateP; x.ma = 0; x.mo = 0; } else x.pa = 0;
        });
        if (ateP > 0) evento(sp, 13, 1, Math.round((ateP - agora) / 3600));
        else evento(sp, 14, 1, 0);
        aplicar();
        ok(t); enviar(estadoSt());
        break;
      }
      case 'lib': {
        if (!saidaValida(m.s, false)) { err(t, 'Saída inválida'); return; }
        sim.saidas[m.s].b = 0;
        evento(m.s, 24, 1, 0);
        aplicar();
        ok(t); enviar(estadoSt());
        break;
      }
      case 'zero':
        if (sim.saidas.some(function (x) { return x.on; })) { err(t, 'Desligue todas as saídas antes de zerar'); return; }
        evento(-1, 30, 1, 0);
        ok(t);
        break;
      case 'log?': {
        var de = m.de === undefined ? null : Number(m.de);
        var l = sim.eventos.filter(function (e) { return de === null || e[0] >= de; });
        if (!l.length) { enviar({ t: 'log', l: [], fim: 1 }); break; }
        for (var i = 0; i < l.length; i += 20) {
          enviar({ t: 'log', l: l.slice(i, i + 20), fim: i + 20 >= l.length ? 1 : 0 });
        }
        break;
      }
      case 'reiniciar':
        ok(t);
        setTimeout(function () { cair('reinicio'); boot(); }, 500);
        break;
      default:
        err(t, 'Comando desconhecido');
    }
  }

  var backendSimulado = {
    nome: 'esp32-simulado',
    send: function (texto) {
      sim.buf += texto;
      var idx;
      while ((idx = sim.buf.indexOf('\n')) >= 0) {
        var linha = sim.buf.slice(0, idx);
        sim.buf = sim.buf.slice(idx + 1);
        if (linha.length) {
          (function (l) { setTimeout(function () { processar(l); }, 4 + sim.atrasoMs); })(linha);
        }
      }
      if (sim.buf.length > 4096) sim.buf = '';
    },
    conectou: function () {
      sim.conectado = true;
      sim.autenticado = !sim.pin;
      sim.buf = '';
    },
    desconectou: function () {
      sim.conectado = false;
      sim.autenticado = false;
      sim.buf = '';
    }
  };
  if (!window.__bleBackend) window.__bleBackend = backendSimulado;

  boot();

  // ---------- ganchos para os testes ----------
  window.__simFalso = {
    estado: sim,
    backend: backendSimulado,
    aparelho: aparelho,
    definirPin: function (p) { sim.pin = String(p || ''); },
    corrente: function (j, A) { sim.correnteFixa[j] = A === null || A === undefined ? null : Number(A); },
    picoValvula: function (i, A) { sim.picoValvula[i] = Number(A); },
    evento: function (s, c, o, v) { return evento(s, c, o, v); },
    bloquear: function (i, A) {
      var x = sim.saidas[i];
      evento(i, 22, 0, A || 5.2);
      x.b = 1;
      evento(i, 23, 3, A || 5.2);
      aplicar();
      if (sim.conectado && sim.autenticado) enviar(estadoSt());
    },
    silencio: function (s) { sim.silencio = !!s; },
    congelar: function (s) { sim.respostasCongeladas = !!s; },
    estragarProxima: function () { sim.estragarProxima = true; },
    prenderEscritas: function (x) { sim.escritasPresas = !!x; },
    atrasar: function (ms) { sim.atrasoMs = Number(ms) || 0; },
    cairAntesDoCfg: function () { sim.cairAntesDoCfg = true; },
    falharEscritas: function (pular, quantas) { sim.falhas = { pular: pular || 0, quantas: quantas || 0 }; },
    buffer: function () { return sim.buf; },
    cair: function () { cair('controlador'); },
    alcance: function (a) { sim.alcance = !!a; },
    cancelarEscolha: function (c) { sim.cancelarEscolha = !!c; },
    semHora: function () { sim.hv = 0; sim.desvio = 0; },
    cfg: function () { return JSON.parse(JSON.stringify(sim.cfg)); },
    definirCfg: function (c) { sim.cfg = JSON.parse(JSON.stringify(c)); aplicar(); },
    recebidos: function () { return sim.recebidos.slice(); },
    reiniciar: function () { cair('reinicio'); boot(); },
    agora: agoraSim
  };
})();
