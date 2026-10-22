// testes/nativo/testa.cjs — testes automáticos do firmware rodando no PC (PROTOCOLO.md §10).
// Uso:  testes/nativo/compila.sh && node testes/nativo/testa.cjs [filtro]
// Cada teste abre o simulador (testes/nativo/rega), manda linhas pelo stdin e confere o stdout.
// Sem dependências (só módulos do Node).
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const BIN = process.env.REGA_BIN || path.join(__dirname, 'rega');
const EP0 = 1792584000;              // hora inicial do simulador (21/10/2026 12:00 UTC)
const TZ = -180;
const D0 = Math.floor((EP0 + TZ * 60) / 86400);  // dia local de EP0 (uma quarta-feira)
const QUARTA = 1 << 3;
const PROBLEMAS = /#ERRO|AddressSanitizer|LeakSanitizer|runtime error|ERROR: /;

// epoch de um horário local (dia D, hh:mm:ss) com o fuso -180
function epLocal(D, h, m, s = 0) { return D * 86400 + h * 3600 + m * 60 + s - TZ * 60; }

// ---------------- simulador ----------------
class Sim {
  constructor(args = []) {
    this.p = spawn(BIN, args, {
      env: Object.assign({}, process.env, {
        ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=0',
        UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1',
      }),
    });
    this.out = []; this.err = []; this.ob = ''; this.eb = '';
    this.po = 0; this.pe = 0; this.n = 0; this.avisos = [];
    this.p.stdout.setEncoding('utf8');
    this.p.stderr.setEncoding('utf8');
    this.p.stdout.on('data', (d) => { this.ob += d; this.ob = this.corta(this.ob, this.out); this.acorda(); });
    this.p.stderr.on('data', (d) => { this.eb += d; this.eb = this.corta(this.eb, this.err); this.acorda(); });
    this.fechou = new Promise((res) => this.p.on('close', (code, sinal) => { this.saida = { code, sinal }; this.acorda(); res(this.saida); }));
  }
  corta(buf, lista) {
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lista.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    return buf;
  }
  acorda() { const a = this.avisos; this.avisos = []; a.forEach((f) => f()); }
  espera(cond, ms = 120000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const tenta = () => {
        if (cond()) return res();
        if (this.saida) return rej(new Error('simulador terminou: ' + JSON.stringify(this.saida) + '\n' + this.err.slice(-30).join('\n')));
        if (Date.now() - t0 > ms) return rej(new Error('tempo esgotado'));
        this.avisos.push(tenta);
        setTimeout(tenta, 200).unref();
      };
      tenta();
    });
  }
  // Manda linhas (texto ou objeto) e espera tudo ser tratado.
  // Devolve { msgs: [objetos JSON do stdout], err: [linhas do stderr] }.
  async manda(...linhas) {
    const id = 'm' + (++this.n);
    const txt = linhas.flat().map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
    this.p.stdin.write(txt.join('\n') + '\n#marca ' + id + '\n');
    const marcaOut = JSON.stringify({ t: '#marca', m: id });
    let io = -1, ie = -1;
    await this.espera(() => {
      if (io < 0) io = this.out.indexOf(marcaOut, this.po);
      if (ie < 0) ie = this.err.indexOf('#marca ' + id, this.pe);
      return io >= 0 && ie >= 0;
    });
    const brutas = this.out.slice(this.po, io);
    const err = this.err.slice(this.pe, ie);
    this.po = io + 1; this.pe = ie + 1;
    const msgs = brutas.map((l) => {
      try { return JSON.parse(l); } catch (e) { throw new Error('stdout não é JSON: ' + l); }
    });
    for (const l of err) if (PROBLEMAS.test(l)) throw new Error('problema no stderr: ' + l);
    return { msgs, err };
  }
  async fim() {
    this.p.stdin.end();
    const s = await this.fechou;
    const ruim = this.err.filter((l) => PROBLEMAS.test(l));
    assert.deepStrictEqual(ruim, [], 'stderr com problemas');
    assert.strictEqual(s.code, 0, 'código de saída ' + s.code + '\n' + this.err.slice(-20).join('\n'));
  }
}

// ---------------- ajudantes ----------------
const doTipo = (r, t) => r.msgs.filter((m) => m.t === t);
const um = (r, t) => { const l = doTipo(r, t); assert.ok(l.length >= 1, 'faltou mensagem ' + t + ' em ' + JSON.stringify(r.msgs)); return l[l.length - 1]; };
const evs = (r) => doTipo(r, 'ev').map((m) => m.e);
const evC = (r, c) => evs(r).filter((e) => e[2] === c);
const pulsos = (r) => r.err.filter((l) => l.startsWith('#pulso ')).map(lePulso);
function lePulso(l) {
  const o = {};
  for (const par of l.split(' ').slice(1)) { const [k, v] = par.split('='); o[k] = isNaN(Number(v)) ? v : Number(v); }
  return o;
}
const perto = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ` ${a} não está perto de ${b} (±${tol})`);
function semErro(r, tipo) {
  const e = doTipo(r, 'err');
  assert.deepStrictEqual(e, [], 'erro inesperado em ' + tipo);
}
function okDe(r, tipo) { assert.ok(r.msgs.some((m) => m.t === 'ok' && m.r === tipo), 'faltou ok de ' + tipo + ': ' + JSON.stringify(r.msgs)); }
function erroDe(r, tipo, trecho) {
  const e = r.msgs.find((m) => m.t === 'err' && m.r === tipo);
  assert.ok(e, 'faltou err de ' + tipo + ': ' + JSON.stringify(r.msgs));
  if (trecho) assert.ok(e.m.includes(trecho), `mensagem "${e.m}" sem "${trecho}"`);
  assert.ok(!r.msgs.some((m) => m.t === 'ok' && m.r === tipo), 'não devia ter ok de ' + tipo);
  return e;
}
const SEMPRE = { k: 'c', a: 0, b: 0, on: 1, off: 0, w: 127, en: 1 };  // regra "sempre ligado"

// ---------------- testes ----------------
const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });

teste('boot: evento 10, fecha as duas válvulas (o=4) e 2º pulso (f2)', async () => {
  const s = new Sim();
  const r = await s.manda('#avanca 3.5', { t: 'log?' }, '#pinos');
  const l = um(r, 'log');
  assert.strictEqual(l.fim, 1);
  assert.deepStrictEqual(l.l[0], [EP0, -1, 10, 4, 0]);
  const fech = l.l.filter((e) => e[2] === 2);
  assert.deepStrictEqual(fech.map((e) => [e[1], e[3], e[4]]), [[0, 4, 0], [1, 4, 0]]);
  assert.strictEqual(l.l.length, 3, 'o 2º pulso não registra evento');
  const p = pulsos(r);
  assert.deepStrictEqual(p.map((x) => [x.valvula, x.gpio, x.lado]), [[0, 26, 'B'], [1, 33, 'B'], [0, 26, 'B'], [1, 33, 'B']]);
  for (const x of p) perto(x.dur, 80, 0.01, 'duração');
  for (let i = 1; i < p.length; i++) assert.ok(p[i].ini - p[i - 1].fim >= 300, 'folga entre pulsos');
  perto(p[2].ini - p[0].fim, 2000, 1, 'f2 da válvula 1');
  perto(p[3].ini - p[1].fim, 2000, 300, 'f2 da válvula 2');
  assert.ok(p[3].ini - p[1].fim >= 2000);
  assert.ok(r.err.some((x) => x === '#pinos 25=0 26=0 27=0 33=0 16=Z 17=Z 2=1'), 'pinos depois do boot (relés soltos)');
  await s.fim();
});

