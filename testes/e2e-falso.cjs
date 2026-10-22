// Teste de ponta a ponta do app com o Bluetooth de mentira (testes/ble-falso.js).
// Uso: NODE_PATH=$(npm root -g) node testes/e2e-falso.cjs [--sem-capturas] [--sem-nativo] [--so-nativo]
// 1) app × ESP32 simulado em JS (o backend padrão do ble-falso.js);
// 2) app × núcleo do firmware de verdade (testes/nativo/rega, PROTOCOLO §10/§11), ligado pelo
//    Playwright com exposeFunction — confere o contrato dos dois lados. Se o núcleo não compilar,
//    esta parte é pulada (avisa no fim);
// 3) capturas de tela em 360x780 e 412x915, claro e escuro, em testes/.saida/ (fora do git).
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const readline = require('readline');
const { chromium } = require('playwright');
const { expect } = require('playwright/test');
const { iniciar } = require('./servidor.cjs');

const SAIDA = path.join(__dirname, '.saida');
const FONTES = path.join(SAIDA, 'fontes');
const FALSO = path.join(__dirname, 'ble-falso.js');
const NATIVO = path.join(__dirname, 'nativo', 'rega');
const HORA = new Date('2026-10-21T12:03:00Z'); // quarta, 09:03 em Brasília
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const epLocal = (dia, hh, mm) => Date.UTC(2026, 9, dia, hh + 3, mm) / 1000; // hora de Brasília → epoch

fs.mkdirSync(FONTES, { recursive: true });

// ---------- fontes do Google servidas de uma cópia local ----------
function baixar(url, destino) {
  try {
    execFileSync('curl', ['-sS', '-f', '-A', UA, '-o', destino, url], { timeout: 30000, stdio: 'ignore' });
    return fs.existsSync(destino);
  } catch (e) { return false; }
}
async function rotearFontes(ctx) {
  await ctx.route(/^https:\/\/fonts\.googleapis\.com\//, async (route) => {
    const arq = path.join(FONTES, 'fontes.css');
    if (!fs.existsSync(arq)) baixar(route.request().url(), arq);
    await route.fulfill({
      status: 200, contentType: 'text/css; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: fs.existsSync(arq) ? fs.readFileSync(arq) : ''
    });
  });
  await ctx.route(/^https:\/\/fonts\.gstatic\.com\//, async (route) => {
    const url = route.request().url();
    const arq = path.join(FONTES, crypto.createHash('sha1').update(url).digest('hex') + '.woff2');
    if (!fs.existsSync(arq)) baixar(url, arq);
    if (!fs.existsSync(arq)) { await route.abort(); return; }
    await route.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(arq) });
  });
}

// ---------- erros de console e da página fazem o teste falhar ----------
const errosConsole = [];
function vigiar(pagina, rotulo) {
  pagina.on('console', (m) => { if (m.type() === 'error') errosConsole.push('[' + rotulo + '] ' + m.text()); });
  pagina.on('pageerror', (e) => errosConsole.push('[' + rotulo + '] erro na página: ' + e.message));
}

let navegador, servidor, paginaAtual = null;
let versaoSw = 0; // > 0: o servidor manda um sw.js diferente (testa o aviso de versão nova)
let foraDoAr = false; // true: o servidor responde 404 para a página (GitHub Pages fora do ar)
let nPassos = 0;
const avisosFinais = [];
async function passo(nome, fn) {
  const t0 = Date.now();
  try {
    await fn();
    nPassos++;
    console.log('  ok  ' + nome + ' (' + (Date.now() - t0) + ' ms)');
  } catch (e) {
    console.log('  FALHOU  ' + nome + '\n' + (e && e.stack ? e.stack : e));
    if (paginaAtual) await paginaAtual.screenshot({ path: path.join(SAIDA, 'falha.png'), fullPage: true }).catch(() => {});
    throw e;
  }
}

async function novoContexto(op) {
  op = op || {};
  const ctx = await navegador.newContext({
    viewport: op.viewport || { width: 412, height: 915 },
    deviceScaleFactor: op.dsf || 1,
    isMobile: true,
    hasTouch: true,
    locale: 'pt-BR',
    timezoneId: op.fuso || 'America/Sao_Paulo',
    colorScheme: op.cor || 'light',
    serviceWorkers: 'allow',
    storageState: op.storageState
  });
  await rotearFontes(ctx);
  if (op.relogio !== false) await ctx.clock.install({ time: op.hora || HORA });
  if (op.semBluetooth) {
    await ctx.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => undefined });
    });
  } else {
    await ctx.addInitScript({ path: FALSO });
  }
  if (op.armazenamentoQuebrado) {
    await ctx.addInitScript(() => {
      const quebra = () => { throw new DOMException('bloqueado', 'SecurityError'); };
      Storage.prototype.getItem = quebra;
      Storage.prototype.setItem = quebra;
      Storage.prototype.removeItem = quebra;
    });
  }
  return ctx;
}

const cartao = (p, nome) => p.locator('.saida').filter({ has: p.locator('h2', { hasText: new RegExp('^' + nome + '$') }) });
const folha = (p) => p.locator('#folha');
const recebidos = (p, t) => p.evaluate((tipo) => window.__simFalso.recebidos().filter((m) => m.t === tipo), t);
const estatBle = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__bleFalsoEstat)));
async function aba(p, nome) { await p.click('.nav button[data-aba="' + nome + '"]'); }
async function conectarSemPin(p) {
  await p.click('#btnConectar');
  await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
}
// some com os avisos rápidos que ainda estão na tela (o de erro dura 6 s)
async function limparAvisos(p) {
  await p.clock.runFor(6500);
  await expect(p.locator('.toast')).toHaveCount(0);
}
async function semToastDeErro(p) {
  const n = await p.locator('.toast[data-tipo="erro"]').count();
  if (n) throw new Error('apareceu aviso de erro: ' + (await p.locator('.toast[data-tipo="erro"]').first().textContent()));
}

