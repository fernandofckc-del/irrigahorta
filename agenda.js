/*
 * agenda.js — contas da programação (PROTOCOLO.md §3 e §4).
 * As mesmas contas estão no firmware (agenda.h). Se mudar aqui, mude lá.
 * Navegador: window.Agenda · Node: module.exports
 */
(function (raiz, fabrica) {
  'use strict';
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.Agenda = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIA = 86400;

  // Dia da semana do dia local D: 0 = domingo … 6 = sábado (1/1/1970 foi quinta).
  function diaDaSemana(D) {
    return (((D + 4) % 7) + 7) % 7;
  }

  // Dia local de um instante local L (segundos).
  function diaLocal(L) {
    return Math.floor(L / DIA);
  }

  function num(x) {
    var n = Number(x);
    return isFinite(n) ? n : 0;
  }

  // A regra está ligada no instante local L (segundos)?
  function regraAtiva(regra, L) {
    if (!regra || num(regra.en) !== 1) return false;
    var w = num(regra.w);
    if (w === 0) return false;
    var D = diaLocal(L);
    for (var k = 0; k <= 1; k++) {
      var Dk = D - k;
      if (((w >> diaDaSemana(Dk)) & 1) === 0) continue;
      if (regra.k === 'f') {
        var ini = Dk * DIA + num(regra.h) * 60;
        if (L >= ini && L < ini + num(regra.d) * 60) return true;
      } else if (regra.k === 'c') {
        var a = num(regra.a), b = num(regra.b);
        var len = (((b - a) % 1440) + 1440) % 1440;
        if (len === 0) len = 1440;
        var W = Dk * DIA + a * 60;
        if (L < W || L >= W + len * 60) continue;
        var on = num(regra.on), off = num(regra.off);
        if (off === 0) return true;
        var periodo = (on + off) * 60;
        if (periodo <= 0) continue;
        if ((L - W) % periodo < on * 60) return true;
      }
    }
    return false;
  }

  // A saída está ligada pelo programa? (qualquer regra ativa)
  function programaAtivo(regras, L) {
    if (!regras || !regras.length) return false;
    for (var i = 0; i < regras.length; i++) {
      if (regraAtiva(regras[i], L)) return true;
    }
    return false;
  }

  // Primeiro minuto depois de ep (UTC, segundos) em que o programa muda.
  // tz em minutos. Devolve {ep, on} ou null se nada muda em maxMin minutos.
  function proximaMudanca(regras, ep, tz, maxMin) {
    if (maxMin === undefined || maxMin === null) maxMin = 8 * 1440;
    var desvio = num(tz) * 60;
    var atual = programaAtivo(regras, ep + desvio);
    var t = Math.floor(ep / 60) * 60 + 60;
    var limite = ep + maxMin * 60;
    for (; t <= limite; t += 60) {
      var on = programaAtivo(regras, t + desvio);
      if (on !== atual) return { ep: t, on: on };
    }
    return null;
  }

  // Intervalos ligados dentro do dia local D: [[iniMin, fimMin], …], fim exclusivo.
  function blocosDoDia(regras, D) {
    var blocos = [];
    var base = D * DIA;
    var ini = -1;
    for (var m = 0; m < 1440; m++) {
      var on = programaAtivo(regras, base + m * 60);
      if (on && ini < 0) ini = m;
      if (!on && ini >= 0) {
        blocos.push([ini, m]);
        ini = -1;
      }
    }
    if (ini >= 0) blocos.push([ini, 1440]);
    return blocos;
  }

  return {
    regraAtiva: regraAtiva,
    programaAtivo: programaAtivo,
    proximaMudanca: proximaMudanca,
    blocosDoDia: blocosDoDia,
    diaDaSemana: diaDaSemana,
    diaLocal: diaLocal
  };
});