teste('oi, auth e PIN (5 erros desconecta)', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda({ t: 'oi' });
  assert.deepStrictEqual(um(r, 'oi'), { t: 'oi', fw: '1.0.0', id: '1A2B', nome: 'Rega-1A2B', mtu: 517, pin: 0, hv: 1, rtc: 0, ep: EP0 + 2 });
  r = await s.manda({ t: 'auth', pin: 'qualquer' });
  assert.deepStrictEqual(um(r, 'auth'), { t: 'auth', ok: 1 });
  erroDe(await s.manda({ t: 'cfg', c: { pin: '12a' } }), 'cfg', 'PIN');
  erroDe(await s.manda({ t: 'cfg', c: { pin: '123456789' } }), 'cfg', 'PIN');
  erroDe(await s.manda({ t: 'cfg', c: { pin: 1234 } }), 'cfg', 'PIN');
  r = await s.manda({ t: 'cfg', c: { pin: '0042' } });
  okDe(r, 'cfg');
  const c = um(r, 'cfg').c;
  assert.strictEqual(c.temPin, 1);
  assert.ok(!('pin' in c), 'o PIN nunca é mandado');
  r = await s.manda('#desconecta', '#avanca 2');
  assert.deepStrictEqual(r.msgs, []);
  r = await s.manda('#conecta 185', '#avanca 2.1');
  assert.deepStrictEqual(r.msgs, [], 'sem PIN certo não manda st/i/ev');
  r = await s.manda({ t: 'oi' });
  const oi = um(r, 'oi');
  assert.strictEqual(oi.pin, 1);
  assert.strictEqual(oi.mtu, 185);
  assert.deepStrictEqual(erroDe(await s.manda({ t: 'cfg?' }), 'cfg?'), { t: 'err', r: 'cfg?', m: 'pin' });
  erroDe(await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 + 9999 }), 'man', 'pin');
  for (let k = 1; k <= 4; k++) {
    r = await s.manda({ t: 'auth', pin: '42' });
    assert.deepStrictEqual(r.msgs, [{ t: 'auth', ok: 0 }]);
    assert.ok(!r.err.some((x) => x.startsWith('#desconectado')));
  }
  r = await s.manda({ t: 'auth' });
  assert.deepStrictEqual(r.msgs, [{ t: 'auth', ok: 0, espera: 60 }]);
  assert.ok(r.err.some((x) => x.startsWith('#desconectado')), '5º erro desconecta');
  r = await s.manda({ t: 'oi' });
  assert.deepStrictEqual(r.msgs, [], 'desconectado não responde');
  r = await s.manda('#conecta', { t: 'auth', pin: '0042' });
  assert.deepStrictEqual(r.msgs, [{ t: 'auth', ok: 0, espera: 60 }], 'travado: nem o PIN certo vale');
  r = await s.manda('#avanca 60', { t: 'auth', pin: '0042' }, '#avanca 1.1');
  assert.deepStrictEqual(um(r, 'auth'), { t: 'auth', ok: 1 });
  assert.ok(doTipo(r, 'st').length >= 1, 'depois do PIN certo manda st');
  r = await s.manda({ t: 'cfg', c: { pin: '' } });
  assert.strictEqual(um(r, 'cfg').c.temPin, 0);
  r = await s.manda('#desconecta', '#conecta', { t: 'cfg?' });
  assert.strictEqual(um(r, 'cfg').c.temPin, 0);
  await s.fim();
});

teste('quem põe o PIN continua liberado; outra conexão precisa do PIN', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda({ t: 'cfg', c: { pin: '7' } }, { t: 'cfg?' }, '#avanca 1.1');
  assert.strictEqual(um(r, 'cfg').c.temPin, 1);
  assert.deepStrictEqual(doTipo(r, 'err'), []);
  assert.ok(doTipo(r, 'st').length >= 2 && doTipo(r, 'i').length >= 3, 'st e i continuam');
  r = await s.manda('#desconecta', '#conecta', { t: 'cfg?' }, { t: 'log?' }, '#avanca 1.1');
  assert.deepStrictEqual(r.msgs, [{ t: 'err', r: 'cfg?', m: 'pin' }, { t: 'err', r: 'log?', m: 'pin' }]);
  await s.fim();
});

teste('hora: evento 11, fuso gravado, erros', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda({ t: 'hora', ep: EP0 + 30, tz: -180 });
  okDe(r, 'hora');
  assert.strictEqual(um(r, 'st').ep, EP0 + 30);
  assert.deepStrictEqual(evC(r, 11), [], 'mudou menos de 60 s: sem evento');
  r = await s.manda({ t: 'hora', ep: EP0 + 1000, tz: -180 });
  const e = evC(r, 11);
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0][0], EP0 + 1000);
  assert.deepStrictEqual(e[0].slice(1, 4), [-1, 11, 1]);
  perto(e[0][4], 970, 1, 'diferença');
  r = await s.manda({ t: 'hora', ep: EP0 + 900 });
  assert.strictEqual(evC(r, 11)[0][4] < -60, true, 'diferença negativa');
  erroDe(await s.manda({ t: 'hora', ep: 123 }), 'hora');
  erroDe(await s.manda({ t: 'hora', ep: 'abc' }), 'hora');
  erroDe(await s.manda({ t: 'hora' }), 'hora');
  erroDe(await s.manda({ t: 'hora', ep: EP0, tz: 5000 }), 'hora', 'Fuso');
  r = await s.manda({ t: 'hora', ep: EP0 + 900, tz: -120 }, { t: 'cfg?' });
  okDe(r, 'hora');
  assert.strictEqual(um(r, 'cfg').c.tz, -120);
  assert.ok(r.err.some((x) => x.startsWith('#nvs grava cfg')), 'fuso gravado no NVS');
  r = await s.manda('#reinicia', { t: 'cfg?' });
  assert.strictEqual(um(r, 'cfg').c.tz, -120, 'fuso continua depois de reiniciar');
  // depois de 2038 (time_t de 64 bits: núcleo 3.x e PC). No núcleo 2.x o firmware recusa com err.
  r = await s.manda({ t: 'hora', ep: 2200000000 });
  okDe(r, 'hora');
  assert.strictEqual(um(r, 'st').ep, 2200000000);
  erroDe(await s.manda({ t: 'hora', ep: 4102444801 }), 'hora', 'inválida');
  await s.fim();
});

teste('cfg: padrões, limites, erros e nomes com acento', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda({ t: 'cfg?' });
  assert.deepStrictEqual(um(r, 'cfg').c, {
    v: 1, nome: 'Rega-1A2B', tz: -180, pms: 80, f2: 1, temPin: 0,
    s: [{ n: 'Válvula 1', en: 1, inv: 0, r: [] }, { n: 'Válvula 2', en: 1, inv: 0, r: [] },
      { n: 'Hidroponia', en: 1, inv: 0, r: [] }, { n: 'Relé 2', en: 0, inv: 0, r: [] }],
    sen: [{ n: 'Válvulas', en: 0, tp: 'dc', mva: 185, div: 0.667, aj: 1, sa: -2, min: 0.1, max: 0, corta: 0 },
      { n: 'Bomba', en: 0, tp: 'ac', mva: 33.3, div: 1, aj: 1, sa: 2, min: 0.1, max: 0, corta: 0 }],
  });
  const muitas = [];
  for (let k = 0; k < 11; k++) muitas.push({ k: 'f', h: k * 60, d: 5, w: 127, en: 1 });
  r = await s.manda({ t: 'cfg', c: {
    nome: 'AçãoAçãoAçãoAção', tz: 9999, pms: 5, f2: 0, v: 7, temPin: 1,
    s: [{ n: 'Irrigação do Pomar: Cítrico', en: 0, inv: 1, r: [
      { k: 'f', h: 2000, d: 0, w: 300, en: 1 }, { k: 'x', h: 1 }, { k: 'c', a: -5, b: 1500, on: 0, off: 9999 },
      { k: 'f', h: 10 }, 'lixo', { k: 'f', h: 61.6, d: 1440.4, w: -3, en: true }] },
    { n: 'Tab\tcom\ncontrole' }, { r: muitas }],
    sen: [{ n: 'Sensor çç', tp: 'ac', mva: 0, div: 2, aj: 0.1, sa: 7, min: -1, max: 500, corta: 5, en: true }],
  } });
  okDe(r, 'cfg');
  assert.deepStrictEqual(evC(r, 12).map((e) => e.slice(1)), [[-1, 12, 1, 0]]);
  assert.ok(doTipo(r, 'st').length === 1, 'cfg responde ok + cfg + st');
  const c = um(r, 'cfg').c;
  assert.strictEqual(c.nome, 'AçãoAçãoAçãoA');
  assert.strictEqual(Buffer.byteLength(c.nome), 19);
  assert.strictEqual(c.tz, 840);
  assert.strictEqual(c.pms, 10);
  assert.strictEqual(c.f2, 0);
  assert.strictEqual(c.v, 1);
  assert.strictEqual(c.temPin, 0);
  assert.strictEqual(c.s[0].n, 'Irrigação do Pomar: C', 'corta sem partir o í');
  assert.strictEqual(c.s[0].en, 0);
  assert.strictEqual(c.s[0].inv, 1);
  assert.deepStrictEqual(c.s[0].r, [
    { k: 'f', h: 1439, d: 1, w: 127, en: 1 },
    { k: 'c', a: 0, b: 1439, on: 1, off: 1440, w: 127, en: 1 },
    { k: 'f', h: 62, d: 1440, w: 0, en: 1 }]);
  assert.strictEqual(c.s[1].n, 'Tabcomcontrole');
  assert.strictEqual(c.s[2].r.length, 8, 'no máximo 8 regras');
  assert.strictEqual(c.s[2].r[7].h, 7 * 60);
  assert.deepStrictEqual(c.s[3], { n: 'Relé 2', en: 0, inv: 0, r: [] }, 'saída que não veio fica como estava');
  assert.deepStrictEqual(c.sen[0], { n: 'Sensor çç', en: 1, tp: 'ac', mva: 1, div: 1, aj: 0.5, sa: 3, min: 0, max: 100, corta: 1 });
  assert.strictEqual(c.sen[1].n, 'Bomba');
  const guardada = c;

  erroDe(await s.manda({ t: 'cfg', c: { pms: 'abc' } }), 'cfg', 'pms');
  erroDe(await s.manda({ t: 'cfg', c: { sen: [{ tp: 'xx' }] } }), 'cfg', 'sen[0].tp');
  erroDe(await s.manda({ t: 'cfg', c: { nome: '' } }), 'cfg', 'nome');
  erroDe(await s.manda({ t: 'cfg', c: { nome: '\n\t' } }), 'cfg', 'nome');
  erroDe(await s.manda({ t: 'cfg', c: { nome: 5 } }), 'cfg', 'nome');
  erroDe(await s.manda({ t: 'cfg', c: { s: 5 } }), 'cfg', 's');
  erroDe(await s.manda({ t: 'cfg', c: { s: [5] } }), 'cfg', 's[0]');
  erroDe(await s.manda({ t: 'cfg', c: { s: [{}, { r: [{ k: 'f', h: 'x', d: 1 }] }] } }), 'cfg', 's[1].r[0].h');
  erroDe(await s.manda({ t: 'cfg', c: { f2: 'sim' } }), 'cfg', 'f2');
  erroDe(await s.manda({ t: 'cfg' }), 'cfg', 'Falta');
  erroDe(await s.manda({ t: 'cfg', c: [1, 2] }), 'cfg', 'Falta');
  r = await s.manda({ t: 'cfg', c: { tz: -180, pms: 'abc', nome: 'Outro' } });
  erroDe(r, 'cfg');
  r = await s.manda({ t: 'cfg?' });
  assert.deepStrictEqual(um(r, 'cfg').c, guardada, 'erro não muda nada');

  r = await s.manda('#reinicia', { t: 'cfg?' });
  assert.deepStrictEqual(um(r, 'cfg').c, guardada, 'configuração gravada volta depois de reiniciar');
  await s.fim();
});