// =====================================================================
async function testePrincipal(url) {
  const ctx = await novoContexto();
  const p = await ctx.newPage();
  paginaAtual = p;
  vigiar(p, 'principal');
  const errosAviso = [];
  p.on('console', (m) => { if (m.type() === 'warning' && /Mensagem não tratada/.test(m.text())) errosAviso.push(m.text()); });

  await passo('abre sem dados e sem controlador', async () => {
    await p.goto(url);
    await expect(p).toHaveTitle('Irriga Horta');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
    await expect(p.locator('#painelVazio')).toBeVisible();
    await expect(p.locator('.nav button')).toHaveCount(5);
    await aba(p, 'programas');
    await expect(p.locator('#progVazio')).toContainText('Ainda sem dados do controlador');
    await aba(p, 'painel');
  });

  await passo('escolha cancelada não mostra erro', async () => {
    await p.evaluate(() => window.__simFalso.cancelarEscolha(true));
    await p.click('#btnConectar');
    await expect(p.locator('.toast')).toContainText('Nenhum controlador escolhido.');
    await semToastDeErro(p);
    await p.evaluate(() => window.__simFalso.cancelarEscolha(false));
  });

  await passo('conecta com PIN (errado, depois certo) e MTU 185', async () => {
    await p.evaluate(() => { window.__simFalso.definirPin('1234'); window.__bleMtu = 185; });
    await p.click('#btnConectar');
    await expect(folha(p)).toBeVisible();
    await expect(folha(p).locator('h2')).toHaveText('PIN do controlador');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Esperando PIN');
    await folha(p).locator('input').fill('0000');
    await folha(p).getByRole('button', { name: 'Entrar' }).click();
    await expect(folha(p).locator('.folha-erro')).toHaveText('PIN errado. Tente de novo.');
    await folha(p).locator('input').fill('1234');
    await folha(p).getByRole('button', { name: 'Entrar' }).click();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    const pins = await p.evaluate(() => JSON.parse(localStorage.getItem('rega.pins')));
    if (!Object.values(pins).includes('1234')) throw new Error('PIN não foi guardado: ' + JSON.stringify(pins));
    // ordem do aperto de mão: oi, auth, auth, hora, cfg?, log?
    await expect.poll(async () => (await recebidos(p, 'log?')).length).toBe(1);
    const tipos = (await p.evaluate(() => window.__simFalso.recebidos().map((m) => m.t)));
    const esperado = ['oi', 'auth', 'auth', 'hora', 'cfg?', 'log?'];
    if (JSON.stringify(tipos.slice(0, 6)) !== JSON.stringify(esperado)) throw new Error('ordem: ' + tipos.join(','));
    // a hora vai sem "tz": o fuso do controlador só muda em Ajustes (o celular pode estar em outro fuso)
    const hora = (await recebidos(p, 'hora'))[0];
    if ('tz' in hora || Math.abs(hora.ep - HORA.getTime() / 1000) > 30) throw new Error('hora errada: ' + JSON.stringify(hora));
    const log = (await recebidos(p, 'log?'))[0];
    if ('de' in log) throw new Error('primeiro log? não devia ter "de"');
  });

  await passo('manifesto: nome Irriga Horta, ícones e cores', async () => {
    const m = await p.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
    const conf = { name: 'Irriga Horta', short_name: 'Irriga', start_url: './', scope: './', display: 'standalone', lang: 'pt-BR' };
    for (const k in conf) if (m[k] !== conf[k]) throw new Error('manifesto ' + k + ' = ' + m[k]);
    if (!/^#[0-9a-f]{6}$/i.test(m.theme_color) || !/^#[0-9a-f]{6}$/i.test(m.background_color)) throw new Error('cores do manifesto');
    const icones = await p.evaluate(async (lista) => Promise.all(lista.map(async (i) => {
      const r = await fetch(i.src);
      const b = await createImageBitmap(await r.blob());
      return { src: i.src, sizes: i.sizes, purpose: i.purpose || 'any', tipo: r.headers.get('content-type'), w: b.width, h: b.height };
    })), m.icons);
    const quer = [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']];
    for (const [tam, prop] of quer) {
      const i = icones.find((x) => x.sizes === tam && x.purpose.split(' ').includes(prop));
      if (!i || i.tipo !== 'image/png' || i.w + 'x' + i.h !== tam) throw new Error('ícone ' + tam + ' ' + prop + ': ' + JSON.stringify(icones));
    }
    await expect(p.locator('.marca-txt strong')).toHaveText('Irriga Horta');
  });

  await passo('painel mostra estado, motivo e próxima mudança', async () => {
    await expect(p.locator('.saida')).toHaveCount(3); // Relé 2 desativado não aparece
    await expect(cartao(p, 'Válvula 1').locator('.palavra')).toHaveText('Aberta');
    await expect(cartao(p, 'Válvula 1').locator('.porque-txt')).toHaveText('Pelo programa');
    await expect(cartao(p, 'Válvula 1').locator('.proxima-txt')).toHaveText('Fecha às 09:30');
    await expect(cartao(p, 'Válvula 1').locator('.detalhes')).toContainText(/Hoje: \d+ min · Último pulso: 1,\d\d\sA/);
    await expect(cartao(p, 'Válvula 2').locator('.palavra')).toHaveText('Fechada');
    await expect(cartao(p, 'Válvula 2').locator('.proxima-txt')).toHaveText('Abre às 18:00');
    await expect(cartao(p, 'Hidroponia').locator('.palavra')).toHaveText('Ligada');
    await expect(cartao(p, 'Hidroponia').locator('.proxima-txt')).toHaveText('Desliga às 09:15');
    await expect(p.locator('#cxNome')).toHaveText('Rega-1A2B');
    await expect(p.locator('#cxRelogio')).toHaveText(/^qua 21\/10 · 09:0\d$/);
    await expect(p.locator('#cxHora')).toContainText('Hora certa');
    await expect(p.locator('#cxHora')).toContainText('Com relógio DS3231');
  });

  await passo('abrir por 15 min e voltar ao programa', async () => {
    const c = cartao(p, 'Válvula 2');
    await c.getByRole('button', { name: 'Abrir por…' }).click();
    await expect(folha(p).locator('h2')).toHaveText('Abrir Válvula 2 por quanto tempo?');
    await folha(p).getByRole('button', { name: '15 min', exact: true }).click();
    await expect(c.locator('.palavra')).toHaveText('Aberta');
    await expect(c.locator('.porque-txt')).toHaveText(/^Manual até 09:1[89]$/);
    await expect(c.locator('.proxima-txt')).toHaveText(/^Fecha às 09:1[89]$/);
    const man = (await recebidos(p, 'man')).pop();
    const agora = await p.evaluate(() => window.__simFalso.agora());
    if (man.s !== 1 || man.on !== 1 || Math.abs(man.ate - (agora + 900)) > 5) throw new Error('man errado ' + JSON.stringify(man));
    await expect(p.locator('.toast').last()).toContainText('Válvula 2 aberta por 15 min.');
    await c.getByRole('button', { name: 'Voltar ao programa' }).click();
    await expect(c.locator('.palavra')).toHaveText('Fechada');
    await expect(c.locator('.porque-txt')).toHaveText('Pelo programa');
    await expect(c.getByRole('button', { name: 'Voltar ao programa' })).toBeHidden();
    const volta = (await recebidos(p, 'man')).pop();
    if (volta.s !== 1 || volta.ate !== 0) throw new Error('voltar ao programa devia mandar ate = 0: ' + JSON.stringify(volta));
    // fechar com o programa desligado: só cancela o manual (ate = 0)
    const n = (await recebidos(p, 'man')).length;
    await c.getByRole('button', { name: 'Fechar' }).click();
    await expect.poll(async () => (await recebidos(p, 'man')).length).toBe(n + 1);
    const fecha = (await recebidos(p, 'man')).pop();
    if (fecha.s !== 1 || fecha.on !== 0 || fecha.ate !== 0) throw new Error('fechar com programa desligado: ' + JSON.stringify(fecha));
    await expect(c.locator('.porque-txt')).toHaveText('Pelo programa');
  });

  await passo('fechar com o programa ligado = fecha até a próxima mudança', async () => {
    const c = cartao(p, 'Válvula 1');
    await c.getByRole('button', { name: 'Fechar' }).click();
    await expect(c.locator('.palavra')).toHaveText('Fechada');
    await expect(c.locator('.porque-txt')).toHaveText('Manual até 09:30');
    await expect(c.locator('.proxima-txt')).toHaveText('Abre qui 09:00');
    const man = (await recebidos(p, 'man')).pop();
    if (man.s !== 0 || man.on !== 0 || man.ate !== epLocal(21, 9, 30)) throw new Error('man errado ' + JSON.stringify(man));
    await c.getByRole('button', { name: 'Voltar ao programa' }).click();
    await expect(c.locator('.palavra')).toHaveText('Aberta');
  });

  await passo('ligar por tempo digitado, desligar e voltar', async () => {
    const c = cartao(p, 'Hidroponia');
    await c.getByRole('button', { name: 'Ligar por…' }).click();
    const outro = folha(p).getByLabel('Outro (minutos)');
    await outro.fill('0');
    await folha(p).getByRole('button', { name: 'Usar' }).click();
    await expect(folha(p).locator('.folha-erro')).toHaveText('Digite um número de 1 a 1440.');
    await outro.fill('45');
    await folha(p).getByRole('button', { name: 'Usar' }).click();
    await expect(c.locator('.porque-txt')).toHaveText(/^Manual até 09:4[89]$/);
    await c.getByRole('button', { name: 'Desligar' }).click();
    await expect(c.locator('.palavra')).toHaveText('Desligada');
    await expect(c.locator('.porque-txt')).toHaveText('Manual até 09:15');
    await c.getByRole('button', { name: 'Voltar ao programa' }).click();
    await expect(c.locator('.palavra')).toHaveText('Ligada');
    await expect(c.locator('.porque-txt')).toHaveText('Pelo programa');
  });

  await passo('pausar a rega (chuva) e cancelar', async () => {
    await expect(p.locator('#btnChuva')).toContainText('Pausar a rega (chuva)');
    const antes = (await recebidos(p, 'pausa')).length;
    await p.click('#btnChuva');
    await folha(p).getByRole('button', { name: '24 h', exact: true }).click();
    await expect(cartao(p, 'Válvula 1').locator('.porque-txt')).toHaveText(/^Pausada até qui 09:0\d$/);
    await expect(cartao(p, 'Válvula 2').locator('.porque-txt')).toHaveText(/^Pausada até qui 09:0\d$/);
    await expect(cartao(p, 'Válvula 1').locator('.palavra')).toHaveText('Fechada');
    await expect(cartao(p, 'Hidroponia').locator('.porque-txt')).toHaveText('Pelo programa');
    await expect(p.locator('#btnChuva')).toContainText('Cancelar pausa da rega');
    const pausas = (await recebidos(p, 'pausa')).slice(antes);
    if (pausas.length !== 2 || pausas[0].s !== 0 || pausas[1].s !== 1) throw new Error('pausas: ' + JSON.stringify(pausas));
    await p.click('#btnChuva');
    await expect(cartao(p, 'Válvula 1').locator('.palavra')).toHaveText('Aberta');
    await expect(cartao(p, 'Válvula 2').locator('.porque-txt')).toHaveText('Pelo programa');
    await expect(p.locator('#btnChuva')).toContainText('Pausar a rega (chuva)');
  });

  await passo('pausa da chuva não encurta uma pausa mais longa (manutenção)', async () => {
    const v2 = cartao(p, 'Válvula 2');
    await v2.getByRole('button', { name: 'Pausar…' }).click();
    await folha(p).getByRole('button', { name: '72 h', exact: true }).click();
    await expect(v2.locator('.porque-txt')).toHaveText(/^Pausada até sáb 09:0\d$/);
    await expect(p.locator('#btnChuva')).toContainText('Pausar a rega (chuva)');
    const antes = (await recebidos(p, 'pausa')).length;
    await p.click('#btnChuva');
    await folha(p).getByRole('button', { name: '6 h', exact: true }).click();
    await expect(cartao(p, 'Válvula 1').locator('.porque-txt')).toHaveText(/^Pausada até 15:0\d$/);
    await expect(p.locator('.toast').last()).toContainText(/Válvula 2 já estava pausada até sáb 09:0\d\./);
    await expect(v2.locator('.porque-txt')).toHaveText(/^Pausada até sáb 09:0\d$/);
    const pausas = (await recebidos(p, 'pausa')).slice(antes);
    if (pausas.length !== 1 || pausas[0].s !== 0) throw new Error('só a Válvula 1 devia receber pausa: ' + JSON.stringify(pausas));
    await expect(p.locator('#btnChuva')).toContainText('Cancelar pausa da rega');
    await expect(p.locator('#btnChuva')).toContainText(/Rega pausada até 15:0\d/);
    await p.click('#btnChuva');
    await expect(v2.locator('.porque-txt')).toHaveText('Pelo programa');
    await expect(cartao(p, 'Válvula 1').locator('.palavra')).toHaveText('Aberta');
  });

  await passo('pausar uma saída e cancelar', async () => {
    const c = cartao(p, 'Hidroponia');
    await c.getByRole('button', { name: 'Pausar…' }).click();
    await folha(p).getByRole('button', { name: '6 h', exact: true }).click();
    await expect(c.locator('.porque-txt')).toHaveText(/^Pausada até 15:0\d$/);
    await expect(c.locator('.palavra')).toHaveText('Desligada');
    await c.getByRole('button', { name: 'Cancelar pausa' }).click();
    await expect(c.locator('.palavra')).toHaveText('Ligada');
  });

  await passo('controlador que não responde: aviso amigável depois de 5 s', async () => {
    await p.evaluate(() => window.__simFalso.congelar(true));
    const c = cartao(p, 'Válvula 2');
    await c.getByRole('button', { name: 'Abrir por…' }).click();
    await folha(p).getByRole('button', { name: '5 min', exact: true }).click();
    await p.waitForTimeout(300);
    await expect(p.locator('.toast[data-tipo="erro"]')).toHaveCount(0);
    await p.clock.runFor(5200);
    await expect(p.locator('.toast[data-tipo="erro"]').last()).toContainText('O controlador não respondeu. Tente de novo.');
    await p.evaluate(() => window.__simFalso.congelar(false));
    await expect(c.locator('.palavra')).toHaveText('Fechada');
    await expect(c.getByRole('button', { name: 'Abrir por…' })).toBeEnabled();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado');
    // linha que chega estragada: o controlador responde err sem tipo e o app avisa na hora
    await p.evaluate(() => window.__simFalso.estragarProxima());
    const t0 = Date.now();
    await c.getByRole('button', { name: 'Pausar…' }).click();
    await folha(p).getByRole('button', { name: '6 h', exact: true }).click();
    await expect(p.locator('.toast[data-tipo="erro"]').last()).toContainText('O controlador não entendeu o pedido. Tente de novo.');
    if (Date.now() - t0 > 3000) throw new Error('demorou para avisar do err sem tipo');
    await expect(c.locator('.porque-txt')).toHaveText('Pelo programa');
  });

  await passo('escrita que nunca termina: aviso em 5 s e a ligação é refeita', async () => {
    await limparAvisos(p);
    const c = cartao(p, 'Válvula 2');
    const c0 = (await estatBle(p)).conexoes;
    await p.evaluate(() => window.__simFalso.prenderEscritas(true));
    await c.getByRole('button', { name: 'Fechar' }).click();
    await p.waitForTimeout(300);
    await expect(p.locator('.toast[data-tipo="erro"]')).toHaveCount(0);
    await p.clock.runFor(5200);
    await p.evaluate(() => window.__simFalso.prenderEscritas(false));
    await expect(p.locator('.toast[data-tipo="erro"]').last()).toContainText('O controlador não respondeu. Tente de novo.');
    await expect.poll(async () => (await estatBle(p)).conexoes, { timeout: 10000 }).toBe(c0 + 1);
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await expect(c.getByRole('button', { name: 'Fechar' })).toBeEnabled();
    await c.getByRole('button', { name: 'Fechar' }).click();
    await expect(p.locator('.toast').last()).toContainText('Válvula 2 fechada.');
  });

  await passo('bloqueio por corrente alta, alarme e liberar', async () => {
    await p.evaluate(() => window.__simFalso.bloquear(2, 5.2));
    const c = cartao(p, 'Hidroponia');
    await expect(c.locator('.porque-txt')).toHaveText('Bloqueada: corrente alta');
    await expect(c.locator('.palavra')).toHaveText('Desligada');
    await expect(c.locator('.proxima-txt')).toHaveText('Fica desligada até liberar');
    await expect(p.locator('#alarmes h2')).toHaveText('Alarmes');
    await expect(p.locator('#alarmes li').nth(0)).toContainText('Hidroponia bloqueada por corrente alta (5,20 A)');
    await expect(p.locator('#alarmes li').nth(1)).toContainText('Hidroponia com corrente alta (5,20 A)');
    await expect(p.locator('#navAlarme')).toBeVisible();
    await c.getByRole('button', { name: 'Liberar' }).click();
    await expect(c.locator('.porque-txt')).toHaveText('Pelo programa');
    await expect(c.locator('.palavra')).toHaveText('Ligada');
    const lib = (await recebidos(p, 'lib')).pop();
    if (!lib || lib.s !== 2) throw new Error('lib errado: ' + JSON.stringify(lib));
    await p.locator('#btnAlarmesOk').click();
    await expect(p.locator('#alarmes .alerta')).toHaveCount(0);
    await expect(p.locator('#navAlarme')).toBeHidden();
    // alarme novo depois de "Entendi" volta a aparecer
    await p.evaluate(() => window.__simFalso.evento(2, 21, 0, 0.02));
    await expect(p.locator('#alarmes h2')).toHaveText('Alarme');
    await expect(p.locator('#alarmes li')).toHaveCount(1);
    await expect(p.locator('#alarmes li')).toContainText('Hidroponia ligada sem corrente (0,02 A)');
    await p.locator('#btnAlarmesOk').click();
    await expect(p.locator('#alarmes .alerta')).toHaveCount(0);
  });

  await passo('corrente: números, gráficos, cruz no mouse, toque e teclado', async () => {
    await aba(p, 'corrente');
    await expect(p.locator('.sensor')).toHaveCount(2);
    const bomba = p.locator('.sensor').nth(1);
    await expect(bomba.locator('h2')).toHaveText('Bomba');
    await expect(bomba.locator('.resumo-graf')).toContainText(/Últimos 3 min: mínimo \d,\d\d\sA · média \d,\d\d\sA · máximo \d,\d\d\sA/);
    const v1 = await bomba.locator('.num-v').textContent();
    if (!/^\d,\d\d$/.test(v1)) throw new Error('número estranho: ' + v1);
    await p.waitForTimeout(1600);
    const v2 = await bomba.locator('.num-v').textContent();
    if (v1 === v2) await p.waitForTimeout(1500);
    const canvas = bomba.locator('canvas');
    const pix = await canvas.evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - 0xeb) < 20 && Math.abs(d[k + 1] - 0x68) < 25 && Math.abs(d[k + 2] - 0x34) < 25 && d[k + 3] > 200) n++;
      return n;
    });
    if (pix < 10) throw new Error('linha laranja não apareceu (' + pix + ' pixels)');
    await canvas.evaluate((c) => c.scrollIntoView({ block: 'center' }));
    const caixa = await canvas.boundingBox();
    await p.mouse.move(caixa.x + caixa.width * 0.7, caixa.y + caixa.height * 0.5);
    const dica = bomba.locator('.dica-graf');
    await expect(dica).toBeVisible();
    await expect(dica.locator('strong')).toHaveText(/^\d,\d\d\sA$/);
    await expect(dica.locator('span')).toHaveText(/^09:\d\d:\d\d$/);
    await p.mouse.move(caixa.x + caixa.width * 0.7, caixa.y - 60);
    await expect(dica).toBeHidden();
    await p.touchscreen.tap(caixa.x + caixa.width * 0.6, caixa.y + caixa.height * 0.4);
    await expect(dica).toBeVisible();
    await expect(dica).toBeHidden({ timeout: 6000 });
    await canvas.focus();
    await p.keyboard.press('ArrowLeft');
    await expect(dica).toBeVisible();
    await p.keyboard.press('Escape');
    await expect(dica).toBeHidden();
    const valv = p.locator('.sensor').nth(0);
    await expect(valv.locator('.picos')).toContainText('Válvula 1');
    await expect(valv.locator('.picos')).toContainText(/1,\d\d\sA/);
  });

  await passo('corrente negativa (sensor DC ao contrário): gráfico abaixo de zero e aviso', async () => {
    const s = p.locator('.sensor').nth(0);
    await expect(s.locator('.dica-negativa')).toBeHidden();
    await p.evaluate(() => window.__simFalso.corrente(0, -1.85));
    await expect(s.locator('.num-v')).toHaveText(/^-1,8\d$/, { timeout: 4000 });
    await expect(s.locator('.dica-negativa')).toBeVisible();
    await expect(s.locator('.resumo-graf')).toContainText(/mínimo -1,8\d\sA/);
    await p.waitForTimeout(1500);
    // a linha azul (valor negativo) fica na parte de baixo do gráfico, abaixo do zero
    const r = await s.locator('canvas').evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let baixo = 0;
      for (let y = Math.floor(c.height * 0.62); y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const k = (y * c.width + x) * 4;
          if (Math.abs(d[k] - 0x2a) < 25 && Math.abs(d[k + 1] - 0x78) < 25 && Math.abs(d[k + 2] - 0xd6) < 25 && d[k + 3] > 200) baixo++;
        }
      }
      return { baixo };
    });
    if (r.baixo < 15) throw new Error('a linha negativa não ficou abaixo do zero: ' + JSON.stringify(r));
    await s.screenshot({ path: path.join(SAIDA, 'corrente-negativa.png') });
    await p.evaluate(() => window.__simFalso.corrente(0, null));
  });

  await passo('zerar com saída ligada mostra o erro do controlador', async () => {
    await p.click('#btnZerar');
    await expect(p.locator('#zerarErro')).toBeVisible();
    await expect(p.locator('#zerarErro')).toHaveText('Desligue todas as saídas antes de zerar');
    // desliga o que está ligado pelo programa, zera e volta ao programa
    await aba(p, 'painel');
    for (const nome of ['Válvula 1', 'Hidroponia']) {
      const c = cartao(p, nome);
      await c.getByRole('button', { name: /^(Fechar|Desligar)$/ }).click();
      await expect(c.locator('.palavra')).toHaveText(/^(Fechada|Desligada)$/);
    }
    await aba(p, 'corrente');
    await p.click('#btnZerar');
    await expect(p.locator('.toast').last()).toContainText('Sensores zerados.');
    await expect(p.locator('#zerarErro')).toBeHidden();
    await aba(p, 'painel');
    for (const nome of ['Válvula 1', 'Hidroponia']) {
      const c = cartao(p, nome);
      await c.getByRole('button', { name: 'Voltar ao programa' }).click();
      await expect(c.locator('.palavra')).toHaveText(/^(Aberta|Ligada)$/);
    }
  });

  await passo('programas: horário que passa da meia-noite e limite de valores', async () => {
    await aba(p, 'programas');
    await p.locator('#progSaidas button', { hasText: 'Válvula 2' }).click();
    await expect(p.locator('#progRegras .regra')).toHaveCount(1);
    await p.click('#btnAddFixo');
    const r = p.locator('#progRegras .regra').last();
    await r.getByLabel('Início').fill('23:50');
    const dur = r.getByLabel('Duração');
    await dur.fill('20');
    await dur.press('Tab');
    await expect(r.locator('.regra-dicas')).toContainText('Termina às 00:10 do dia seguinte.');
    await expect(r.locator('.regra-resumo')).toHaveText('Abre 23:50 por 20 min · todos os dias');
    // hoje termina com um bloco em 23:50; amanhã começa com 00:00–00:10
    const hoje = p.locator('#progSemana .barra').nth(0).locator('.bloco').last();
    await expect(hoje).toHaveAttribute('style', /left:99\.30/);
    const amanha = p.locator('#progSemana .barra').nth(1).locator('.bloco').first();
    await expect(amanha).toHaveAttribute('style', /left:0%;width:0\.69/);
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await expect(p.locator('#barraRascunho')).toContainText('Mudanças não enviadas');
    await dur.fill('5000');
    await expect(r.locator('.dica[data-tipo="erro"]')).toContainText('Use de 1 a 1440 min.');
    await dur.press('Tab');
    await expect(dur).toHaveValue('1440');
    await expect(r.locator('.dica[data-tipo="aviso"]')).toHaveText('Ajustado para 1440 (máximo).');
    await dur.fill('20');
    await dur.press('Tab');
    await expect(dur).toHaveValue('20');
    // dias: tirar todos mostra aviso
    const dias = r.locator('.dias button');
    await expect(dias).toHaveCount(7);
  });

  await passo('programas: ciclo, aviso das duas válvulas juntas e apagar', async () => {
    await p.click('#btnAddCiclo');
    const c = p.locator('#progRegras .regra').last();
    await expect(c.locator('.regra-tipo')).toHaveText('Ciclo');
    await expect(c.getByLabel('Das')).toHaveValue('06:00');
    await expect(c.getByLabel('Às')).toHaveValue('18:00');
    await expect(p.locator('#progAvisos')).toContainText('As duas válvulas abrem juntas');
    await expect(p.locator('#progAvisos')).toContainText('dom 09:00–09:15');
    await c.getByRole('button', { name: 'Apagar esta regra' }).click();
    await folha(p).getByRole('button', { name: 'Apagar' }).click();
    await expect(p.locator('#progRegras .regra')).toHaveCount(2);
    await expect(p.locator('#progAvisos .alerta')).toHaveCount(0);
  });

  await passo('programas: modelo da hidroponia', async () => {
    await p.locator('#progSaidas button', { hasText: 'Hidroponia' }).click();
    await expect(p.locator('#progRegras .regra')).toHaveCount(2);
    await p.locator('#progRegras .regra').first().getByRole('button', { name: 'Apagar esta regra' }).click();
    await folha(p).getByRole('button', { name: 'Apagar' }).click();
    await expect(p.locator('#progRegras .regra')).toHaveCount(1);
    await p.click('#btnModelo');
    await folha(p).getByRole('button', { name: 'Trocar' }).click();
    await expect(p.locator('#progRegras .regra')).toHaveCount(2);
    await expect(p.locator('#progRegras .regra-resumo').nth(0)).toHaveText('Das 06:00 às 19:00: liga 15 min, desliga 15 min · todos os dias');
    await expect(p.locator('#progRegras .regra-resumo').nth(1)).toHaveText('Das 19:00 às 06:00: liga 15 min, desliga 45 min · todos os dias');
    await expect(p.locator('#progRegras .regra').nth(1)).toContainText('A janela passa da meia-noite (termina às 06:00 do dia seguinte).');
    await expect(p.locator('#progHojeResumo')).toContainText(/\d+ vezes, \d+ h/);
  });

  await passo('programas: no máximo 8 regras por saída', async () => {
    await p.locator('#progSaidas button', { hasText: 'Relé 2' }).click();
    await expect(p.locator('#progSaidas button', { hasText: 'Relé 2' })).toContainText('desativada');
    for (let k = 0; k < 8; k++) await p.click(k % 2 ? '#btnAddCiclo' : '#btnAddFixo');
    await expect(p.locator('#progRegras .regra')).toHaveCount(8);
    await expect(p.locator('#btnAddFixo')).toBeDisabled();
    await expect(p.locator('#btnAddCiclo')).toBeDisabled();
    await expect(p.locator('#progLimite')).toBeVisible();
    await expect(p.locator('#progRegrasTit')).toHaveText('Regras de Relé 2 (8 de 8)');
    await expect(p.locator('#progHojeResumo')).toContainText('esta saída está desativada');
    await p.locator('#progRegras .regra').last().getByRole('button', { name: 'Apagar esta regra' }).click();
    await folha(p).getByRole('button', { name: 'Apagar' }).click();
    await expect(p.locator('#btnAddFixo')).toBeEnabled();
    // desliga uma regra pelo interruptor
    const sw = p.locator('#progRegras .regra').first().getByRole('switch');
    await sw.uncheck({ force: true });
    await expect(p.locator('#progRegras .regra').first()).toHaveAttribute('data-en', '0');
  });

  await passo('escrita que falha no meio da linha não estraga o comando seguinte', async () => {
    await limparAvisos(p);
    await expect(p.locator('#barraRascunho')).toBeVisible();
    // 1º pedaço vai, o 2º falha nas 3 tentativas: o começo da linha fica no controlador
    await p.evaluate(() => window.__simFalso.falharEscritas(1, 3));
    await p.click('#btnEnviar');
    await expect(p.locator('.toast[data-tipo="erro"]').last()).toContainText('Não gravou: Não deu para mandar ao controlador.');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    const lixo = await p.evaluate(() => window.__simFalso.buffer().length);
    if (lixo < 100) throw new Error('o pedaço do meio devia ter ficado no controlador: ' + lixo);
    await aba(p, 'painel');
    const nMan = (await recebidos(p, 'man')).length;
    await cartao(p, 'Válvula 2').getByRole('button', { name: 'Fechar' }).click();
    await expect(p.locator('.toast').last()).toContainText('Válvula 2 fechada.');
    await expect.poll(async () => (await recebidos(p, 'man')).length).toBe(nMan + 1);
    if (await p.locator('.toast', { hasText: 'não entendeu' }).count()) throw new Error('o comando seguinte foi estragado pela linha pela metade');
    if ((await p.evaluate(() => window.__rega.lig.errIgnorar)) !== 0) throw new Error('err da linha pela metade não chegou');
    await aba(p, 'programas');
  });

  await passo('enviar o rascunho grava no controlador', async () => {
    const antes = (await estatBle(p)).escritas.length;
    await expect(p.locator('#btnEnviar')).toBeEnabled();
    await p.click('#btnEnviar');
    await expect(p.locator('.toast').last()).toContainText('Mudanças gravadas no controlador.');
    await expect(p.locator('#barraRascunho')).toBeHidden();
    const cfg = await p.evaluate(() => window.__simFalso.cfg());
    if (!cfg.s[1].r.some((r) => r.k === 'f' && r.h === 1430 && r.d === 20)) throw new Error('regra 23:50 não chegou: ' + JSON.stringify(cfg.s[1].r));
    if (cfg.s[3].r.length !== 7 || cfg.s[3].r[0].en !== 0) throw new Error('Relé 2 errado: ' + JSON.stringify(cfg.s[3].r));
    const env = (await recebidos(p, 'cfg')).pop();
    if (env.c.tz !== -180 || 'pin' in env.c) throw new Error('cfg enviada estranha');
    const est = await estatBle(p);
    const novas = est.escritas.slice(antes);
    if (Math.max(...novas) > 182 || novas.length < 4) throw new Error('pedaços errados (MTU 185): ' + novas.join(','));
    if (est.colisoes) throw new Error('escritas ao mesmo tempo: ' + est.colisoes);
  });

  await passo('mudança feita durante o envio não some', async () => {
    await aba(p, 'programas');
    await p.locator('#progSaidas button', { hasText: 'Válvula 2' }).click();
    const dur = p.locator('#progRegras .regra').first().getByLabel('Duração');
    await dur.fill('25');
    await dur.press('Tab');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await p.evaluate(() => window.__simFalso.atrasar(1500));
    await p.click('#btnEnviar');
    await expect(p.locator('#barraSub')).toHaveText('Enviando…');
    await dur.fill('33');
    await dur.press('Tab');
    await expect(p.locator('.toast', { hasText: 'Você mudou algo durante o envio' })).toBeVisible({ timeout: 6000 });
    await p.evaluate(() => window.__simFalso.atrasar(0));
    await expect(dur).toHaveValue('33');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    if ((await p.evaluate(() => window.__simFalso.cfg().s[1].r[0].d)) !== 25) throw new Error('o controlador devia ter 25');
    await p.click('#btnEnviar');
    await expect(p.locator('#barraRascunho')).toBeHidden();
    if ((await p.evaluate(() => window.__simFalso.cfg().s[1].r[0].d)) !== 33) throw new Error('o controlador devia ter 33');
  });

  await passo('queda entre o ok e a configuração: o que foi mexido sem ligação fica', async () => {
    const dur = p.locator('#progRegras .regra').first().getByLabel('Duração');
    await dur.fill('40');
    await dur.press('Tab');
    await p.evaluate(() => window.__simFalso.cairAntesDoCfg());
    await p.click('#btnEnviar');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Reconectando…', { timeout: 5000 });
    if ((await p.evaluate(() => window.__simFalso.cfg().s[1].r[0].d)) !== 40) throw new Error('o controlador devia ter gravado 40');
    // sem ligação, muda de novo
    await dur.fill('45');
    await dur.press('Tab');
    await p.evaluate(() => window.__simFalso.alcance(true));
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 20000 });
    await p.waitForTimeout(500);
    await expect(p.locator('#progRegras .regra').first().getByLabel('Duração')).toHaveValue('45');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await p.click('#btnDescartar');
    await folha(p).getByRole('button', { name: 'Descartar' }).click();
    await expect(p.locator('#progRegras .regra').first().getByLabel('Duração')).toHaveValue('40');
    await expect(p.locator('#barraRascunho')).toBeHidden();
  });

  await passo('histórico: frases, filtros e atualizar', async () => {
    await aba(p, 'historico');
    await expect(p.locator('#histLista')).toContainText('Válvula 2 abriu (manual)');
    await expect(p.locator('#histLista')).toContainText('Configuração gravada');
    await expect(p.locator('#histLista')).toContainText('Válvula 1 pausada por 24 h');
    await expect(p.locator('#histLista')).toContainText('Sensores zerados');
    await expect(p.locator('#histLista')).toContainText('Hidroponia liberada (bloqueio retirado)');
    // mais novo primeiro
    const eps = await p.evaluate(() => window.__rega.E.eventos.map((e) => e[0]));
    const primeiraHora = await p.locator('#histLista li .hora').first().textContent();
    const maisNovo = Math.max(...eps);
    const hm = new Date((maisNovo - 3 * 3600) * 1000).toISOString().slice(11, 16);
    if (primeiraHora !== hm) throw new Error('primeiro item devia ser o mais novo: ' + primeiraHora + ' ≠ ' + hm);
    await expect(p.locator('#histLista .hist-dia').first()).toHaveText('Hoje');
    await p.locator('#histFiltros button', { hasText: 'Alarmes' }).click();
    const itens = p.locator('#histLista li');
    await expect(itens).toHaveCount(3);
    await expect(p.locator('#histLista li.alarme')).toHaveCount(3);
    await expect(itens.nth(0)).toContainText('Alarme: Hidroponia ligada sem corrente (0,02 A)');
    await expect(itens.nth(1)).toContainText('Alarme: Hidroponia bloqueada por corrente alta (5,20 A)');
    await expect(itens.nth(2)).toContainText('Alarme: Hidroponia com corrente alta (5,20 A)');
    await expect(itens.nth(0).locator('.hora')).toHaveText(/^\d\d:\d\d$/);
    await p.locator('#histFiltros button', { hasText: 'Válvula 1' }).click();
    const textos = await p.locator('#histLista li .txt').allTextContents();
    if (!textos.length || textos.some((t) => !t.includes('Válvula 1'))) throw new Error('filtro Válvula 1: ' + textos.join(' | '));
    await p.locator('#histFiltros button', { hasText: 'Tudo' }).click();
    const nAntes = await p.evaluate(() => window.__rega.E.eventos.length);
    await p.click('#btnAtualizarLog');
    await expect(p.locator('.toast').last()).toContainText('Histórico atualizado.');
    const nDepois = await p.evaluate(() => window.__rega.E.eventos.length);
    if (nDepois !== nAntes) throw new Error('eventos duplicados ao atualizar: ' + nAntes + ' → ' + nDepois);
    const ult = (await recebidos(p, 'log?')).pop();
    if (!(ult.de > 1700000000)) throw new Error('log? sem "de": ' + JSON.stringify(ult));
  });

  await passo('ajustes: modelos de sensor, nome e descartar', async () => {
    await aba(p, 'ajustes');
    await expect(p.locator('#aba-ajustes')).toContainText('Botão BOOT: segurar 3 s pausa a rega das válvulas por 24 h (ou cancela). A bomba e o relé 2 continuam no programa.');
    await expect(p.locator('#ajCorpo')).toContainText('Ligue se o relé nunca liga: é para módulo que aciona em nível baixo (LOW). Desligado, o pino fica solto e o relé não liga sozinho.');
    const s2 = () => p.locator('.sensor-aj[data-j="1"]');
    await s2().getByLabel('Modelo').selectOption({ label: 'SCT-013-020' });
    await expect(s2().getByLabel('mV por A')).toHaveValue('50');
    await expect(s2().getByLabel('Divisor')).toHaveValue('1');
    await expect(s2().getByRole('button', { name: 'AC (SCT-013)' })).toHaveAttribute('aria-pressed', 'true');
    await s2().getByLabel('Modelo').selectOption({ label: 'ACS712 30 A' });
    await expect(s2().getByLabel('mV por A')).toHaveValue('66');
    await expect(s2().getByLabel('Divisor')).toHaveValue('0,667');
    await expect(s2().getByRole('button', { name: 'DC (ACS712)' })).toHaveAttribute('aria-pressed', 'true');
    await s2().getByLabel('mV por A').fill('70,5');
    await s2().getByLabel('mV por A').press('Tab');
    await expect(s2().getByLabel('Modelo')).toHaveValue('pers');
    await expect(s2().getByLabel('mV por A')).toHaveValue('70,5');
    const sa = s2().getByLabel('O que mede');
    await sa.selectOption({ label: 'Nada (só mostra)' });
    await expect(s2().getByRole('textbox', { name: /^Máximo/ })).toHaveCount(0);
    await sa.selectOption({ label: 'Hidroponia' });
    await expect(s2().getByRole('textbox', { name: /^Máximo/ })).toBeVisible();
    const nome = p.getByLabel('Nome do controlador');
    await nome.fill('Controlador da horta grande');
    await expect(p.locator('.dica[data-tipo="erro"]').first()).toContainText('Muito longo');
    await nome.press('Tab');
    await expect(nome).toHaveValue('Controlador da horta');
    await p.getByLabel('PIN (senha para conectar)').fill('42');
    await p.getByRole('button', { name: 'Trocar PIN' }).click();
    await expect(p.locator('.cartao').filter({ hasText: 'PIN (senha' })).toContainText('PIN novo será gravado ao enviar.');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await p.click('#btnDescartar');
    await folha(p).getByRole('button', { name: 'Descartar' }).click();
    await expect(p.locator('#barraRascunho')).toBeHidden();
    await expect(s2().getByLabel('mV por A')).toHaveValue('33,3');
    await expect(p.getByLabel('Nome do controlador')).toHaveValue('Rega-1A2B');
  });

  await passo('ajustes: texto sendo digitado não some quando a configuração chega', async () => {
    await p.evaluate(() => { window.__simFalso.alcance(false); window.__simFalso.cair(); });
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Reconectando…');
    const nome = p.getByLabel('Nome do controlador');
    await nome.fill('Horta do Sul'); // ainda sem sair do campo
    await p.evaluate(() => window.__simFalso.alcance(true));
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 20000 });
    await p.waitForTimeout(400);
    await expect(nome).toHaveValue('Horta do Sul');
    await expect(nome).toBeFocused();
    await nome.press('Tab');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await p.click('#btnDescartar');
    await folha(p).getByRole('button', { name: 'Descartar' }).click();
    await expect(p.getByLabel('Nome do controlador')).toHaveValue('Rega-1A2B');
  });

  await passo('ajustes: desligar um sensor tira o gráfico dele', async () => {
    const s1 = p.locator('.sensor-aj[data-j="0"]');
    await s1.getByRole('switch', { name: /Sensor ativo/ }).uncheck({ force: true });
    await expect(s1.getByLabel('Modelo')).toHaveCount(0);
    await p.click('#btnEnviar');
    await expect(p.locator('#barraRascunho')).toBeHidden();
    if ((await p.evaluate(() => window.__simFalso.cfg().sen[0].en)) !== 0) throw new Error('sensor 1 não desligou');
    await aba(p, 'corrente');
    await expect(p.locator('.sensor')).toHaveCount(1);
    await expect(p.locator('.sensor h2')).toHaveText('Bomba');
    await aba(p, 'painel');
    await expect(cartao(p, 'Válvula 1').locator('.detalhes')).not.toContainText('Último pulso');
    await aba(p, 'ajustes');
    await p.locator('.sensor-aj[data-j="0"]').getByRole('switch', { name: /Sensor ativo/ }).check({ force: true });
    await p.click('#btnEnviar');
    await expect(p.locator('#barraRascunho')).toBeHidden();
    await aba(p, 'corrente');
    await expect(p.locator('.sensor')).toHaveCount(2);
  });

  await passo('sem sinal por 3 s e volta', async () => {
    await aba(p, 'painel');
    await p.evaluate(() => window.__simFalso.silencio(true));
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Sem sinal', { timeout: 6000 });
    await p.evaluate(() => window.__simFalso.silencio(false));
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 4000 });
  });

  await passo('queda da ligação reconecta sozinho (sem pedir PIN de novo)', async () => {
    const antes = (await estatBle(p)).conexoes;
    await p.evaluate(() => window.__simFalso.cair());
    await expect(p.locator('#topoEstadoTxt')).toHaveText(/Reconectando…|Conectando…/);
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await expect(folha(p)).toBeHidden();
    const depois = (await estatBle(p)).conexoes;
    if (depois !== antes + 1) throw new Error('conexões ' + antes + ' → ' + depois);
    await semToastDeErro(p);
  });

  await passo('queda com o app em segundo plano: espera e reconecta quando volta', async () => {
    const vis = (estado) => p.evaluate((e) => {
      if (e) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => e });
      else delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    }, estado);
    await vis('hidden');
    const n = (await estatBle(p)).connectChamadas;
    await p.evaluate(() => window.__simFalso.cair());
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Reconectando…');
    await expect(p.locator('#cxDetalhe')).toHaveText('Volta a tentar quando o app estiver aberto.');
    await p.waitForTimeout(2000);
    if ((await estatBle(p)).connectChamadas !== n) throw new Error('tentou conectar com o app escondido');
    await vis(null);
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await semToastDeErro(p);
  });

  await passo('Desconectar não reconecta', async () => {
    await p.click('#btnDesconectar');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
    const n = (await estatBle(p)).connectChamadas;
    await p.waitForTimeout(3000);
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
    if ((await estatBle(p)).connectChamadas !== n) throw new Error('tentou reconectar depois de Desconectar');
    // sem ligação: botões de comando ficam desligados e o painel não inventa estado
    await expect(cartao(p, 'Válvula 1').locator('.palavra')).toHaveText('Sem ligação');
    await expect(cartao(p, 'Válvula 1').getByRole('button', { name: 'Abrir por…' })).toBeDisabled();
    await expect(cartao(p, 'Válvula 1').locator('.proxima-txt')).toHaveText('Fecha às 09:30'); // conta do programa com a hora do celular
  });

  await passo('mudança feita sem ligação: espera, não envia sozinha ao conectar', async () => {
    await aba(p, 'programas');
    await p.locator('#progSaidas button', { hasText: 'Válvula 1' }).click();
    await p.click('#btnAddFixo');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await expect(p.locator('#btnEnviar')).toBeDisabled();
    await expect(p.locator('#barraSub')).toHaveText('Conecte para enviar.');
    const nCfg = (await recebidos(p, 'cfg')).length;
    await aba(p, 'painel');
    await p.click('#btnConectar');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await p.waitForTimeout(500);
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await expect(p.locator('#btnEnviar')).toBeEnabled();
    if ((await recebidos(p, 'cfg')).length !== nCfg) throw new Error('mandou a configuração sem pedir');
    if ((await p.evaluate(() => window.__simFalso.cfg().s[0].r.length)) !== 2) throw new Error('controlador mudou sem Enviar');
    await p.click('#btnDescartar');
    await folha(p).getByRole('button', { name: 'Descartar' }).click();
    await expect(p.locator('#barraRascunho')).toBeHidden();
    await p.click('#btnDesconectar');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
  });

  await passo('ao reabrir o app, volta a conectar sozinho (watchAdvertisements)', async () => {
    await p.evaluate(() => localStorage.setItem('__bleFalso.opcoes', JSON.stringify({ pin: '1234' })));
    // o "Desconectar" não esquece o aparelho: ao reabrir tenta de novo
    await p.reload();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await expect(folha(p)).toBeHidden();
    const tipos = await p.evaluate(() => window.__simFalso.recebidos().map((m) => m.t));
    if (tipos.filter((t) => t === 'auth').length !== 1) throw new Error('devia usar o PIN guardado uma vez: ' + tipos.join(','));
    const log = (await recebidos(p, 'log?'))[0];
    if (!(log.de > 1700000000)) throw new Error('log? ao reconectar devia pedir só os novos');
  });

  await passo('sem watchAdvertisements: conecta direto com gatt.connect', async () => {
    await p.evaluate(() => localStorage.setItem('__bleFalso.opcoes', JSON.stringify({ pin: '1234', semWatch: true })));
    await p.reload();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
  });

  await passo('PIN guardado que mudou: pede de novo', async () => {
    await p.evaluate(() => localStorage.setItem('__bleFalso.opcoes', JSON.stringify({ pin: '9999', semWatch: true })));
    await p.reload();
    await expect(folha(p)).toBeVisible({ timeout: 10000 });
    await expect(folha(p).locator('.folha-erro')).toHaveText('O PIN guardado não serve mais.');
    await folha(p).locator('input').fill('9999');
    await folha(p).getByRole('button', { name: 'Entrar' }).click();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
  });

  await passo('5 PINs errados: trava de 60 s com contagem; o PIN guardado não é apagado', async () => {
    await p.click('#btnDesconectar');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
    await p.evaluate(() => localStorage.removeItem('rega.pins'));
    await p.click('#btnConectar');
    for (let k = 1; k <= 4; k++) {
      await expect(folha(p).locator('h2')).toHaveText('PIN do controlador');
      await folha(p).locator('input').fill('000' + k);
      await folha(p).getByRole('button', { name: 'Entrar' }).click();
      await expect(folha(p).locator('.folha-erro')).toHaveText(k >= 3 ? 'PIN errado. Cuidado: com 5 erros seguidos o controlador recusa o PIN por 1 minuto.' : 'PIN errado. Tente de novo.');
    }
    await folha(p).locator('input').fill('0005');
    await folha(p).getByRole('button', { name: 'Entrar' }).click();
    await expect(folha(p)).toBeHidden();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
    await expect(p.locator('#cxDetalhe')).toHaveText(/^Muitos PINs errados\. O controlador só aceita de novo em (60|59) s\.$/);
    await expect(p.locator('#btnConectar')).toBeDisabled();
    if (await p.locator('.toast', { hasText: 'Chegue mais perto' }).count()) throw new Error('mensagem errada na trava');
    await p.clock.runFor(30000);
    await expect(p.locator('#cxDetalhe')).toHaveText(/em (30|29) s\.$/);
    await p.clock.runFor(31000);
    await expect(p.locator('#btnConectar')).toBeEnabled();
    await expect(p.locator('#cxDetalhe')).not.toContainText('Muitos PINs');
    await p.click('#btnConectar');
    await folha(p).locator('input').fill('9999');
    await folha(p).getByRole('button', { name: 'Entrar' }).click();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    // trava feita por outro celular: o PIN guardado (certo) continua guardado
    await p.click('#btnDesconectar');
    await p.evaluate(() => { window.__simFalso.estado.travaPinAte = Date.now() + 45000; });
    await p.click('#btnConectar');
    await expect(p.locator('#cxDetalhe')).toHaveText(/em (45|44) s\.$/);
    await expect(folha(p)).toBeHidden();
    const pins = await p.evaluate(() => JSON.parse(localStorage.getItem('rega.pins') || '{}'));
    if (!Object.values(pins).includes('9999')) throw new Error('apagou o PIN guardado na trava: ' + JSON.stringify(pins));
    await p.clock.runFor(46000);
    await p.click('#btnConectar');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await expect(folha(p)).toBeHidden();
  });

  await passo('controlador longe ao abrir: tenta em silêncio e conecta quando chega perto', async () => {
    await p.evaluate(() => localStorage.setItem('__bleFalso.opcoes', JSON.stringify({ semWatch: true, foraDeAlcance: true })));
    await p.reload();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Reconectando…', { timeout: 5000 });
    await p.waitForTimeout(3500);
    await semToastDeErro(p);
    await expect(p.locator('#cxDetalhe')).toContainText(/Nova tentativa em \d+ s\./);
    await p.evaluate(() => window.__simFalso.alcance(true));
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 15000 });
    await semToastDeErro(p);
    await p.evaluate(() => localStorage.removeItem('__bleFalso.opcoes'));
  });

  await passo('reiniciar o controlador: o app reconecta sozinho', async () => {
    await aba(p, 'ajustes');
    const c0 = (await estatBle(p)).conexoes;
    await p.click('#btnReiniciar');
    await folha(p).getByRole('button', { name: 'Reiniciar' }).click();
    await expect(p.locator('.toast').last()).toContainText('Reiniciando');
    await expect.poll(async () => (await estatBle(p)).conexoes, { timeout: 15000 }).toBe(c0 + 1);
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    const tipos = await p.evaluate(() => window.__simFalso.recebidos().map((m) => m.t));
    if (tipos.filter((t) => t === 'oi').length < 2) throw new Error('não refez o aperto de mão: ' + tipos.join(','));
    await aba(p, 'painel');
  });

  await passo('abre sem internet pelo service worker', async () => {
    await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    const caches1 = await p.evaluate(async () => (await caches.keys()));
    if (!caches1.includes('rega-v1')) throw new Error('cache rega-v1 não existe: ' + caches1);
    const guardados = await p.evaluate(async () => (await (await caches.open('rega-v1')).keys()).map((r) => r.url));
    for (const f of ['index.html', 'agenda.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
      if (!guardados.some((u) => u.endsWith('/' + f))) throw new Error('não guardou ' + f);
    }
    await ctx.setOffline(true);
    await p.reload();
    await expect(p).toHaveTitle('Irriga Horta');
    await expect(p.locator('.nav button')).toHaveCount(5);
    await expect(p.locator('#cartoesSaidas .saida')).toHaveCount(3);
    const temAgenda = await p.evaluate(() => typeof window.Agenda.proximaMudanca === 'function');
    if (!temAgenda) throw new Error('agenda.js não veio do cache');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await ctx.setOffline(false);
  });

  await passo('site fora do ar (404): abre a cópia guardada do app', async () => {
    foraDoAr = true;
    await p.reload();
    await expect(p).toHaveTitle('Irriga Horta');
    await expect(p.locator('.nav button')).toHaveCount(5);
    foraDoAr = false;
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
  });

  await passo('versão nova do app: aviso e atualização', async () => {
    await expect(p.locator('#versaoNova')).toBeHidden();
    versaoSw = 2;
    await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await expect(p.locator('#versaoNova')).toBeVisible({ timeout: 20000 });
    await expect(p.locator('#versaoNova')).toContainText('Versão nova do app');
    await Promise.all([p.waitForEvent('load', { timeout: 20000 }), p.click('#btnAtualizarApp')]);
    await expect(p.locator('#versaoNova')).toBeHidden();
    await p.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === 'activated', null, { timeout: 10000 });
    const r = await p.evaluate(async () => { const g = await navigator.serviceWorker.getRegistration(); return { esperando: !!g.waiting, caches: await caches.keys() }; });
    if (r.esperando || r.caches.join() !== 'rega-v1') throw new Error('depois de atualizar: ' + JSON.stringify(r));
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
  });

  await passo('esquecer o controlador: não volta sozinho e guarda os dados', async () => {
    await aba(p, 'ajustes');
    await p.click('#btnEsquecer');
    await folha(p).getByRole('button', { name: 'Esquecer' }).click();
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
    await expect(p.locator('.toast').last()).toContainText('Controlador esquecido.');
    const ls = await p.evaluate(() => ({ disp: localStorage.getItem('rega.dispositivo'), perm: localStorage.getItem('__bleFalso.permitido'), pins: localStorage.getItem('rega.pins') }));
    if (ls.disp !== null || ls.perm !== null || (ls.pins && Object.keys(JSON.parse(ls.pins)).length)) throw new Error('não esqueceu: ' + JSON.stringify(ls));
    await p.reload();
    await p.waitForTimeout(1500);
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
    if ((await estatBle(p)).connectChamadas !== 0) throw new Error('tentou conectar depois de esquecer');
    await aba(p, 'painel');
    await expect(p.locator('#cartoesSaidas .saida')).toHaveCount(3);
  });

  const estado = await ctx.storageState();
  await ctx.close();
  if (errosAviso.length) throw new Error('mensagens não tratadas: ' + errosAviso.join('\n'));
  return estado;
}