teste('man: liga, desliga, vence e volta ao programa', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 + 60 }, '#pinos');
  okDe(r, 'man');
  assert.deepStrictEqual(evs(r).map((e) => e.slice(1)), [[2, 1, 1, 0]]);
  const st = um(r, 'st');
  assert.deepStrictEqual(st.s[2], { on: 1, mo: 1, ma: EP0 + 60, pa: 0, b: 0, hj: 0, pk: -1 });
  assert.ok(r.err.some((x) => x.startsWith('#pinos ') && x.includes(' 16=1 ')), 'relé ligado');
  r = await s.manda('#avanca 60');
  const off = evC(r, 2);
  assert.strictEqual(off.length, 1);
  assert.deepStrictEqual(off[0].slice(1), [2, 2, 0, 0]);
  assert.strictEqual(off[0][0], EP0 + 60, 'desliga quando vence');
  const st2 = um(r, 'st').s[2];
  assert.deepStrictEqual([st2.on, st2.mo, st2.ma], [0, 0, 0]);
  perto(st2.hj, 59, 1, 'hj');
  erroDe(await s.manda({ t: 'man', s: 7, on: 1, ate: EP0 + 999 }), 'man', 'Saída');
  erroDe(await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 }), 'man', 'passou');
  erroDe(await s.manda({ t: 'man', s: 2, ate: EP0 + 999 }), 'man', 'on');
  erroDe(await s.manda({ t: 'man', s: 2, on: 1, ate: -5 }), 'man');
  // programa sempre ligado + manual desligando
  r = await s.manda({ t: 'cfg', c: { s: [{}, {}, { r: [SEMPRE] }] } });
  assert.deepStrictEqual(evC(r, 1).map((e) => e.slice(1)), [[2, 1, 0, 0]]);
  r = await s.manda({ t: 'man', s: 2, on: 0, ate: EP0 + 500 });
  assert.deepStrictEqual(evC(r, 2).map((e) => e.slice(1)), [[2, 2, 1, 0]]);
  assert.deepStrictEqual([um(r, 'st').s[2].mo, um(r, 'st').s[2].on], [0, 0]);
  r = await s.manda({ t: 'man', s: 2, ate: 0 });
  okDe(r, 'man');
  assert.deepStrictEqual(evC(r, 1).map((e) => e.slice(1)), [[2, 1, 0, 0]], 'ate=0 volta ao programa');
  // válvula: abre com pulso no lado A
  r = await s.manda({ t: 'man', s: 0, on: 1, ate: EP0 + 500 }, '#avanca 0.5');
  assert.deepStrictEqual(pulsos(r).map((p) => [p.valvula, p.gpio, p.lado]), [[0, 25, 'A']]);
  assert.deepStrictEqual(evC(r, 1).map((e) => e.slice(1)), [[0, 1, 1, 0]]);
  // saída desabilitada não liga nem com manual
  r = await s.manda({ t: 'man', s: 3, on: 1, ate: EP0 + 500 });
  assert.deepStrictEqual(evs(r), []);
  assert.strictEqual(um(r, 'st').s[3].on, 0);
  await s.fim();
});

teste('pausa: uma saída, todas (-1), cancela manual, cancela pausa', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', { t: 'cfg', c: { s: [{}, {}, { r: [SEMPRE] }] } });
  let r = await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 + 900 }, { t: 'pausa', s: 2, ate: EP0 + 1 + 3600 });
  okDe(r, 'pausa');
  const p = evC(r, 13);
  assert.deepStrictEqual(p.map((e) => e.slice(1)), [[2, 13, 1, 1]]);
  assert.deepStrictEqual(evC(r, 2).map((e) => e.slice(1)), [[2, 2, 2, 0]], 'desliga com origem 2');
  let st = um(r, 'st').s[2];
  assert.deepStrictEqual([st.on, st.mo, st.ma, st.pa], [0, 0, 0, EP0 + 3601], 'pausar cancela o manual');
  r = await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 + 900 });
  assert.deepStrictEqual(evC(r, 1).map((e) => e.slice(1)), [[2, 1, 1, 0]], 'manual vale mais que pausa');
  r = await s.manda({ t: 'man', s: 2, ate: 0 });
  assert.deepStrictEqual(evC(r, 2).map((e) => e.slice(1)), [[2, 2, 2, 0]], 'sem manual volta a pausa');
  r = await s.manda({ t: 'pausa', s: 2, ate: 0 });
  assert.deepStrictEqual(evs(r).map((e) => e.slice(1)), [[2, 14, 1, 0], [2, 1, 0, 0]]);
  r = await s.manda({ t: 'pausa', s: 2, ate: 0 });
  assert.deepStrictEqual(evs(r), [], 'cancelar sem pausa: sem evento');
  okDe(r, 'pausa');
  r = await s.manda({ t: 'pausa', s: -1, ate: EP0 + 1 + 5400 });
  assert.deepStrictEqual(evC(r, 13).map((e) => e.slice(1)), [[-1, 13, 1, 1.5]]);
  st = um(r, 'st').s;
  assert.deepStrictEqual(st.map((x) => x.pa), [EP0 + 5401, EP0 + 5401, EP0 + 5401, EP0 + 5401]);
  r = await s.manda({ t: 'pausa', s: -1, ate: 0 });
  assert.deepStrictEqual(evC(r, 14).map((e) => e.slice(1)), [[-1, 14, 1, 0]]);
  assert.deepStrictEqual(um(r, 'st').s.map((x) => x.pa), [0, 0, 0, 0]);
  erroDe(await s.manda({ t: 'pausa', s: 9, ate: EP0 + 99 }), 'pausa', 'Saída');
  erroDe(await s.manda({ t: 'pausa', s: 1, ate: EP0 - 99 }), 'pausa', 'passou');
  erroDe(await s.manda({ t: 'pausa', s: 1 }), 'pausa');
  // pausa vence sozinha
  r = await s.manda({ t: 'pausa', s: 2, ate: EP0 + 1 + 5 }, '#avanca 5');
  assert.deepStrictEqual(evC(r, 1).map((e) => e.slice(1)), [[2, 1, 0, 0]]);
  assert.strictEqual(um(r, 'st').s[2].pa, 0);
  await s.fim();
});

teste('gravação: pausa, bloqueio e cfg sobrevivem ao reinício; manual não', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda(
    { t: 'cfg', c: { nome: 'Sítio Bão', s: [{}, {}, { r: [SEMPRE] }], sen: [{}, { en: 1, max: 2, corta: 1, sa: 2 }] } },
    { t: 'pausa', s: 1, ate: EP0 + 86400 }, { t: 'man', s: 0, on: 1, ate: EP0 + 5000 },
    '#corrente 1 3', '#avanca 3');
  assert.ok(evC(r, 23).length === 1, 'bloqueou');
  r = await s.manda('#corrente 1 0', '#avanca 0.5', '#reinicia', '#avanca 4', { t: 'cfg?' }, { t: 'log?' });
  const st = um(r, 'st').s;
  assert.deepStrictEqual(st.map((x) => [x.on, x.ma, x.pa, x.b]),
    [[0, 0, 0, 0], [0, 0, EP0 + 86400, 0], [0, 0, 0, 1], [0, 0, 0, 0]]);
  assert.strictEqual(um(r, 'cfg').c.nome, 'Sítio Bão');
  const l = um(r, 'log').l;
  assert.deepStrictEqual(l.map((e) => e.slice(1, 4)), [[-1, 10, 4], [0, 2, 4], [1, 2, 4]], 'eventos ficam só na memória');
  await s.fim();
});

teste('regra de horário fixo: passa da meia-noite e respeita os dias', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', '#desconecta');
  await s.manda(`#hora ${epLocal(D0, 23, 49, 30)}`, '#avanca 1', '#conecta');
  let r = await s.manda({ t: 'cfg', c: { s: [{}, {}, { r: [{ k: 'f', h: 23 * 60 + 50, d: 20, w: QUARTA, en: 1 }] }] } }, '#agenda 2');
  assert.ok(r.err.includes(`#agenda s=2 ativo=0 prox=${epLocal(D0, 23, 50)} on=1 blocos=[[1430,1440]]`), r.err.join('\n'));
  r = await s.manda('#avanca 40');
  assert.deepStrictEqual(evs(r), [[epLocal(D0, 23, 50), 2, 1, 0, 0]]);
  await s.manda('#desconecta', `#hora ${epLocal(D0 + 1, 0, 9, 30)}`, '#avanca 1', '#conecta');
  r = await s.manda('#agenda 2', '#avanca 40');
  assert.ok(r.err.includes(`#agenda s=2 ativo=1 prox=${epLocal(D0 + 1, 0, 10)} on=0 blocos=[[0,10]]`), r.err.join('\n'));
  assert.deepStrictEqual(evs(r), [[epLocal(D0 + 1, 0, 10), 2, 2, 0, 0]]);
  // quinta-feira não está nos dias: não liga às 23:50 de quinta
  await s.manda('#desconecta', `#hora ${epLocal(D0 + 1, 23, 49, 30)}`, '#avanca 1', '#conecta');
  r = await s.manda('#agenda 2', '#avanca 40');
  assert.deepStrictEqual(evs(r), []);
  assert.ok(r.err.includes(`#agenda s=2 ativo=0 prox=${epLocal(D0 + 7, 23, 50)} on=1 blocos=[[0,10]]`), r.err.join('\n'));
  // regra desabilitada nunca liga
  await s.manda({ t: 'cfg', c: { s: [{}, {}, { r: [{ k: 'f', h: 23 * 60 + 50, d: 20, w: 127, en: 0 }] }] } });
  r = await s.manda('#agenda 2');
  assert.ok(r.err.includes('#agenda s=2 ativo=0 prox=-1 on=0 blocos=[]'), r.err.join('\n'));
  await s.fim();
});

teste('regra de ciclo: janela passando da meia-noite, liga/desliga nos minutos certos', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', '#desconecta', `#hora ${epLocal(D0, 22, 59, 50)}`, '#avanca 1', '#conecta');
  // janela 23:00 → 01:00, 15 ligado / 15 desligado, só quarta
  let r = await s.manda({ t: 'cfg', c: { s: [{}, {}, { r: [{ k: 'c', a: 23 * 60, b: 60, on: 15, off: 15, w: QUARTA, en: 1 }] }] } }, '#agenda 2');
  assert.ok(r.err.includes(`#agenda s=2 ativo=0 prox=${epLocal(D0, 23, 0)} on=1 blocos=[[1380,1395],[1410,1425]]`), r.err.join('\n'));
  await s.manda('#desconecta');
  const conferir = async (D, h, m, esperado) => {
    await s.manda(`#hora ${epLocal(D, h, m) - 20}`, '#avanca 1', '#conecta');
    const r2 = await s.manda('#avanca 30', '#desconecta');
    const e = evs(r2).map((x) => [x[0], x[2]]);
    assert.deepStrictEqual(e, esperado === null ? [] : [[epLocal(D, h, m), esperado]], `às ${h}:${m}`);
  };
  await conferir(D0, 23, 0, 1);
  await conferir(D0, 23, 15, 2);
  await conferir(D0, 23, 30, 1);
  await conferir(D0 + 1, 0, 0, 1);    // depois da meia-noite ainda é a janela de quarta
  await conferir(D0 + 1, 0, 15, 2);
  await conferir(D0 + 1, 0, 30, 1);
  await conferir(D0 + 1, 0, 45, 2);
  await conferir(D0 + 1, 1, 0, null);  // janela acabou (já estava desligado)
  await conferir(D0 + 1, 23, 0, null); // quinta não está nos dias
  // off = 0: ligado direto na janela inteira (06:00 → 18:00)
  await s.manda('#conecta', { t: 'cfg', c: { s: [{}, {}, { r: [{ k: 'c', a: 360, b: 1080, on: 5, off: 0, w: 127, en: 1 }] }] } });
  r = await s.manda('#agenda 2');
  assert.ok(r.err.some((x) => x.endsWith('blocos=[[360,1080]]')), r.err.join('\n'));
  await s.fim();
});

teste('fila de pulsos: um de cada vez, 300 ms de folga, f2, inv e pms', async () => {
  const s = new Sim();
  await s.manda('#avanca 3.5');
  let r = await s.manda({ t: 'man', s: 0, on: 1, ate: EP0 + 600 }, { t: 'man', s: 1, on: 1, ate: EP0 + 600 }, '#avanca 1');
  let p = pulsos(r);
  assert.deepStrictEqual(p.map((x) => [x.valvula, x.gpio]), [[0, 25], [1, 27]]);
  assert.ok(p[1].ini - p[0].fim >= 300 && p[1].ini - p[0].fim < 302, 'folga de 300 ms');
  r = await s.manda({ t: 'man', s: 0, on: 0, ate: EP0 + 600 }, { t: 'man', s: 1, on: 0, ate: EP0 + 600 }, '#avanca 3');
  p = pulsos(r);
  assert.deepStrictEqual(p.map((x) => [x.valvula, x.gpio]), [[0, 26], [1, 33], [0, 26], [1, 33]]);
  for (let i = 1; i < p.length; i++) assert.ok(p[i].ini - p[i - 1].fim >= 300);
  perto(p[2].ini - p[0].fim, 2000, 1, 'f2');
  assert.deepStrictEqual(evs(r).map((e) => e.slice(1)), [[0, 2, 1, 0], [1, 2, 1, 0]], '2º pulso sem evento');
  // f2 = 0, pms = 150, válvula 1 invertida
  await s.manda({ t: 'cfg', c: { f2: 0, pms: 150, s: [{ inv: 1 }] } });
  r = await s.manda({ t: 'man', s: 0, on: 1, ate: EP0 + 600 }, '#avanca 1', { t: 'man', s: 0, on: 0, ate: EP0 + 600 }, '#avanca 3');
  p = pulsos(r);
  assert.deepStrictEqual(p.map((x) => [x.gpio, x.dur]), [[26, 150], [25, 150]], 'inv troca os lados; sem f2');
  // abrir logo depois de fechar cancela o 2º pulso de fechar
  await s.manda({ t: 'cfg', c: { f2: 1, pms: 80, s: [{ inv: 0 }] } });
  r = await s.manda({ t: 'man', s: 1, on: 1, ate: EP0 + 600 }, '#avanca 1', { t: 'man', s: 1, on: 0, ate: EP0 + 600 },
    '#avanca 0.5', { t: 'man', s: 1, on: 1, ate: EP0 + 600 }, '#avanca 4');
  p = pulsos(r);
  assert.deepStrictEqual(p.map((x) => x.gpio), [27, 33, 27]);
  // válvula desabilitada fecha com origem 7
  r = await s.manda({ t: 'cfg', c: { s: [{}, { en: 0 }] } }, '#avanca 1');
  assert.deepStrictEqual(evC(r, 2).map((e) => e.slice(1)), [[1, 2, 7, 0]]);
  await s.fim();
});

teste('sensor de pulso (sa=-2): pico e alarme 20', async () => {
  const s = new Sim();
  await s.manda('#avanca 3.5', { t: 'cfg', c: { sen: [{ en: 1, min: 0.2 }] } });
  let r = await s.manda('#corrente 0 0.6', { t: 'man', s: 0, on: 1, ate: EP0 + 600 }, '#avanca 1.5');
  const ab = evC(r, 1);
  assert.strictEqual(ab.length, 1);
  perto(ab[0][4], 0.6, 0.03, 'pico no evento');
  perto(um(r, 'st').s[0].pk, ab[0][4], 0, 'pk no st');
  assert.strictEqual(um(r, 'st').s[2].pk, -1, 'relé não tem pk');
  assert.deepStrictEqual(evC(r, 20), []);
  assert.strictEqual(um(r, 'i').i[0], 0, 'fora do pulso não tem corrente');
  r = await s.manda('#corrente 0 0', { t: 'man', s: 0, ate: 0 }, '#avanca 1.5');
  assert.deepStrictEqual(evs(r).map((e) => e.slice(1, 4)), [[0, 2, 0], [0, 20, 0]]);
  perto(evs(r)[0][4], 0, 0.03, 'pico sem corrente (só ruído)');
  assert.strictEqual(evs(r)[1][4], evs(r)[0][4]);
  assert.strictEqual(um(r, 'st').s[0].pk, evs(r)[0][4]);
  // sem sensor de pulso: pk = -1 e v = 0
  r = await s.manda({ t: 'cfg', c: { sen: [{ en: 0 }] } }, '#corrente 0 0.6', { t: 'man', s: 0, on: 1, ate: EP0 + 600 }, '#avanca 1.5');
  assert.deepStrictEqual(evC(r, 1).map((e) => e.slice(1)), [[0, 1, 1, 0]]);
  assert.strictEqual(um(r, 'st').s[0].pk, -1);
  await s.fim();
});