// =====================================================================
async function testeSemBluetooth(url, estado) {
  const ctx = await novoContexto({ semBluetooth: true, storageState: estado });
  const p = await ctx.newPage();
  paginaAtual = p;
  vigiar(p, 'sem-bluetooth');
  await passo('sem navigator.bluetooth: aviso claro e dados guardados', async () => {
    await p.goto(url);
    await expect(p.locator('#avisoSemBt')).toBeVisible();
    await expect(p.locator('#avisoSemBt')).toContainText('Este navegador não tem Bluetooth para sites. Abra no Chrome do Android.');
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Sem Bluetooth');
    await expect(p.locator('#btnConectar')).toBeHidden();
    await expect(p.locator('#cartoesSaidas .saida')).toHaveCount(3);
    await aba(p, 'programas');
    await p.locator('#progSaidas button', { hasText: 'Válvula 1' }).click();
    await expect(p.locator('#progRegras .regra')).toHaveCount(2);
    await expect(p.locator('#progSemana .barra')).toHaveCount(7);
    await aba(p, 'historico');
    await expect(p.locator('#histLista li').first()).toBeVisible();
    await expect(p.locator('#histLista')).toContainText('Configuração gravada');
  });
  await passo('eventos: junta sem repetir, troca os sem hora e guarda no máximo 2000', async () => {
    const r = await p.evaluate(() => {
      const E = window.__rega.E, j = window.__rega.juntarEventos;
      const n0 = E.eventos.length;
      // sem hora (ep = 0): dois eventos iguais por "ev" são dois eventos (abriu, fechou, abriu de novo…)
      j([[0, 0, 1, 1, 0]]);
      const n1 = E.eventos.length;
      j([[0, 0, 1, 1, 0]]);
      const n2 = E.eventos.length;
      // o mesmo log pedido duas vezes não repete; um log com um a mais acrescenta só esse
      j([[0, 0, 1, 1, 0], [0, 0, 1, 1, 0]], true);
      const n2b = E.eventos.length;
      // a versão com hora troca um dos sem hora
      j([[1792600000, 0, 1, 1, 0]]);
      const n3 = E.eventos.length, semHora = E.eventos.filter((e) => e[0] === 0).length;
      const muitos = [];
      for (let k = 0; k < 2100; k++) muitos.push([1792000000 + k, 0, 1, 0, 0]);
      j(muitos);
      return { n0, n1, n2, n2b, n3, semHora, total: E.eventos.length, guardado: JSON.parse(localStorage.getItem('rega.eventos')).length };
    });
    if (r.n1 !== r.n0 + 1 || r.n2 !== r.n1 + 1 || r.n2b !== r.n2 || r.n3 !== r.n2 || r.semHora !== 1) throw new Error(JSON.stringify(r));
    if (r.total !== 2000 || r.guardado !== 2000) throw new Error('limite: ' + JSON.stringify(r));
  });
  await ctx.close();

  const ctx2 = await novoContexto({ armazenamentoQuebrado: true });
  const p2 = await ctx2.newPage();
  paginaAtual = p2;
  vigiar(p2, 'sem-armazenamento');
  await passo('localStorage quebrado: o app abre, conecta e funciona', async () => {
    await p2.goto(url);
    await conectarSemPin(p2);
    await expect(cartao(p2, 'Válvula 1').locator('.palavra')).toHaveText('Aberta');
    await aba(p2, 'programas');
    await p2.click('#btnAddFixo');
    await expect(p2.locator('#barraRascunho')).toBeVisible();
    await p2.click('#btnEnviar');
    await expect(p2.locator('#barraRascunho')).toBeHidden();
  });
  await ctx2.close();
}

// =====================================================================
// Celular em outro fuso e celular com o relógio errado
async function testeFusoERelogio(url) {
  const ctx = await novoContexto({ fuso: 'America/Manaus' });
  const p = await ctx.newPage();
  paginaAtual = p;
  vigiar(p, 'fuso');
  await passo('celular em outro fuso: não muda o fuso do controlador sem pedir', async () => {
    await p.goto(url);
    await conectarSemPin(p);
    const hora = (await recebidos(p, 'hora'))[0];
    if (!hora || 'tz' in hora) throw new Error('hora não devia levar tz: ' + JSON.stringify(hora));
    if ((await p.evaluate(() => window.__simFalso.cfg().tz)) !== -180) throw new Error('o fuso do controlador mudou sozinho');
    await expect(p.locator('#cxRelogio')).toHaveText(/^qua 21\/10 · 09:0\d \(UTC−3\)$/);
    await expect(cartao(p, 'Válvula 1').locator('.proxima-txt')).toHaveText('Fecha às 09:30');
    await aba(p, 'ajustes');
    const sel = p.getByLabel('Fuso horário do controlador');
    await expect(sel).toHaveValue('-180');
    await expect(p.locator('#ajCorpo')).toContainText('Este celular está em UTC−4 e o controlador em UTC−3.');
    await p.locator('#ajCorpo .cartao').first().screenshot({ path: path.join(SAIDA, 'fuso-ajustes.png') });
    await sel.selectOption('-240');
    await expect(p.locator('#barraRascunho')).toBeVisible();
    await p.click('#btnEnviar');
    await expect(p.locator('#barraRascunho')).toBeHidden();
    if ((await p.evaluate(() => window.__simFalso.cfg().tz)) !== -240) throw new Error('fuso escolhido não foi gravado');
    await expect(p.locator('#ajCorpo')).not.toContainText('Este celular está em');
    await aba(p, 'painel');
    await expect(p.locator('#cxRelogio')).toHaveText(/^qua 21\/10 · 08:0\d$/);
    await expect(cartao(p, 'Válvula 1').locator('.palavra')).toHaveText('Fechada');
    await expect(cartao(p, 'Válvula 1').locator('.proxima-txt')).toHaveText('Abre às 09:00');
  });
  await ctx.close();

  const ctx2 = await novoContexto({ hora: new Date('2020-01-01T12:00:00Z') });
  const p2 = await ctx2.newPage();
  paginaAtual = p2;
  vigiar(p2, 'relógio errado');
  await passo('relógio do celular antes de 2023: conecta sem mandar a hora e avisa', async () => {
    await p2.goto(url);
    await p2.click('#btnConectar');
    await expect(p2.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    await expect(p2.locator('.toast[data-tipo="erro"]')).toContainText('O relógio deste celular está errado. Acerte a data e a hora do celular');
    if ((await recebidos(p2, 'hora')).length) throw new Error('mandou a hora errada do celular');
    await expect(cartao(p2, 'Válvula 2').getByRole('button', { name: 'Abrir por…' })).toBeEnabled();
  });
  await ctx2.close();
}

// =====================================================================
// App × núcleo do firmware (testes/nativo/rega). O relógio do núcleo anda junto com o real
// (#avanca 0.25 a cada 250 ms); o que o app escreve no RX vira linhas no stdin do núcleo e o
// stdout do núcleo vai para window.__bleEntrega (cortado no MTU pelo ble-falso.js).
function prepararNativo() {
  const fontes = [path.join(__dirname, 'nativo', 'main.cpp')].concat(['nucleo.h', 'agenda.h', 'relogio.h'].map((f) => path.join(__dirname, '..', 'firmware', 'ControladorRega', f)));
  if (!fontes.every((f) => fs.existsSync(f))) return 'faltam os arquivos do firmware';
  const velho = !fs.existsSync(NATIVO) || fontes.some((f) => fs.statSync(f).mtimeMs > fs.statSync(NATIVO).mtimeMs);
  if (velho) {
    console.log('  ..  compilando o núcleo nativo (testes/nativo/compila.sh)…');
    try { execFileSync('sh', [path.join(__dirname, 'nativo', 'compila.sh')], { stdio: 'ignore', timeout: 600000 }); } catch (e) { return 'não compilou'; }
  }
  return fs.existsSync(NATIVO) ? '' : 'não compilou';
}

class Nativo {
  constructor() {
    this.pagina = null;
    this.erros = [];        // linhas #ERRO do simulador (algo proibido no hardware)
    this.ignoradas = [];    // linhas que chegaram com o "celular" desconectado
    this.respostas = [];    // tudo que o núcleo mandou (objetos)
    this.pulsos = [];       // {valvula, lado, dur}
    this.recebidas = [];    // linhas JSON que o app mandou (objetos)
    this.bufRx = '';
    this.filaPagina = [];   // linhas e quedas a entregar na página, na ordem
    this.agendado = false;
    this.proc = spawn(NATIVO, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.fim = new Promise((r) => this.proc.on('exit', (codigo) => r(codigo)));
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => {
      let m = null;
      try { m = JSON.parse(l); } catch (e) { this.erros.push('stdout não é JSON: ' + l); return; }
      this.respostas.push(m);
      if (m && m.t === '#marca') return; // só para o teste
      this.entregar(l);
    });
    readline.createInterface({ input: this.proc.stderr }).on('line', (l) => {
      if (l.startsWith('#ERRO')) this.erros.push(l);
      else if (l.startsWith('#ignorada')) this.ignoradas.push(l);
      else if (l.startsWith('#pulso ')) {
        const g = (k) => (new RegExp(k + '=([^ ]+)').exec(l) || [])[1];
        this.pulsos.push({ valvula: Number(g('valvula')), lado: g('lado'), dur: Number(g('dur')) });
      } else if (l.startsWith('#desconectado (pelo ESP32)')) { this.bufRx = ''; this.cairNaPagina(); }
      else if (l.startsWith('#reiniciou')) {
        // o simulador volta já "conectado"; o celular de verdade perde a ligação no reinício
        this.cmd('#desconecta');
        this.bufRx = '';
        this.cairNaPagina();
      }
    });
    this.timer = setInterval(() => this.cmd('#avanca 0.25'), 250);
    this.cmd('#desconecta');
  }
  cmd(l) { if (this.proc.exitCode === null) this.proc.stdin.write(l + '\n'); }
  // controle vindo da página (ble-falso): na queda o firmware joga fora a linha pela metade
  ctl(l) {
    if (l.startsWith('#desconecta')) this.bufRx = '';
    this.cmd(l);
  }
  rx(texto) {
    this.bufRx += texto;
    let i;
    while ((i = this.bufRx.indexOf('\n')) >= 0) {
      const l = this.bufRx.slice(0, i);
      this.bufRx = this.bufRx.slice(i + 1);
      if (l && l[0] !== '#') {
        try { this.recebidas.push(JSON.parse(l)); } catch (e) { /* o núcleo responde err */ }
        this.cmd(l);
      }
    }
  }
  entregar(l) { this.paraPagina({ linha: l }); }
  cairNaPagina() { this.paraPagina({ cair: true }); }
  // junta o que sai do núcleo num só evaluate (muitas linhas quando o relógio pula minutos)
  paraPagina(x) {
    this.filaPagina.push(x);
    if (this.agendado) return;
    this.agendado = true;
    setImmediate(() => {
      this.agendado = false;
      const lote = this.filaPagina.splice(0);
      if (!this.pagina || !lote.length) return;
      this.pagina.evaluate((l) => { for (const y of l) { if (y.cair) window.__bleCair(); else window.__bleEntrega(y.linha); } }, lote).catch(() => {});
    });
  }
  async fechar() {
    clearInterval(this.timer);
    this.proc.stdin.end();
    const codigo = await Promise.race([this.fim, esperarMs(5000).then(() => 'tempo')]);
    if (codigo === 'tempo') this.proc.kill();
    return codigo;
  }
}
const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));