teste('sensor da bomba (sa=2): alarmes 21, 22, bloqueio 23 e liberação 24', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', { t: 'cfg', c: { sen: [{}, { en: 1, min: 0.5, max: 3 }] } });
  let r = await s.manda('#corrente 1 0', { t: 'man', s: 2, on: 1, ate: EP0 + 3600 }, '#avanca 7.6');
  assert.deepStrictEqual(evC(r, 21), [], 'antes de 5 s + 3 s não avisa');
  r = await s.manda('#avanca 1');
  const a21 = evC(r, 21);
  assert.strictEqual(a21.length, 1);
  assert.deepStrictEqual(a21[0].slice(1, 4), [2, 21, 1]);
  perto(a21[0][4], 0, 0.05);
  r = await s.manda('#avanca 10', '#corrente 1 1.2', '#avanca 2', '#corrente 1 0', '#avanca 5');
  assert.deepStrictEqual(evC(r, 21), [], 'uma vez por vez que liga');
  r = await s.manda('#corrente 1 4', '#avanca 1.8');
  assert.deepStrictEqual(evC(r, 22), [], 'precisa de 2 s');
  r = await s.manda('#avanca 0.5');
  const a22 = evC(r, 22);
  assert.strictEqual(a22.length, 1);
  perto(a22[0][4], 4, 0.05);
  assert.deepStrictEqual(evC(r, 23), [], 'corta = 0 não bloqueia');
  assert.strictEqual(um(r, 'st').s[2].on, 1);
  // corta = 1: nova vez que liga → 22, 23 e desliga com origem 3
  r = await s.manda({ t: 'cfg', c: { sen: [{}, { corta: 1 }] } }, { t: 'man', s: 2, on: 0, ate: EP0 + 3600 },
    { t: 'man', s: 2, on: 1, ate: EP0 + 3600 }, '#avanca 2.5');
  assert.deepStrictEqual(evs(r).map((e) => e.slice(1, 4)), [[-1, 12, 1], [2, 2, 1], [2, 1, 1], [2, 22, 1], [2, 23, 3], [2, 2, 3]]);
  let st = um(r, 'st').s[2];
  assert.deepStrictEqual([st.on, st.b], [0, 1]);
  // bloqueada fica desligada mesmo com o manual
  r = await s.manda('#corrente 1 0', '#avanca 2');
  assert.strictEqual(um(r, 'st').s[2].on, 0);
  r = await s.manda({ t: 'lib', s: 2 });
  okDe(r, 'lib');
  assert.deepStrictEqual(evs(r).map((e) => e.slice(1, 4)), [[2, 24, 1], [2, 1, 1]]);
  assert.strictEqual(um(r, 'st').s[2].b, 0);
  r = await s.manda({ t: 'lib', s: 2 });
  assert.deepStrictEqual(evs(r), [], 'lib sem bloqueio: sem evento');
  erroDe(await s.manda({ t: 'lib', s: 'x' }), 'lib');
  // bloqueia de novo e sai com "man" ligando
  r = await s.manda('#corrente 1 5', '#avanca 2.5');
  assert.strictEqual(evC(r, 23).length, 1);
  r = await s.manda('#corrente 1 1', { t: 'man', s: 2, on: 1, ate: EP0 + 3600 });
  assert.deepStrictEqual(evs(r).map((e) => e.slice(1, 4)), [[2, 24, 1], [2, 1, 1]]);
  st = um(r, 'st').s[2];
  assert.deepStrictEqual([st.on, st.b], [1, 0]);
  await s.fim();
});

teste('medição: DC com sinal e zona morta, AC RMS, ajuste aj', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', { t: 'cfg', c: { sen: [{ en: 1, sa: -1 }, { en: 1, sa: -1 }] } });
  const mede = async (linhas) => {
    const r = await s.manda(linhas, '#avanca 1');
    return um(r, 'i').i;
  };
  let i = await mede(['#corrente 0 1', '#corrente 1 2']);
  perto(i[0], 1, 0.02, 'DC');
  perto(i[1], 2, 0.02, 'AC');
  i = await mede(['#corrente 0 -1.5', '#corrente 1 0']);
  perto(i[0], -1.5, 0.02, 'DC negativo');
  perto(i[1], 0, 0.06, 'AC zero');
  i = await mede(['#corrente 0 0.015', '#corrente 1 10']);
  assert.strictEqual(i[0], 0, 'zona morta');
  perto(i[1], 10, 0.1, 'AC 10 A');
  // trocar o divisor muda o zero do sensor: precisa zerar de novo (sem corrente)
  let r0 = await s.manda({ t: 'cfg', c: { sen: [{ aj: 1.5, mva: 100, div: 1 }, { aj: 0.8 }] } }, '#corrente 0 0', '#corrente 1 0', { t: 'zero' });
  okDe(r0, 'zero');
  i = await mede(['#corrente 0 2', '#corrente 1 5']);
  perto(i[0], 3, 0.03, 'aj 1.5');
  perto(i[1], 4, 0.05, 'aj 0.8');
  const r = await s.manda({ t: 'cfg', c: { sen: [{ en: 0 }] } }, '#avanca 0.3');
  assert.strictEqual(um(r, 'i').i[0], null, 'desabilitado = null');
  assert.strictEqual(um(r, 'st').i[0], null);
  await s.fim();
});

teste('zero: recusa com saída ligada, evento 30', async () => {
  const s = new Sim();
  await s.manda('#avanca 3.5');
  let r = await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 + 600 }, { t: 'zero' });
  assert.deepStrictEqual(doTipo(r, 'err'), [{ t: 'err', r: 'zero', m: 'Desligue todas as saídas antes de zerar' }]);
  r = await s.manda({ t: 'man', s: 2, ate: 0 }, { t: 'man', s: 1, on: 1, ate: EP0 + 600 }, '#avanca 0.5', { t: 'zero' });
  erroDe(r, 'zero', 'Desligue');
  r = await s.manda({ t: 'man', s: 1, ate: 0 }, '#avanca 3', { t: 'zero' });
  okDe(r, 'zero');
  assert.deepStrictEqual(evC(r, 30).map((e) => e.slice(1)), [[-1, 30, 1, 0]]);
  assert.ok(r.err.filter((x) => x.includes('zerado')).length === 2);
  await s.fim();
});

teste('log?: pedaços de 20, fim, filtro "de" e anel de 200', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  const cmds = [];
  for (let k = 0; k < 15; k++) cmds.push({ t: 'man', s: 2, on: 1, ate: EP0 + 600 }, { t: 'man', s: 2, ate: 0 });
  await s.manda(cmds, '#avanca 2');
  await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 + 600 }, '#avanca 1', { t: 'man', s: 2, ate: 0 });
  let r = await s.manda({ t: 'log?' });
  let ls = doTipo(r, 'log');
  assert.deepStrictEqual(ls.map((x) => [x.l.length, x.fim]), [[20, 0], [15, 1]]);
  const todos = ls.flatMap((x) => x.l);
  assert.deepStrictEqual(todos[0].slice(1), [-1, 10, 4, 0]);
  for (let k = 1; k < todos.length; k++) assert.ok(todos[k][0] >= todos[k - 1][0], 'em ordem');
  const ultimo = todos[todos.length - 1][0];
  r = await s.manda({ t: 'log?', de: ultimo });
  ls = doTipo(r, 'log');
  assert.strictEqual(ls.length, 1);
  assert.ok(ls[0].l.length >= 1 && ls[0].l.every((e) => e[0] >= ultimo));
  r = await s.manda({ t: 'log?', de: EP0 + 99999 });
  assert.deepStrictEqual(doTipo(r, 'log'), [{ t: 'log', l: [], fim: 1 }]);
  erroDe(await s.manda({ t: 'log?', de: 'ontem' }), 'log?');
  const mais = [];
  for (let k = 0; k < 100; k++) mais.push({ t: 'man', s: 2, on: 1, ate: EP0 + 600 }, { t: 'man', s: 2, ate: 0 });
  for (let k = 0; k < mais.length; k += 10) await s.manda(mais.slice(k, k + 10));
  r = await s.manda({ t: 'log?' });
  ls = doTipo(r, 'log');
  assert.strictEqual(ls.length, 10);
  assert.strictEqual(ls.flatMap((x) => x.l).length, 200, 'guarda só os últimos 200');
  assert.ok(!ls[0].l.some((e) => e[2] === 10), 'o boot já saiu do anel');
  await s.fim();
});

teste('hora chega depois: eventos sem hora ganham ep pelo tempo desde o boot', async () => {
  const s = new Sim(['--sem-hora']);
  let r = await s.manda({ t: 'oi' }, '#avanca 2');
  const oi = um(r, 'oi');
  assert.deepStrictEqual([oi.hv, oi.ep], [0, 0]);
  assert.deepStrictEqual([um(r, 'st').hv, um(r, 'st').ep], [0, 0]);
  // sem hora: programa não liga nada, manual funciona
  r = await s.manda({ t: 'cfg', c: { s: [{}, {}, { r: [SEMPRE] }] } }, '#avanca 1.5');
  assert.strictEqual(um(r, 'st').s[2].on, 0);
  r = await s.manda({ t: 'man', s: 3, on: 1, ate: EP0 + 50 }, { t: 'man', s: 1, on: 1, ate: EP0 + 50 }, '#avanca 1');
  r = await s.manda({ t: 'log?' });
  let l = um(r, 'log').l;
  assert.ok(l.every((e) => e[0] === 0), 'sem hora: ep = 0');
  assert.deepStrictEqual(l.map((e) => e.slice(1, 4)), [[-1, 10, 4], [0, 2, 4], [1, 2, 4], [-1, 12, 1], [1, 1, 1]]);
  r = await s.manda('#avanca 10.4', { t: 'hora', ep: EP0, tz: -180 });
  assert.deepStrictEqual(evC(r, 11), [[EP0, -1, 11, 1, 0]]);
  assert.strictEqual(um(r, 'st').hv, 1);
  assert.strictEqual(um(r, 'st').s[2].on, 1, 'com hora o programa liga');
  r = await s.manda({ t: 'log?' });
  l = um(r, 'log').l;
  // boot (up 0) e hora (up ~16): ep do boot = EP0 - 16
  perto(l[0][0], EP0 - 16, 1, 'ep do boot corrigido');
  assert.ok(l.every((e) => e[0] >= EP0 - 17 && e[0] <= EP0 + 1), JSON.stringify(l));
  await s.fim();
});

teste('hora válida pelo relógio do sistema (#hora) e pausa do botão sem hora', async () => {
  const s = new Sim(['--sem-hora']);
  await s.manda('#avanca 2', '#botao 1', '#avanca 2.9');
  let r = await s.manda('#avanca 0.3', '#botao 0');
  assert.deepStrictEqual(evC(r, 13), [[0, 0, 13, 5, 24], [0, 1, 13, 5, 24]]);
  assert.strictEqual(um(r, 'st').s[2].pa, 0, 'botão não pausa os relés');
  const pa = um(r, 'st').s[0].pa;
  assert.ok(pa > 86400 && pa < 86400 + 10, 'pausa contada no relógio sem hora: ' + pa);
  r = await s.manda('#avanca 2', `#hora ${EP0}`, '#avanca 1.1', { t: 'log?' });
  const l = um(r, 'log').l;
  assert.ok(l.every((e) => e[0] > EP0 - 20 && e[0] <= EP0), JSON.stringify(l));
  const st = um(r, 'st');
  assert.strictEqual(st.hv, 1);
  perto(st.s[0].pa, EP0 + 86400 - 2, 2, 'pausa passou para a hora certa');
  await s.fim();
});

teste('botão BOOT: 3 s pausa só as válvulas 24 h (relés seguem o programa); de novo cancela', async () => {
  const s = new Sim();
  await s.manda('#avanca 3.5', { t: 'cfg', c: { s: [{ r: [SEMPRE] }, {}, { r: [SEMPRE] }] } }, '#avanca 1');
  let r = await s.manda('#botao 1', '#avanca 0.03', '#botao 0', '#avanca 4');
  assert.deepStrictEqual(evs(r), [], 'toque curto não faz nada');
  r = await s.manda({ t: 'man', s: 1, on: 1, ate: EP0 + 3000 }, '#avanca 1', '#botao 1', '#avanca 2.9');
  assert.deepStrictEqual(evs(r).map((x) => x.slice(1, 4)), [[1, 1, 1]]);
  r = await s.manda('#avanca 2');
  const e = evs(r);
  assert.deepStrictEqual(e.map((x) => x.slice(1)), [[0, 13, 5, 24], [1, 13, 5, 24], [0, 2, 2, 0], [1, 2, 2, 0]],
    'um evento 13 por válvula; as duas fecham com origem 2 (pausar cancela o manual)');
  let st = um(r, 'st').s;
  assert.deepStrictEqual(st.map((x) => x.pa), [e[0][0] + 86400, e[0][0] + 86400, 0, 0]);
  assert.deepStrictEqual(st.map((x) => [x.on, x.ma]), [[0, 0], [0, 0], [1, 0], [0, 0]], 'a bomba continua ligada');
  r = await s.manda('#avanca 5');
  assert.deepStrictEqual(evs(r), [], 'segurando mais não repete');
  r = await s.manda('#botao 0', '#avanca 1', '#botao 1', '#avanca 3.2', '#botao 0', '#avanca 1');
  assert.deepStrictEqual(evs(r).map((x) => x.slice(1)), [[0, 14, 5, 0], [1, 14, 5, 0], [0, 1, 0, 0]]);
  st = um(r, 'st').s;
  assert.deepStrictEqual(st.map((x) => [x.on, x.pa]), [[1, 0], [0, 0], [1, 0], [0, 0]]);
  // só a válvula 2 pausada (pelo app): o botão cancela essa pausa (evento 14 só dela)
  await s.manda({ t: 'pausa', s: 1, ate: EP0 + 7200 });
  r = await s.manda('#botao 1', '#avanca 3.2', '#botao 0', '#avanca 0.5');
  assert.deepStrictEqual(evs(r).map((x) => x.slice(1)), [[1, 14, 5, 0]]);
  await s.fim();
});

teste('st a cada 1 s e i a cada 250 ms só quando conectado', async () => {
  const s = new Sim();
  await s.manda('#avanca 2');
  let r = await s.manda('#avanca 10');
  perto(doTipo(r, 'st').length, 10, 1, 'st');
  perto(doTipo(r, 'i').length, 40, 1, 'i');
  const st = um(r, 'st');
  assert.deepStrictEqual(Object.keys(st), ['t', 'ep', 'hv', 'up', 'rtc', 's', 'i']);
  assert.deepStrictEqual(Object.keys(st.s[0]), ['on', 'mo', 'ma', 'pa', 'b', 'hj', 'pk']);
  perto(st.up, 12, 1, 'up');
  r = await s.manda('#desconecta', '#avanca 5', { t: 'oi' });
  assert.deepStrictEqual(r.msgs, []);
  r = await s.manda('#conecta', '#avanca 2');
  perto(doTipo(r, 'st').length, 2, 1);
  perto(doTipo(r, 'i').length, 8, 1);
  await s.fim();
});

teste('hj: conta o tempo ligado e zera na virada do dia local', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', '#desconecta', `#hora ${epLocal(D0, 23, 58)}`, '#avanca 1', '#conecta');
  await s.manda({ t: 'man', s: 2, on: 1, ate: epLocal(D0 + 1, 1, 0) }, '#desconecta', '#avanca 110', '#conecta');
  let r = await s.manda('#avanca 1.1');
  perto(um(r, 'st').s[2].hj, 111, 2, 'antes da meia-noite');
  r = await s.manda('#desconecta', '#avanca 30', '#conecta', '#avanca 1.1');
  const st = um(r, 'st');
  assert.ok(st.ep >= epLocal(D0 + 1, 0, 0));
  perto(st.s[2].hj, st.ep - epLocal(D0 + 1, 0, 0), 2, 'depois da meia-noite');
  await s.fim();
});

teste('robustez: JSON ruim, comando desconhecido, linha gigante, reiniciar', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda('{isto não é json');
  assert.deepStrictEqual(r.msgs, [{ t: 'err', r: '', m: 'Mensagem inválida' }]);
  r = await s.manda('[1,2]');
  erroDe(r, '');
  r = await s.manda({ x: 1 });
  erroDe(r, '', 'tipo');
  r = await s.manda({ t: 'voar' });
  assert.deepStrictEqual(r.msgs, [{ t: 'err', r: 'voar', m: 'Comando desconhecido' }]);
  r = await s.manda(JSON.stringify({ t: 'cfg', c: { nome: 'x'.repeat(5000) } }), { t: 'oi' });
  assert.deepStrictEqual(r.msgs.map((m) => m.t), ['oi'], 'linha > 4096 descartada');
  r = await s.manda({ t: 'cfg', c: { nome: 'y'.repeat(3000) } });
  assert.strictEqual(um(r, 'cfg').c.nome, 'y'.repeat(20));
  r = await s.manda({ t: 'reiniciar' }, '#avanca 0.4');
  assert.deepStrictEqual(r.msgs.filter((m) => m.t !== 'i' && m.t !== 'st'), [{ t: 'ok', r: 'reiniciar' }]);
  assert.ok(!r.err.includes('#reiniciou'), 'espera ~500 ms');
  r = await s.manda('#avanca 0.2', '#avanca 3', { t: 'log?' });
  assert.ok(r.err.includes('#reiniciou'));
  assert.deepStrictEqual(um(r, 'log').l.map((e) => e[2]), [10, 2, 2]);
  await s.fim();
});

teste('relé com inv = 1 (acionado em nível baixo) e nome novo no oi', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda({ t: 'cfg', c: { nome: 'Horta Zé', s: [{}, {}, { inv: 1 }] } }, '#pinos');
  assert.ok(r.err.some((x) => x.startsWith('#pinos ') && x.includes(' 16=Z ')), 'desligado = pino solto');
  r = await s.manda({ t: 'man', s: 2, on: 1, ate: EP0 + 99 }, '#pinos');
  assert.ok(r.err.some((x) => x.startsWith('#pinos ') && x.includes(' 16=0 ')), 'ligado = nível baixo');
  r = await s.manda({ t: 'reiniciar' }, '#avanca 0.6', '#pinos');
  assert.ok(r.err.includes('#reiniciou'));
  assert.ok(r.err.some((x) => x.startsWith('#pinos ') && x.includes(' 16=Z ')), 'depois do boot: desligado (solto)');
  r = await s.manda({ t: 'oi' });
  assert.strictEqual(um(r, 'oi').nome, 'Horta Zé');
  await s.fim();
});