// agenda.js (app) × agenda.h (firmware): regras sorteadas, mesmas contas (PROTOCOLO §4)
async function testeAgendaIgual() {
  const Agenda = require('../agenda.js');
  let semente = 20261021;
  const sorteia = (n) => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente % n; };
  const escolhe = (lista) => lista[sorteia(lista.length)];
  const regra = () => {
    const w = escolhe([127, 127, 42, 62, 65, 1, 64, 0, sorteia(128)]);
    const en = sorteia(10) ? 1 : 0;
    if (sorteia(2)) return { k: 'f', h: escolhe([0, 360, 1430, 1439, sorteia(1440)]), d: escolhe([1, 20, 600, 1440, 1 + sorteia(1440)]), w, en };
    const a = escolhe([0, 360, 1140, 1380, sorteia(1440)]);
    return { k: 'c', a, b: escolhe([a, 60, 360, 1140, 1439, sorteia(1440)]), on: escolhe([1, 15, 1440, 1 + sorteia(120)]), off: escolhe([0, 15, 45, 1440, sorteia(120)]), w, en };
  };
  const proc = spawn(NATIVO, [], { stdio: ['pipe', 'ignore', 'pipe'] });
  const linhas = [];
  const espera = [];
  readline.createInterface({ input: proc.stderr }).on('line', (l) => {
    if (l.startsWith('#ERRO')) linhas.push(l);
    if (l.startsWith('#agenda ') || l.startsWith('#ERRO')) { const f = espera.shift(); if (f) f(l); }
  });
  const pede = (texto) => new Promise((r) => { espera.push(r); proc.stdin.write(texto); });
  const N = 300;
  let difs = [];
  for (let k = 0; k < N && difs.length < 5; k++) {
    const regras = Array.from({ length: 1 + sorteia(3) }, regra);
    const tz = escolhe([-180, -180, 0, 330, -720, 840, -300]);
    const ep = 1790000000 + sorteia(20000000) + escolhe([0, 0, 59, 30]);
    const l = await pede(JSON.stringify({ t: 'cfg', c: { tz, s: [{}, {}, {}, { r: regras }] } }) + '\n#hora ' + ep + '\n#agenda 3\n');
    const L = ep + tz * 60;
    const pm = Agenda.proximaMudanca(regras, ep, tz);
    const quer = '#agenda s=3 ativo=' + (Agenda.programaAtivo(regras, L) ? 1 : 0) + ' prox=' + (pm ? pm.ep : -1) + ' on=' + (pm && pm.on ? 1 : 0) +
      ' blocos=' + JSON.stringify(Agenda.blocosDoDia(regras, Math.floor(L / 86400)));
    if (l !== quer) difs.push('regras=' + JSON.stringify(regras) + ' tz=' + tz + ' ep=' + ep + '\n    firmware: ' + l + '\n    app:      ' + quer);
  }
  proc.stdin.end();
  if (difs.length) throw new Error('agenda.h e agenda.js discordam:\n  ' + difs.join('\n  '));
  return N;
}