teste('LED: aceso conectado, pisca curto com hora, pisca rápido sem hora', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', '#led');
  let r = await s.manda('#avanca 5', '#led');
  assert.ok(r.err.includes('#led aceso=1 acendeu=0 aceso_ms=5000'), r.err.join('\n'));
  r = await s.manda('#desconecta', '#avanca 0.01', '#led', '#avanca 30', '#led');
  const l = r.err.filter((x) => x.startsWith('#led')).pop();
  const m = /acendeu=(\d+) aceso_ms=(\d+)/.exec(l);
  perto(Number(m[1]), 10, 1, 'piscadas em 30 s');
  perto(Number(m[2]), 1000, 120, 'tempo aceso em 30 s');
  r = await s.manda('#hora 0', '#avanca 0.01', '#led', '#avanca 10', '#led');
  const l2 = r.err.filter((x) => x.startsWith('#led')).pop();
  const m2 = /acendeu=(\d+) aceso_ms=(\d+)/.exec(l2);
  perto(Number(m2[1]), 20, 1, 'piscadas rápidas em 10 s');
  perto(Number(m2[2]), 5000, 300, 'metade do tempo aceso');
  await s.fim();
});

teste('NVS estragado: liga com os padrões sem travar; NVS com valores fora do limite é corrigido', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2');
  let r = await s.manda('#nvsgrava cfg {isto não é json', '#nvsgrava est [1,2', '#reinicia', '#avanca 1.5', { t: 'cfg?' });
  const c = um(r, 'cfg').c;
  assert.strictEqual(c.nome, 'Rega-1A2B');
  assert.deepStrictEqual(um(r, 'st').s.map((x) => [x.pa, x.b]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
  r = await s.manda('#nvsgrava cfg {"nome":"Gravado","pms":99999,"tz":-99999,"s":[{"r":[{"k":"f","h":-4,"d":5}]}]}',
    '#nvsgrava est {"pa":[1792590000,"x",-5],"b":[0,1,true,"?"]}', '#reinicia', '#avanca 1.5', { t: 'cfg?' });
  const c2 = um(r, 'cfg').c;
  assert.deepStrictEqual([c2.nome, c2.pms, c2.tz, c2.s[0].r[0].h], ['Gravado', 1000, -720, 0]);
  assert.deepStrictEqual(um(r, 'st').s.map((x) => [x.pa, x.b]), [[1792590000, 0], [0, 1], [0, 1], [0, 0]]);
  await s.fim();
});

// Lê o "#pinos" (sem os pulsos) de uma resposta.
const pinosDe = (r) => { const l = r.err.filter((x) => x.startsWith('#pinos ')); assert.ok(l.length, 'faltou #pinos'); return l[l.length - 1] + ' '; };

teste('válvula: reinício com regra ativa abre e o 2º pulso de fechar do boot não fecha de novo', async () => {
  const s = new Sim();
  await s.manda('#avanca 3.5', { t: 'cfg', c: { s: [{ r: [SEMPRE] }] } }, '#avanca 3');
  let r = await s.manda('#reinicia', '#avanca 6', { t: 'log?' });
  assert.deepStrictEqual(pulsos(r).filter((x) => x.valvula === 0).map((x) => x.lado), ['B', 'A'],
    'boot fecha, programa abre e mais nada (sem 2º pulso de fechar depois do abrir)');
  assert.deepStrictEqual(pulsos(r).filter((x) => x.valvula === 1).map((x) => x.lado), ['B', 'B'], 'válvula 2: fecha + 2º pulso');
  assert.strictEqual(um(r, 'st').s[0].on, 1);
  assert.deepStrictEqual(um(r, 'log').l.filter((e) => e[1] === 0).map((e) => e.slice(1, 4)), [[0, 2, 4], [0, 1, 0]]);
  // o app manda abrir a válvula 2 logo depois do boot
  r = await s.manda('#reinicia', { t: 'man', s: 1, on: 1, ate: EP0 + 3600 }, '#avanca 6');
  assert.deepStrictEqual(pulsos(r).filter((x) => x.valvula === 0).map((x) => x.lado), ['B', 'A']);
  assert.deepStrictEqual(pulsos(r).filter((x) => x.valvula === 1).map((x) => x.lado), ['B', 'A']);
  assert.deepStrictEqual(um(r, 'st').s.slice(0, 2).map((x) => x.on), [1, 1]);
  // abrir na mão 1,9 s depois de fechar na mão: o 2º pulso de fechar (2 s) não acontece
  r = await s.manda({ t: 'man', s: 1, on: 0, ate: EP0 + 3600 }, '#avanca 1.9', { t: 'man', s: 1, on: 1, ate: EP0 + 3600 }, '#avanca 5');
  assert.deepStrictEqual(pulsos(r).filter((x) => x.valvula === 1).map((x) => x.lado), ['B', 'A']);
  assert.strictEqual(um(r, 'st').s[1].on, 1);
  // fecha, abre e fecha de novo em menos de 2 s: termina fechada, com o 2º pulso só no fim
  r = await s.manda({ t: 'man', s: 1, on: 0, ate: EP0 + 3600 }, '#avanca 0.5', { t: 'man', s: 1, on: 1, ate: EP0 + 3600 },
    '#avanca 0.5', { t: 'man', s: 1, on: 0, ate: EP0 + 3600 }, '#avanca 5');
  const p = pulsos(r).filter((x) => x.valvula === 1);
  assert.deepStrictEqual(p.map((x) => x.lado), ['B', 'A', 'B', 'B']);
  perto(p[3].ini - p[2].fim, 2000, 1, 'f2 do último fechamento');
  assert.strictEqual(um(r, 'st').s[1].on, 0);
  await s.fim();
});

teste('válvulas (aleatório): o último pulso de cada válvula sempre bate com st.on', async () => {
  let semente = 4242;
  const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
  const s = new Sim();
  await s.manda('#avanca 3.5');
  const ultimo = ['B', 'B'];
  const anota = (r) => { for (const p of pulsos(r)) ultimo[p.valvula] = p.lado; };
  for (let rodada = 0; rodada < 60; rodada++) {
    const linhas = [];
    const n = 1 + Math.floor(rnd() * 5);
    for (let k = 0; k < n; k++) {
      const x = rnd();
      const v = Math.floor(rnd() * 2);
      if (x < 0.45) linhas.push({ t: 'man', s: v, on: rnd() < 0.5 ? 1 : 0, ate: EP0 + 100000 });
      else if (x < 0.55) linhas.push({ t: 'man', s: v, ate: 0 });
      else if (x < 0.65) linhas.push({ t: 'cfg', c: { f2: rnd() < 0.8 ? 1 : 0, s: [{ r: rnd() < 0.5 ? [SEMPRE] : [] }, { r: rnd() < 0.5 ? [SEMPRE] : [] }] } });
      else if (x < 0.72) linhas.push({ t: 'pausa', s: v, ate: rnd() < 0.5 ? 0 : EP0 + 100000 });
      else if (x < 0.8) linhas.push('#reinicia');
      linhas.push('#avanca ' + (rnd() * 2.5).toFixed(3));
    }
    anota(await s.manda(linhas));
    const r = await s.manda('#avanca 5');
    anota(r);
    const st = um(r, 'st');
    for (const v of [0, 1]) {
      assert.strictEqual(ultimo[v] === 'A' ? 1 : 0, st.s[v].on, `rodada ${rodada}, válvula ${v}: último pulso ${ultimo[v]}, st.on ${st.s[v].on}`);
    }
  }
  await s.fim();
});

teste('relés: desligado = pino solto (Z) desde o boot, ligado = nível certo (inv 0 e 1)', async () => {
  const s = new Sim();
  let r = await s.manda('#pinos');  // 1º boot, NVS vazio
  assert.ok(pinosDe(r).includes(' 16=Z 17=Z '), pinosDe(r));
  r = await s.manda('#avanca 1.2', { t: 'cfg', c: { s: [{}, {}, {}, { en: 1 }] } },
    { t: 'man', s: 2, on: 1, ate: EP0 + 600 }, { t: 'man', s: 3, on: 1, ate: EP0 + 600 }, '#pinos');
  assert.ok(pinosDe(r).includes(' 16=1 17=1 '), 'inv = 0: ligado = nível alto ' + pinosDe(r));
  r = await s.manda({ t: 'cfg', c: { s: [{}, {}, {}, { inv: 1 }] } }, '#pinos');
  assert.ok(pinosDe(r).includes(' 16=1 17=0 '), 'trocar inv com o relé ligado muda o nível na hora ' + pinosDe(r));
  r = await s.manda({ t: 'man', s: 2, on: 0, ate: EP0 + 600 }, { t: 'man', s: 3, ate: 0 }, '#pinos');
  assert.ok(pinosDe(r).includes(' 16=Z 17=Z '), 'desligado = solto (inv 0 e 1) ' + pinosDe(r));
  // reinício com a bomba programada e inv = 1: solto até o programa mandar ligar
  await s.manda({ t: 'man', s: 2, ate: 0 }, { t: 'cfg', c: { s: [{}, {}, { inv: 1, r: [SEMPRE] }] } });
  r = await s.manda('#reinicia', '#pinos');
  assert.ok(pinosDe(r).includes(' 16=Z 17=Z '), 'logo depois do reinício ' + pinosDe(r));
  r = await s.manda('#avanca 1.5', '#pinos');
  assert.ok(pinosDe(r).includes(' 16=0 17=Z '), 'programa ligou a bomba (inv = 1: nível baixo) ' + pinosDe(r));
  r = await s.manda({ t: 'reiniciar' }, '#avanca 0.45', '#pinos');
  assert.ok(!r.err.includes('#reiniciou') && pinosDe(r).includes(' 16=0 '));
  r = await s.manda('#avanca 0.1');
  assert.ok(r.err.includes('#reiniciou'));
  await s.fim();
});

teste('PIN: 5 erros seguidos travam o auth por 60 s, mesmo reconectando (§7.1)', async () => {
  const s = new Sim();
  await s.manda('#avanca 1.2', { t: 'cfg', c: { pin: '1234' } });
  const errado = (pin) => ({ t: 'auth', pin });
  let r = await s.manda('#desconecta', '#conecta', errado('1'), errado('2'), errado('3'));
  assert.deepStrictEqual(r.msgs, [{ t: 'auth', ok: 0 }, { t: 'auth', ok: 0 }, { t: 'auth', ok: 0 }]);
  r = await s.manda('#desconecta', '#conecta', errado('4'));
  assert.deepStrictEqual(r.msgs, [{ t: 'auth', ok: 0 }], 'o contador não zera ao reconectar');
  r = await s.manda(errado('5'));
  assert.deepStrictEqual(r.msgs, [{ t: 'auth', ok: 0, espera: 60 }]);
  assert.ok(r.err.some((x) => x.startsWith('#desconectado')), '5º erro seguido desconecta');
  r = await s.manda('#avanca 20', '#conecta', { t: 'oi' }, { t: 'auth', pin: '1234' }, { t: 'cfg?' });
  assert.strictEqual(um(r, 'oi').pin, 1);
  perto(um(r, 'auth').espera, 40, 1, 'segundos que faltam');
  assert.strictEqual(um(r, 'auth').ok, 0);
  erroDe(r, 'cfg?', 'pin');
  r = await s.manda('#avanca 39.2', { t: 'auth', pin: '1234' });
  assert.deepStrictEqual(r.msgs, [{ t: 'auth', ok: 0, espera: 1 }]);
  r = await s.manda('#avanca 1', { t: 'auth', pin: '1234' }, '#avanca 1.1');
  assert.deepStrictEqual(um(r, 'auth'), { t: 'auth', ok: 1 }, 'depois de 60 s o PIN certo vale');
  assert.ok(doTipo(r, 'st').length >= 1);
  // depois da trava o contador recomeça; um acerto zera
  r = await s.manda('#desconecta', '#conecta', errado('1'), errado('2'), errado('3'), errado('4'), { t: 'auth', pin: '1234' });
  assert.deepStrictEqual(r.msgs.map((m) => m.ok), [0, 0, 0, 0, 1]);
  r = await s.manda('#desconecta', '#conecta', errado('1'), errado('2'), errado('3'), errado('4'), { t: 'auth', pin: '1234' });
  assert.deepStrictEqual(r.msgs.map((m) => m.ok), [0, 0, 0, 0, 1], 'o acerto zerou o contador');
  // a trava fica só na memória: um reinício limpa
  r = await s.manda('#desconecta', '#conecta', errado('1'), errado('2'), errado('3'), errado('4'), errado('5'));
  assert.strictEqual(r.msgs[4].espera, 60);
  r = await s.manda('#reinicia', { t: 'auth', pin: '1234' });
  assert.deepStrictEqual(um(r, 'auth'), { t: 'auth', ok: 1 });
  await s.fim();
});

teste('relógio DS3231 (relogio.h): datas de 1970 a 2100, BCD, século, modo 12 h e OSF', async () => {
  const r = spawnSync(BIN, ['--teste-relogio'], { encoding: 'utf8', env: Object.assign({}, process.env, { ASAN_OPTIONS: 'detect_leaks=1' }) });
  assert.strictEqual(r.status, 0, 'código ' + r.status + '\n' + r.stderr);
  assert.ok(!PROBLEMAS.test(r.stderr), r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(o, { t: '#relogio', ok: 1, dias: 47847, idaVolta: 3 * 36890, erros: 0 });
});

teste('aleatório: 3 × 4000 linhas malucas não travam nem causam erro de memória', async () => {
 for (const inicial of [20261021, 7, 99991]) {
  let semente = inicial;
  const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
  const um_de = (l) => l[Math.floor(rnd() * l.length)];
  const valores = () => um_de([0, 1, -1, 2, 3, 4, 7, -2, 0.5, 1e20, -1e20, 1e308, 1.5, EP0 + Math.floor(rnd() * 200000),
    'abc', '', true, false, null, [], {}, [1, 2], 'ç'.repeat(40), 1439, 1440, 9999]);
  const regra = () => ({ k: um_de(['f', 'c', 'x', 5]), h: valores(), d: valores(), a: valores(), b: valores(),
    on: valores(), off: valores(), w: valores(), en: valores() });
  const cfg = () => {
    const c = {};
    if (rnd() < 0.3) c.nome = um_de(['Sítio', '', 'x'.repeat(30), 5, 'Água ' + Math.floor(rnd() * 99)]);
    if (rnd() < 0.3) c.tz = valores();
    if (rnd() < 0.3) c.pms = valores();
    if (rnd() < 0.2) c.f2 = valores();
    if (rnd() < 0.1) c.pin = um_de(['', '', '', '', '1', '12345678', '0x1', 7]);
    if (rnd() < 0.5) c.s = Array.from({ length: Math.floor(rnd() * 6) }, () => ({ n: um_de(['A', 'Válvula ç', 3]), en: valores(), inv: valores(),
      r: Array.from({ length: Math.floor(rnd() * 11) }, regra) }));
    if (rnd() < 0.5) c.sen = Array.from({ length: Math.floor(rnd() * 3) }, () => ({ en: valores(), tp: um_de(['dc', 'ac', 'x']), mva: valores(),
      div: valores(), aj: valores(), sa: valores(), min: valores(), max: valores(), corta: valores() }));
    return c;
  };
  const s = new Sim();
  const linhas = [];
  for (let k = 0; k < 4000; k++) {
    const x = rnd();
    if (x < 0.06) linhas.push('#avanca ' + (rnd() * 3).toFixed(3));
    else if (x < 0.08) linhas.push('#corrente ' + Math.floor(rnd() * 2) + ' ' + ((rnd() - 0.3) * 12).toFixed(2));
    else if (x < 0.085) linhas.push('#hora ' + um_de([0, EP0, EP0 + 86400 * 3, 1700000000]));
    else if (x < 0.09) linhas.push('#botao ' + Math.floor(rnd() * 2));
    else if (x < 0.095) linhas.push(um_de(['#desconecta', '#conecta', '#conecta 23']));
    else if (x < 0.097) linhas.push('#reinicia');
    else if (x < 0.12) linhas.push(um_de(['{', '}', '[]', 'null', '"t"', '{"t":', '{"t":"man","s":', 'çç', '{"t":"oi"} lixo']));
    else {
      const t = um_de(['oi', 'auth', 'hora', 'cfg?', 'cfg', 'cfg', 'man', 'man', 'pausa', 'lib', 'zero', 'log?', 'xx', 5, null]);
      const m = { t };
      if (t === 'cfg') m.c = rnd() < 0.9 ? cfg() : valores();
      else { for (const f of ['s', 'on', 'ate', 'ep', 'tz', 'de']) if (rnd() < 0.6) m[f] = valores(); }
      if (t === 'auth') m.pin = um_de(['1', '12345678', '', valores()]);
      if (t === 'reiniciar') continue;
      linhas.push(m);
    }
  }
  for (let k = 0; k < linhas.length; k += 200) await s.manda(linhas.slice(k, k + 200));
  await s.manda('#conecta', { t: 'cfg', c: { pin: '' } }, '#avanca 3', { t: 'oi' });
  await s.fim();
 }
});

// ---------------- roda ----------------
(async () => {
  const filtro = process.argv[2] || '';
  let falhas = 0, feitos = 0;
  for (const t of testes) {
    if (filtro && !t.nome.includes(filtro)) continue;
    feitos++;
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`ok   ${t.nome} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      falhas++;
      console.log(`FALHOU ${t.nome}\n  ${(e && e.stack) || e}`);
    }
  }
  console.log(`\n${feitos - falhas}/${feitos} testes passaram`);
  process.exit(falhas ? 1 : 0);
})();