async function testeNativo(url) {
  const motivo = prepararNativo();
  if (motivo) { avisosFinais.push('teste com o núcleo do firmware PULADO: ' + motivo); return; }
  await passo('firmware: agenda.h e agenda.js dão as mesmas contas (300 casos sorteados)', testeAgendaIgual);
  const nat = new Nativo();
  const ctx = await novoContexto();
  await ctx.exposeFunction('__nativoRx', (t) => nat.rx(t));
  await ctx.exposeFunction('__nativoCtl', (l) => nat.ctl(l));
  await ctx.addInitScript(() => {
    if (window.__bleMtu === 23 && localStorage.getItem('__nativo.mtu')) window.__bleMtu = Number(localStorage.getItem('__nativo.mtu'));
    window.__bleBackend = {
      nome: 'nucleo-nativo',
      send: (t) => window.__nativoRx(t),
      conectou: () => window.__nativoCtl('#conecta ' + window.__bleMtu),
      desconectou: () => window.__nativoCtl('#desconecta')
    };
    window.__nativoCtl('#desconecta'); // página nova = nenhum celular ligado
  });
  const p = await ctx.newPage();
  nat.pagina = p;
  paginaAtual = p;
  vigiar(p, 'nativo');
  const respostas = (t) => nat.respostas.filter((m) => m.t === t);
  // relógio: o núcleo (#avanca) e a página (clock.fastForward) andam juntos
  let nMarca = 0;
  const marca = async () => {
    const id = 'm' + (++nMarca);
    nat.cmd('#marca ' + id);
    await expect.poll(() => nat.respostas.some((m) => m.t === '#marca' && m.m === id), { timeout: 60000 }).toBe(true);
  };
  const epNucleo = () => { const st = respostas('st').pop(); return st ? st.ep : 0; };
  const avancar = async (seg) => {
    nat.cmd('#avanca ' + seg);
    await p.clock.fastForward(Math.round(seg * 1000));
    await marca();
  };
  const irPara = async (alvo) => {
    await marca();
    const d = alvo - (epNucleo() + 0.5);
    if (d < -1) throw new Error('o teste passou da hora ' + new Date((alvo - 10800) * 1000).toISOString().slice(11, 19));
    if (d > 0) await avancar(Math.round(d * 1000) / 1000);
    // espera o app receber tudo o que o núcleo mandou nesse tempo (são muitas linhas)
    await expect.poll(() => p.evaluate(() => (window.__rega.E.st ? window.__rega.E.st.ep : 0)), { timeout: 30000 }).toBeGreaterThanOrEqual(alvo - 1);
    await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
  };
  const hist = (texto) => p.locator('#histLista li', { hasText: texto }).first();
  const esperarPulso = async (valvula, lado, depois) => {
    await expect.poll(() => nat.pulsos.slice(depois).filter((x) => x.valvula === valvula && x.lado === lado).length, { timeout: 5000 }).toBeGreaterThan(0);
    return nat.pulsos.slice(depois).find((x) => x.valvula === valvula && x.lado === lado);
  };
  try {
    await passo('firmware: conecta (MTU 23), acerta a hora e lê a configuração padrão', async () => {
      await p.goto(url);
      await p.click('#btnConectar');
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
      const oi = respostas('oi')[0];
      if (!oi || oi.mtu !== 23 || oi.pin !== 0 || oi.id !== '1A2B') throw new Error('oi: ' + JSON.stringify(oi));
      // garante que quem respondeu foi o núcleo (e não o ESP32 simulado em JS)
      const fw = await p.evaluate(() => window.__rega.E.ctrl.fw);
      if (fw !== oi.fw || /sim/.test(fw)) throw new Error('fw estranho: ' + fw);
      if (await p.evaluate(() => window.__simFalso.estado.conectado)) throw new Error('o ESP32 simulado em JS também conectou');
      await expect(p.locator('.saida')).toHaveCount(3);
      for (const [nome, palavra] of [['Válvula 1', 'Fechada'], ['Válvula 2', 'Fechada'], ['Hidroponia', 'Desligada']]) {
        await expect(cartao(p, nome).locator('.palavra')).toHaveText(palavra);
        await expect(cartao(p, nome).locator('.porque-txt')).toHaveText('Pelo programa');
        await expect(cartao(p, nome).locator('.proxima-txt')).toHaveText('Sem programa');
      }
      await expect(p.locator('#cxNome')).toHaveText('Rega-1A2B');
      await expect(p.locator('#cxHora')).toContainText('Hora certa');
      await expect(p.locator('#cxHora')).toContainText('Sem relógio DS3231');
      await expect(p.locator('#cxRelogio')).toHaveText(/^qua 21\/10 · 09:0\d$/);
      const est = await estatBle(p);
      if (Math.max(...est.escritas) > 20) throw new Error('MTU 23: pedaço maior que 20 bytes');
      await aba(p, 'historico');
      await expect(p.locator('#histLista')).toContainText('Controlador ligou');
      await expect(p.locator('#histLista')).toContainText(/Hora acertada pelo app \(\+(3 min|1\d\d s)\)/);
      await expect(p.locator('#histLista')).toContainText('Válvula 1 fechou (início)');
      await aba(p, 'painel');
    });

    await passo('firmware: abrir por 5 min dá pulso no lado A; voltar ao programa fecha (lado B, 2 vezes)', async () => {
      const c = cartao(p, 'Válvula 1');
      const n0 = nat.pulsos.length;
      await c.getByRole('button', { name: 'Abrir por…' }).click();
      await folha(p).getByRole('button', { name: '5 min', exact: true }).click();
      await expect(c.locator('.palavra')).toHaveText('Aberta');
      await expect(c.locator('.porque-txt')).toHaveText(/^Manual até 09:\d\d$/);
      const abre = await esperarPulso(0, 'A', n0);
      if (Math.abs(abre.dur - 80) > 2) throw new Error('pulso de abrir: ' + JSON.stringify(abre));
      const n1 = nat.pulsos.length;
      await c.getByRole('button', { name: 'Voltar ao programa' }).click();
      await expect(c.locator('.palavra')).toHaveText('Fechada');
      await esperarPulso(0, 'B', n1);
      // f2 = 1: segundo pulso de fechar ~2 s depois
      await expect.poll(() => nat.pulsos.slice(n1).filter((x) => x.valvula === 0 && x.lado === 'B').length, { timeout: 6000 }).toBe(2);
      await aba(p, 'historico');
      await expect(p.locator('#histLista li').first()).toContainText('Válvula 1 fechou (programa)');
      await expect(p.locator('#histLista')).toContainText('Válvula 1 abriu (manual)');
      await aba(p, 'painel');
    });

    await passo('firmware: programa da hidroponia enviado e seguido na hora', async () => {
      await aba(p, 'programas');
      await p.locator('#progSaidas button', { hasText: 'Hidroponia' }).click();
      await p.click('#btnModelo');
      await expect(p.locator('#progRegras .regra')).toHaveCount(2);
      await p.click('#btnEnviar');
      await expect(p.locator('.toast').last()).toContainText('Mudanças gravadas no controlador.');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      const r = await p.evaluate(() => window.__rega.E.cfg.s[2].r);
      const quer = [{ k: 'c', a: 360, b: 1140, on: 15, off: 15, w: 127, en: 1 }, { k: 'c', a: 1140, b: 360, on: 15, off: 45, w: 127, en: 1 }];
      if (JSON.stringify(r) !== JSON.stringify(quer)) throw new Error('regras que o firmware devolveu: ' + JSON.stringify(r));
      await aba(p, 'painel');
      const c = cartao(p, 'Hidroponia');
      await expect(c.locator('.palavra')).toHaveText('Ligada', { timeout: 4000 });
      await expect(c.locator('.porque-txt')).toHaveText('Pelo programa');
      await expect(c.locator('.proxima-txt')).toHaveText('Desliga às 09:15');
    });

    await passo('firmware: sensor da bomba ligado em Ajustes mostra a corrente', async () => {
      await aba(p, 'ajustes');
      const s2 = p.locator('.sensor-aj[data-j="1"]');
      await s2.getByRole('switch', { name: /Sensor ativo/ }).check({ force: true });
      await expect(s2.getByLabel('O que mede')).toHaveValue('2');
      await p.click('#btnEnviar');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      nat.cmd('#corrente 1 1.8');
      await aba(p, 'corrente');
      await expect(p.locator('.sensor')).toHaveCount(1);
      await expect.poll(async () => Number((await p.locator('.sensor .num-v').textContent()).replace(',', '.')), { timeout: 5000 }).toBeGreaterThan(1.6);
      const v = Number((await p.locator('.sensor .num-v').textContent()).replace(',', '.'));
      if (v > 2.0) throw new Error('corrente lida: ' + v);
      await expect(p.locator('.sensor .resumo-graf')).toContainText(/máximo 1,\d\d\sA/);
      await p.click('#btnZerar');
      await expect(p.locator('#zerarErro')).toHaveText('Desligue todas as saídas antes de zerar');
    });

    await passo('firmware: pausa da chuva e cancelar', async () => {
      await aba(p, 'painel');
      await p.click('#btnChuva');
      await folha(p).getByRole('button', { name: '12 h', exact: true }).click();
      await expect(cartao(p, 'Válvula 1').locator('.porque-txt')).toHaveText(/^Pausada até 21:0\d$/);
      await expect(cartao(p, 'Válvula 2').locator('.porque-txt')).toHaveText(/^Pausada até 21:0\d$/);
      await expect(cartao(p, 'Hidroponia').locator('.porque-txt')).toHaveText('Pelo programa');
      await p.click('#btnChuva');
      await expect(cartao(p, 'Válvula 2').locator('.porque-txt')).toHaveText('Pelo programa');
      await aba(p, 'historico');
      await expect(p.locator('#histLista')).toContainText('Válvula 2 pausada por 12 h');
      await expect(p.locator('#histLista')).toContainText('Válvula 2: pausa cancelada');
      await aba(p, 'painel');
    });

    await passo('firmware: nomes com acento passam inteiros com MTU 23 (letras partidas entre pedaços)', async () => {
      await aba(p, 'ajustes');
      const nomeCtl = p.getByLabel('Nome do controlador');
      await nomeCtl.fill('Horta São João');
      await nomeCtl.press('Tab');
      const nomeV2 = p.locator('#ajCorpo .cartao').filter({ has: p.locator('h2', { hasText: /^Válvula 2$/ }) }).getByLabel('Nome', { exact: true });
      await nomeV2.fill('Irrigação Pé de Café');
      await nomeV2.press('Tab');
      await p.click('#btnEnviar');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      const c = respostas('cfg').pop().c;
      if (c.nome !== 'Horta São João' || c.s[1].n !== 'Irrigação Pé de Café') throw new Error('nomes no firmware: ' + c.nome + ' / ' + c.s[1].n);
      const e = await p.evaluate(() => [window.__rega.E.cfg.nome, window.__rega.E.cfg.s[1].n]);
      if (e[0] !== 'Horta São João' || e[1] !== 'Irrigação Pé de Café') throw new Error('nomes no app: ' + e.join(' / '));
      await expect(p.locator('#topoNome')).toHaveText('Horta São João');
      await aba(p, 'painel');
      await expect(cartao(p, 'Irrigação Pé de Café')).toHaveCount(1);
      await expect(p.locator('#cxNome')).toHaveText('Horta São João');
    });

    await passo('firmware: PIN gravado pelo app e usado ao reconectar', async () => {
      await aba(p, 'ajustes');
      await p.getByLabel('PIN (senha para conectar)').fill('2468');
      await p.getByRole('button', { name: 'Trocar PIN' }).click();
      await p.click('#btnEnviar');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      if ((await p.evaluate(() => window.__rega.E.cfg.temPin)) !== 1) throw new Error('temPin não veio');
      await aba(p, 'painel');
      await p.click('#btnDesconectar');
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
      const nAuth = respostas('auth').length;
      await p.click('#btnConectar');
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
      await expect(folha(p)).toBeHidden();
      const auth = respostas('auth').slice(nAuth);
      if (auth.length !== 1 || auth[0].ok !== 1) throw new Error('auth: ' + JSON.stringify(auth));
    });

    await passo('firmware: 5 PINs errados travam 60 s (contagem na tela); depois o PIN certo entra', async () => {
      await p.click('#btnDesconectar');
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
      await p.evaluate(() => localStorage.removeItem('rega.pins'));
      await p.click('#btnConectar');
      for (let k = 1; k <= 5; k++) {
        await expect(folha(p).locator('h2')).toHaveText('PIN do controlador', { timeout: 10000 });
        if (k > 1) await expect(folha(p).locator('.folha-erro')).toContainText('PIN errado.');
        await folha(p).locator('input').fill('1111');
        await folha(p).getByRole('button', { name: 'Entrar' }).click();
      }
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado', { timeout: 10000 });
      await expect(folha(p)).toBeHidden();
      await expect(p.locator('#cxDetalhe')).toHaveText(/^Muitos PINs errados\. O controlador só aceita de novo em (60|59) s\.$/);
      await expect(p.locator('#btnConectar')).toBeDisabled();
      if (await p.locator('.toast', { hasText: 'Chegue mais perto' }).count()) throw new Error('mensagem errada na trava');
      const a5 = respostas('auth').pop();
      if (a5.ok !== 0 || a5.espera !== 60) throw new Error('5º auth: ' + JSON.stringify(a5));
      await avancar(30);
      await expect(p.locator('#cxDetalhe')).toHaveText(/em (2\d|30) s\.$/);
      await avancar(31);
      await expect(p.locator('#btnConectar')).toBeEnabled();
      await p.click('#btnConectar');
      await expect(folha(p).locator('h2')).toHaveText('PIN do controlador', { timeout: 10000 });
      await folha(p).locator('input').fill('2468');
      await folha(p).getByRole('button', { name: 'Entrar' }).click();
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
    });

    await passo('firmware: trava feita por outro celular mostra a espera e não apaga o PIN guardado', async () => {
      await p.click('#btnDesconectar');
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Desconectado');
      await marca();
      // outro celular conecta e erra o PIN 5 vezes
      nat.cmd('#conecta 23');
      for (let k = 0; k < 5; k++) nat.cmd(JSON.stringify({ t: 'auth', pin: '0000' }));
      await marca();
      const trava = respostas('auth').pop();
      if (trava.espera !== 60) throw new Error('o outro celular devia travar: ' + JSON.stringify(trava));
      await p.click('#btnConectar');
      await expect(p.locator('#cxDetalhe')).toHaveText(/^Muitos PINs errados\. O controlador só aceita de novo em (60|59|58) s\.$/, { timeout: 10000 });
      await expect(folha(p)).toBeHidden();
      const pins = await p.evaluate(() => JSON.parse(localStorage.getItem('rega.pins') || '{}'));
      if (!Object.values(pins).includes('2468')) throw new Error('apagou o PIN guardado: ' + JSON.stringify(pins));
      await avancar(61);
      await p.click('#btnConectar');
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 10000 });
      await expect(folha(p)).toBeHidden();
    });

    await passo('firmware: PIN tirado', async () => {
      await aba(p, 'ajustes');
      await p.getByRole('button', { name: 'Tirar PIN' }).click();
      await p.click('#btnEnviar');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      if ((await p.evaluate(() => window.__rega.E.cfg.temPin)) !== 0) throw new Error('PIN não saiu');
    });

    await passo('firmware: reiniciar, reconectar com MTU 517 e programa mantido', async () => {
      await p.evaluate(() => { localStorage.setItem('__nativo.mtu', '517'); window.__bleMtu = 517; });
      const n0 = (await estatBle(p)).escritas.length;
      const c0 = (await estatBle(p)).conexoes;
      await p.click('#btnReiniciar');
      await folha(p).getByRole('button', { name: 'Reiniciar' }).click();
      // "Reconectando…" dura menos de 1 s: confere pela contagem de conexões
      await expect.poll(async () => (await estatBle(p)).conexoes, { timeout: 15000 }).toBe(c0 + 1);
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 15000 });
      const oi = respostas('oi').pop();
      if (oi.mtu !== 517) throw new Error('oi depois do reinício: ' + JSON.stringify(oi));
      if ((await p.evaluate(() => window.__rega.lig.mtu)) !== 517) throw new Error('app não pegou o MTU');
      const novas = (await estatBle(p)).escritas.slice(n0);
      if (!novas.some((x) => x > 20)) throw new Error('com MTU 517 devia mandar pedaços maiores: ' + novas.join(','));
      if (oi.nome !== 'Horta São João') throw new Error('nome no oi: ' + oi.nome);
      await aba(p, 'painel');
      await expect(cartao(p, 'Hidroponia').locator('.palavra')).toHaveText('Ligada', { timeout: 5000 });
      await expect(cartao(p, 'Irrigação Pé de Café')).toHaveCount(1);
      await expect(p.locator('#topoNome')).toHaveText('Horta São João');
      await aba(p, 'historico');
      await expect(p.locator('#histLista .txt', { hasText: 'Controlador ligou' })).toHaveCount(2);
      await expect(p.locator('#histFiltros')).toContainText('Irrigação Pé de Café');
    });

    await passo('firmware: botão BOOT pausa só as válvulas (e cancela), com frases claras no histórico', async () => {
      await aba(p, 'painel');
      nat.cmd('#botao 1');
      await avancar(3.5);
      nat.cmd('#botao 0');
      await avancar(0.5);
      await expect(cartao(p, 'Válvula 1').locator('.porque-txt')).toHaveText(/^Pausada até qui \d\d:\d\d$/);
      await expect(cartao(p, 'Irrigação Pé de Café').locator('.porque-txt')).toHaveText(/^Pausada até qui \d\d:\d\d$/);
      await expect(cartao(p, 'Hidroponia').locator('.porque-txt')).toHaveText('Pelo programa');
      await expect(p.locator('#btnChuva')).toContainText('Cancelar pausa da rega');
      await aba(p, 'historico');
      await expect(hist('Válvula 1 pausada')).toHaveText(/Válvula 1 pausada por 24 h pelo botão do controlador$/);
      await expect(hist('Irrigação Pé de Café pausada')).toHaveText(/Irrigação Pé de Café pausada por 24 h pelo botão do controlador$/);
      await aba(p, 'painel');
      nat.cmd('#botao 1');
      await avancar(3.5);
      nat.cmd('#botao 0');
      await avancar(0.5);
      await expect(cartao(p, 'Válvula 1').locator('.porque-txt')).toHaveText('Pelo programa');
      await expect(cartao(p, 'Irrigação Pé de Café').locator('.porque-txt')).toHaveText('Pelo programa');
      await expect(p.locator('#btnChuva')).toContainText('Pausar a rega (chuva)');
      await aba(p, 'historico');
      await expect(hist('Válvula 1: pausa cancelada')).toHaveText(/Válvula 1: pausa cancelada pelo botão do controlador$/);
      await aba(p, 'painel');
    });

    const hid = cartao(p, 'Hidroponia');
    const v1 = cartao(p, 'Válvula 1');
    const v2 = cartao(p, 'Irrigação Pé de Café');
    await passo('firmware: Ligar por 5 min na hidroponia, alarme de bomba sem corrente e volta ao programa', async () => {
      await irPara(epLocal(21, 9, 16) + 2);
      await expect(hid.locator('.palavra')).toHaveText('Desligada');
      await expect(hid.locator('.proxima-txt')).toHaveText('Liga às 09:30');
      nat.cmd('#corrente 1 0'); // sensor 2 vigia a hidroponia (mínimo 0,1 A)
      await hid.getByRole('button', { name: 'Ligar por…' }).click();
      await folha(p).getByRole('button', { name: '5 min', exact: true }).click();
      await expect(hid.locator('.palavra')).toHaveText('Ligada');
      await expect(hid.locator('.porque-txt')).toHaveText('Manual até 09:21');
      await avancar(10);
      await expect(p.locator('#alarmes')).toContainText(/Hidroponia ligada sem corrente \(0,\d\d\sA\)/);
      await aba(p, 'historico');
      await expect(p.locator('#histLista li.alarme').first()).toContainText(/Alarme: Hidroponia ligada sem corrente \(0,\d\d\sA\)/);
      await expect(p.locator('#histLista li.alarme').first().locator('.hora')).toHaveText('09:16');
      await aba(p, 'painel');
      await p.locator('#btnAlarmesOk').click();
      await expect(p.locator('#alarmes .alerta')).toHaveCount(0);
      nat.cmd('#corrente 1 1.8');
      await irPara(epLocal(21, 9, 21) + 20);
      await expect(hid.locator('.porque-txt')).toHaveText('Pelo programa');
      await expect(hid.locator('.palavra')).toHaveText('Desligada');
      await expect(hid.locator('.proxima-txt')).toHaveText('Liga às 09:30');
      await expect(hid.getByRole('button', { name: 'Voltar ao programa' })).toBeHidden();
    });

    await passo('firmware: horário fixo da Válvula 1 daqui a 2 min por 3 min (abre, fecha, histórico e "Hoje")', async () => {
      await aba(p, 'programas');
      await p.locator('#progSaidas button', { hasText: 'Válvula 1' }).click();
      await p.click('#btnAddFixo');
      const r = p.locator('#progRegras .regra').last();
      await r.getByLabel('Início').fill('09:23');
      const dur = r.getByLabel('Duração');
      await dur.fill('3');
      await dur.press('Tab');
      await p.click('#btnEnviar');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      await aba(p, 'painel');
      await expect(v1.locator('.palavra')).toHaveText('Fechada');
      await expect(v1.locator('.proxima-txt')).toHaveText('Abre às 09:23');
      await expect(v1.locator('.detalhes')).toHaveText('Hoje: 0 min');
      const n0 = nat.pulsos.length;
      await irPara(epLocal(21, 9, 22) + 50);
      await expect(v1.locator('.palavra')).toHaveText('Fechada');
      await irPara(epLocal(21, 9, 23) + 2);
      await expect(v1.locator('.palavra')).toHaveText('Aberta');
      await expect(v1.locator('.porque-txt')).toHaveText('Pelo programa');
      await expect(v1.locator('.proxima-txt')).toHaveText('Fecha às 09:26');
      await esperarPulso(0, 'A', n0);
      await irPara(epLocal(21, 9, 24) + 2);
      await expect(v1.locator('.detalhes')).toHaveText('Hoje: 1 min');
      const n1 = nat.pulsos.length;
      await irPara(epLocal(21, 9, 26) + 4);
      await expect(v1.locator('.palavra')).toHaveText('Fechada');
      await expect(v1.locator('.detalhes')).toHaveText('Hoje: 3 min');
      await expect(v1.locator('.proxima-txt')).toHaveText('Abre qui 09:23');
      await expect.poll(() => nat.pulsos.slice(n1).filter((x) => x.valvula === 0 && x.lado === 'B').length, { timeout: 5000 }).toBe(2);
      await aba(p, 'historico');
      await expect(p.locator('#histLista .hist-dia').first()).toHaveText('Hoje');
      await expect(hist('Válvula 1 abriu (programa)').locator('.hora')).toHaveText('09:23');
      await expect(hist('Válvula 1 fechou (programa)').locator('.hora')).toHaveText('09:26');
      await aba(p, 'painel');
    });

    await passo('firmware: Desligar com o programa ligado fica desligado até a próxima mudança do programa', async () => {
      await irPara(epLocal(21, 9, 30) + 2);
      await expect(hid.locator('.palavra')).toHaveText('Ligada');
      await expect(hid.locator('.proxima-txt')).toHaveText('Desliga às 09:45');
      await hid.getByRole('button', { name: 'Desligar' }).click();
      await expect(hid.locator('.palavra')).toHaveText('Desligada');
      await expect(hid.locator('.porque-txt')).toHaveText('Manual até 09:45');
      await expect(hid.locator('.proxima-txt')).toHaveText('Liga às 10:00');
      const man = nat.recebidas.filter((m) => m.t === 'man').pop();
      if (man.s !== 2 || man.on !== 0 || man.ate !== epLocal(21, 9, 45)) throw new Error('man: ' + JSON.stringify(man));
      await irPara(epLocal(21, 9, 44) + 50);
      await expect(hid.locator('.palavra')).toHaveText('Desligada');
      await expect(hid.locator('.porque-txt')).toHaveText('Manual até 09:45');
      await irPara(epLocal(21, 9, 45) + 3);
      await expect(hid.locator('.porque-txt')).toHaveText('Pelo programa');
      await expect(hid.locator('.palavra')).toHaveText('Desligada');
      await expect(hid.locator('.proxima-txt')).toHaveText('Liga às 10:00');
      const ligou = await p.evaluate((x) => window.__rega.E.eventos.filter((e) => e[1] === 2 && e[2] === 1 && e[0] > x[0] && e[0] < x[1]).length, [epLocal(21, 9, 30) + 3, epLocal(21, 9, 46)]);
      if (ligou) throw new Error('a hidroponia ligou no meio do "Desligar"');
    });

    await passo('firmware: corrente acima do máximo com "cortar" bloqueia; Liberar solta', async () => {
      await aba(p, 'ajustes');
      const s2 = p.locator('.sensor-aj[data-j="1"]');
      const max = s2.getByRole('textbox', { name: /^Máximo/ });
      await max.fill('1');
      await max.press('Tab');
      await s2.getByRole('switch', { name: /Cortar se passar/ }).check({ force: true });
      await p.click('#btnEnviar');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      const sen = await p.evaluate(() => window.__rega.E.cfg.sen[1]);
      if (sen.max !== 1 || sen.corta !== 1) throw new Error('sensor: ' + JSON.stringify(sen));
      // zera com tudo desligado e sem corrente (o reinício de antes zerou com 1,8 A no simulador)
      nat.cmd('#corrente 1 0');
      await aba(p, 'corrente');
      await p.click('#btnZerar');
      await expect(p.locator('.toast').last()).toContainText('Sensores zerados.');
      nat.cmd('#corrente 1 2');
      await expect.poll(async () => Number((await p.locator('.sensor .num-v').textContent()).replace(',', '.')), { timeout: 5000 }).toBeGreaterThan(1.9);
      await aba(p, 'painel');
      await hid.getByRole('button', { name: 'Ligar por…' }).click();
      await folha(p).getByRole('button', { name: '5 min', exact: true }).click();
      await avancar(4);
      await expect(hid.locator('.porque-txt')).toHaveText('Bloqueada: corrente alta');
      await expect(hid.locator('.palavra')).toHaveText('Desligada');
      await expect(hid.locator('.proxima-txt')).toHaveText('Fica desligada até liberar');
      await expect(p.locator('#alarmes')).toContainText(/Hidroponia bloqueada por corrente alta \([12],\d\d\sA\)/);
      await expect(p.locator('#alarmes')).toContainText(/Hidroponia com corrente alta \([12],\d\d\sA\)/);
      nat.cmd('#corrente 1 0.5');
      await hid.getByRole('button', { name: 'Liberar' }).click();
      await expect(hid.locator('.porque-txt')).not.toHaveText('Bloqueada: corrente alta');
      await expect(hid.getByRole('button', { name: 'Liberar' })).toBeHidden();
      if (await hid.getByRole('button', { name: 'Voltar ao programa' }).isVisible()) await hid.getByRole('button', { name: 'Voltar ao programa' }).click();
      await expect(hid.locator('.porque-txt')).toHaveText('Pelo programa');
      await p.locator('#btnAlarmesOk').click();
      await aba(p, 'historico');
      await expect(p.locator('#histLista')).toContainText('Hidroponia liberada (bloqueio retirado)');
      await aba(p, 'painel');
    });

    await passo('firmware: pausa da chuva 24 h segura um horário marcado; Cancelar abre na hora', async () => {
      await marca();
      const ini = (Math.floor(epNucleo() / 60) + 2) * 60;
      const hm = new Date((ini - 10800) * 1000).toISOString().slice(11, 16);
      await aba(p, 'programas');
      await p.locator('#progSaidas button', { hasText: 'Irrigação Pé de Café' }).click();
      await p.click('#btnAddFixo');
      const r = p.locator('#progRegras .regra').last();
      await r.getByLabel('Início').fill(hm);
      const dur = r.getByLabel('Duração');
      await dur.fill('10');
      await dur.press('Tab');
      await p.click('#btnEnviar');
      await expect(p.locator('#barraRascunho')).toBeHidden();
      await aba(p, 'painel');
      await expect(v2.locator('.proxima-txt')).toHaveText('Abre às ' + hm);
      await p.click('#btnChuva');
      await folha(p).getByRole('button', { name: '24 h', exact: true }).click();
      await expect(v2.locator('.porque-txt')).toHaveText(/^Pausada até qui \d\d:\d\d$/);
      await expect(v1.locator('.porque-txt')).toHaveText(/^Pausada até qui \d\d:\d\d$/);
      await expect(p.locator('#btnChuva')).toContainText('Cancelar pausa da rega');
      const n0 = nat.pulsos.length;
      await irPara(ini + 3);
      await expect(v2.locator('.palavra')).toHaveText('Fechada');
      await expect(v2.locator('.porque-txt')).toHaveText(/^Pausada até qui/);
      if (nat.pulsos.slice(n0).some((x) => x.lado === 'A')) throw new Error('abriu válvula durante a pausa');
      await p.click('#btnChuva');
      await expect(v2.locator('.palavra')).toHaveText('Aberta');
      await expect(v2.locator('.porque-txt')).toHaveText('Pelo programa');
      await esperarPulso(1, 'A', n0);
      await expect(p.locator('#btnChuva')).toContainText('Pausar a rega (chuva)');
      await aba(p, 'historico');
      await expect(hist('Irrigação Pé de Café pausada')).toHaveText(/Irrigação Pé de Café pausada por 24 h$/);
      await expect(hist('Irrigação Pé de Café: pausa cancelada')).toBeVisible();
      await aba(p, 'painel');
      await v2.getByRole('button', { name: 'Fechar' }).click();
      await expect(v2.locator('.palavra')).toHaveText('Fechada');
    });

    await passo('firmware: reinício durante uma pausa: a pausa continua depois de reconectar', async () => {
      await v1.getByRole('button', { name: 'Pausar…' }).click();
      await folha(p).getByRole('button', { name: '6 h', exact: true }).click();
      await expect(v1.locator('.porque-txt')).toHaveText(/^Pausada até 15:\d\d$/);
      const txt = await v1.locator('.porque-txt').textContent();
      const c0 = (await estatBle(p)).conexoes;
      nat.cmd('#reinicia');
      await expect.poll(async () => (await estatBle(p)).conexoes, { timeout: 15000 }).toBe(c0 + 1);
      await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado', { timeout: 15000 });
      await expect(v1.locator('.porque-txt')).toHaveText(txt);
      await expect(v1.locator('.palavra')).toHaveText('Fechada');
      await aba(p, 'historico');
      await expect(p.locator('#histLista .txt', { hasText: 'Controlador ligou' })).toHaveCount(3);
      await aba(p, 'painel');
    });
  } finally {
    nat.pagina = null;
    await ctx.close();
    const codigo = await nat.fechar();
    if (nat.erros.length) throw new Error('núcleo nativo reclamou:\n  ' + nat.erros.join('\n  '));
    if (nat.ignoradas.length) throw new Error('linhas mandadas com o celular desconectado:\n  ' + nat.ignoradas.join('\n  '));
    const errs = nat.respostas.filter((m) => m.t === 'err' && m.r !== 'zero');
    if (errs.length) throw new Error('o firmware respondeu err: ' + JSON.stringify(errs));
    if (codigo !== 0 && codigo !== null) throw new Error('núcleo nativo saiu com código ' + codigo);
  }
}

// =====================================================================
async function semRolagemLateral(p, largura) {
  const r = await p.evaluate(() => {
    const larg = document.documentElement.scrollWidth;
    // algum elemento visível passa da borda da tela?
    const fora = [];
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect();
      if (b.width && b.height && (b.right > window.innerWidth + 0.5 || b.left < -0.5) && !el.closest('.so-leitor,[hidden],dialog:not([open])')) {
        fora.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + el.className) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
      }
    }
    return { larg, fora: fora.slice(0, 5) };
  });
  if (r.larg > largura || r.fora.length) throw new Error('passa da largura da tela: ' + JSON.stringify(r));
}

async function capturas(url) {
  const tamanhos = [{ width: 360, height: 780 }, { width: 412, height: 915 }];
  for (const vp of tamanhos) {
    for (const cor of ['light', 'dark']) {
      const nomeBase = vp.width + 'x' + vp.height + '-' + (cor === 'light' ? 'claro' : 'escuro');
      const ctx = await novoContexto({ viewport: vp, cor: cor });
      const p = await ctx.newPage();
      paginaAtual = p;
      vigiar(p, 'capturas ' + nomeBase);
      await passo('capturas ' + nomeBase, async () => {
        await p.goto(url);
        await p.evaluate(() => document.fonts.ready);
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-0-inicio.png'), fullPage: true });
        await semRolagemLateral(p, vp.width);
        await conectarSemPin(p);
        // um alarme e um pouco de história para a tela não ficar vazia
        await p.evaluate(() => { window.__simFalso.evento(2, 21, 0, 0.02); });
        await p.clock.runFor(60000);
        await expect(p.locator('#topoEstadoTxt')).toHaveText('Conectado');
        await p.waitForTimeout(300);
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-1-painel.png'), fullPage: true });
        await semRolagemLateral(p, vp.width);
        // estados especiais: manual, pausada, bloqueada e vários alarmes
        await cartao(p, 'Válvula 1').getByRole('button', { name: 'Abrir por…' }).click();
        await folha(p).getByRole('button', { name: '30 min', exact: true }).click();
        await cartao(p, 'Válvula 2').getByRole('button', { name: 'Pausar…' }).click();
        await folha(p).getByRole('button', { name: '48 h', exact: true }).click();
        await p.evaluate(() => window.__simFalso.bloquear(2, 5.2));
        await expect(cartao(p, 'Hidroponia').locator('.porque-txt')).toHaveText('Bloqueada: corrente alta');
        await expect(cartao(p, 'Válvula 2').locator('.porque-txt')).toHaveText(/^Pausada até sex/);
        await p.waitForTimeout(4200); // os avisos rápidos somem
        await expect(p.locator('#btnChuva')).toContainText('Pausar a rega (chuva)'); // só uma válvula pausada
        await p.evaluate(() => window.scrollTo(0, 0));
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-1b-painel-estados.png'), fullPage: true });
        await semRolagemLateral(p, vp.width);
        await cartao(p, 'Válvula 1').getByRole('button', { name: 'Voltar ao programa' }).click();
        await cartao(p, 'Válvula 2').getByRole('button', { name: 'Cancelar pausa' }).click();
        await cartao(p, 'Hidroponia').getByRole('button', { name: 'Liberar' }).click();
        await expect(cartao(p, 'Hidroponia').locator('.porque-txt')).toHaveText('Pelo programa');
        await p.locator('#btnAlarmesOk').click();
        await aba(p, 'corrente');
        await p.clock.runFor(2000);
        await p.waitForTimeout(400);
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-2-corrente.png'), fullPage: true });
        await semRolagemLateral(p, vp.width);
        const canvas = p.locator('.sensor canvas').nth(1);
        await canvas.evaluate((c) => c.scrollIntoView({ block: 'center' }));
        const caixa = await canvas.boundingBox();
        await p.mouse.move(caixa.x + caixa.width * 0.55, caixa.y + caixa.height * 0.5);
        await p.waitForTimeout(150);
        await canvas.screenshot({ path: path.join(SAIDA, nomeBase + '-2b-grafico-cruz.png') });
        await p.mouse.move(2, 2);
        await aba(p, 'programas');
        await p.locator('#progSaidas button', { hasText: 'Hidroponia' }).click();
        await p.waitForTimeout(200);
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-3-programas.png'), fullPage: true });
        await semRolagemLateral(p, vp.width);
        await p.locator('#progSaidas button', { hasText: 'Válvula 2' }).click();
        await p.click('#btnAddCiclo');
        await p.waitForTimeout(400);
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-3b-programas-rascunho.png'), fullPage: false });
        // botões dos dias com pelo menos 44 px e nada escondido atrás da barra de mudanças
        const larguras = await p.locator('#progRegras .regra .dias button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().width));
        if (Math.min(...larguras) < 44) throw new Error('botões dos dias estreitos: ' + Math.min(...larguras).toFixed(1) + ' px');
        await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await p.waitForTimeout(200);
        const fim = await p.evaluate(() => ({
          barra: document.querySelector('#barraRascunho').getBoundingClientRect().top,
          fundo: Math.max(...Array.from(document.querySelectorAll('#aba-programas .btn')).filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().bottom))
        }));
        if (fim.fundo > fim.barra) throw new Error('botões escondidos atrás da barra: ' + JSON.stringify(fim));
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-3c-programas-fim.png'), fullPage: false });
        // aviso rápido com a barra na tela: fica acima dela
        await aba(p, 'painel');
        await cartao(p, 'Válvula 2').getByRole('button', { name: 'Fechar' }).click();
        await expect(p.locator('.toast').last()).toContainText('Válvula 2 fechada.');
        const t = await p.evaluate(() => ({ barra: document.querySelector('#barraRascunho').getBoundingClientRect().top, aviso: document.querySelector('.toast:last-child').getBoundingClientRect().bottom }));
        if (t.aviso > t.barra) throw new Error('aviso por cima da barra: ' + JSON.stringify(t));
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-3d-aviso-com-barra.png'), fullPage: false });
        await p.waitForTimeout(4200);
        await aba(p, 'historico');
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-4-historico.png'), fullPage: true });
        await semRolagemLateral(p, vp.width);
        await aba(p, 'ajustes');
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-5-ajustes.png'), fullPage: true });
        await semRolagemLateral(p, vp.width);
        await aba(p, 'painel');
        await cartao(p, 'Válvula 1').getByRole('button', { name: 'Abrir por…' }).click();
        await p.waitForTimeout(250);
        await p.screenshot({ path: path.join(SAIDA, nomeBase + '-6-folha.png') });
        await folha(p).getByRole('button', { name: 'Cancelar' }).click();
        const est = await estatBle(p);
        if (Math.max(...est.escritas) > 20) throw new Error('MTU 23: pedaço maior que 20 bytes: ' + Math.max(...est.escritas));
        if (est.colisoes) throw new Error('escritas ao mesmo tempo: ' + est.colisoes);
        const larg = await p.evaluate(() => document.documentElement.scrollWidth);
        if (larg > vp.width) throw new Error('rolagem horizontal: ' + larg + ' > ' + vp.width);
      });
      await ctx.close();
      // navegador sem Bluetooth (ex.: Firefox, iPhone)
      const ctx2 = await novoContexto({ viewport: vp, cor: cor, semBluetooth: true });
      const p2 = await ctx2.newPage();
      paginaAtual = p2;
      vigiar(p2, 'capturas sem bt ' + nomeBase);
      await passo('capturas ' + nomeBase + ' sem Bluetooth', async () => {
        await p2.goto(url);
        await p2.evaluate(() => document.fonts.ready);
        await expect(p2.locator('#avisoSemBt')).toBeVisible();
        await p2.waitForTimeout(6500); // o aviso rápido some
        await p2.screenshot({ path: path.join(SAIDA, nomeBase + '-7-sem-bluetooth.png'), fullPage: true });
        const larg = await p2.evaluate(() => document.documentElement.scrollWidth);
        if (larg > vp.width) throw new Error('rolagem horizontal: ' + larg + ' > ' + vp.width);
      });
      await ctx2.close();
    }
  }
}

// =====================================================================
(async () => {
  servidor = await iniciar(0, undefined, {
    status: (caminho) => (foraDoAr && caminho === '/index.html' ? 404 : undefined),
    trocar: (caminho, dados) => (caminho === '/sw.js' && versaoSw ? Buffer.concat([dados, Buffer.from('\n// teste: versão ' + versaoSw + '\n')]) : undefined)
  });
  // celular em português: sem LANG/LANGUAGE o campo de hora mostra AM/PM
  navegador = await chromium.launch({ args: ['--lang=pt-BR'], env: Object.assign({}, process.env, { LANG: 'pt_BR.UTF-8', LANGUAGE: 'pt_BR', LC_ALL: 'pt_BR.UTF-8' }) });
  let ok = false;
  try {
    console.log('Servidor em ' + servidor.url);
    if (!process.argv.includes('--so-nativo')) {
      const estado = await testePrincipal(servidor.url);
      await testeSemBluetooth(servidor.url, estado);
      await testeFusoERelogio(servidor.url);
    }
    if (!process.argv.includes('--sem-nativo')) await testeNativo(servidor.url);
    if (!process.argv.includes('--sem-capturas')) await capturas(servidor.url);
    if (errosConsole.length) {
      console.log('\nErros de console/página:\n  ' + errosConsole.join('\n  '));
      throw new Error(errosConsole.length + ' erro(s) de console');
    }
    ok = true;
  } catch (e) {
    console.log('\nFALHOU: ' + (e && e.message ? e.message.split('\n')[0] : e));
  } finally {
    await navegador.close();
    await servidor.fechar();
  }
  avisosFinais.forEach((a) => console.log('AVISO: ' + a));
  console.log(ok ? '\nTUDO CERTO: ' + nPassos + ' passos.' : '\nfalhou depois de ' + nPassos + ' passos.');
  process.exit(ok ? 0 : 1);
})();
