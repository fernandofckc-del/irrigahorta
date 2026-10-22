/*
 * Service worker do Irriga Horta: guarda o app no celular para abrir sem internet.
 * Ao publicar uma versão nova do app, troque o número do CACHE (rega-v1 → rega-v2…).
 */
'use strict';

const CACHE = 'rega-v1';
const CASCA = [
  './',
  './index.html',
  './agenda.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];
// mesmo endereço do <link> de fontes do index.html
const FONTES_CSS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@400;500;600;700&display=swap';
const TEMPO_REDE_MS = 4000;

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CASCA.map((u) => new Request(u, { cache: 'reload' })));
    // fontes: melhor esforço (sem internet, o app usa as fontes do sistema)
    try { await guardarFontes(c); } catch (e) { /* segue sem fontes */ }
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((n) => n.startsWith('rega-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.tipo === 'atualizar') self.skipWaiting();
});

async function guardarFontes(c) {
  const resp = await fetch(FONTES_CSS, { mode: 'cors' });
  if (!resp.ok) return;
  await c.put(FONTES_CSS, resp.clone());
  const css = await resp.text();
  // só o subconjunto "latin" (português); os outros vêm na hora, se precisar
  const blocos = css.match(/\/\*\s*latin\s*\*\/\s*@font-face\s*{[^}]*}/g) || [];
  const urls = [];
  blocos.forEach((b) => {
    const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(b);
    if (m) urls.push(m[1]);
  });
  await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(u, { mode: 'cors' });
      if (r.ok) await c.put(u, r);
    } catch (e) { /* ignora */ }
  }));
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    ev.respondWith(navegacao(ev));
  } else if (url.origin === 'https://fonts.googleapis.com') {
    ev.respondWith(cssFontes(ev));
  } else if (url.origin === 'https://fonts.gstatic.com') {
    ev.respondWith(arquivoFonte(req));
  } else if (url.origin === self.location.origin) {
    ev.respondWith(daCasca(ev));
  }
});

// mantém o service worker vivo até a atualização por trás terminar
function manter(ev, promessa) {
  try { ev.waitUntil(promessa.catch(() => {})); } catch (e) { /* evento já acabou */ }
}

function eIndex(url) {
  const base = new URL('./', self.registration.scope).pathname;
  return url.pathname === base || url.pathname === base + 'index.html';
}

// Página: tenta a rede por até 4 s; sem resposta, usa a cópia guardada.
async function navegacao(ev) {
  const req = ev.request;
  const c = await caches.open(CACHE);
  const daRede = fetch(req).then(async (r) => {
    if (r && r.ok && eIndex(new URL(req.url))) await c.put('./index.html', r.clone());
    return r;
  });
  manter(ev, daRede);
  let timer;
  const tempo = new Promise((resolve) => { timer = setTimeout(() => resolve(null), TEMPO_REDE_MS); });
  try {
    const r = await Promise.race([daRede, tempo]);
    clearTimeout(timer);
    if (r && r.ok) return r; // 404/500 (site fora do ar, repositório renomeado): usa a cópia guardada
  } catch (e) {
    clearTimeout(timer);
  }
  const guardada = (await c.match('./index.html')) || (await c.match(req, { ignoreSearch: true }));
  if (guardada) return guardada;
  try { return await daRede; } catch (e) {
    return new Response('<!doctype html><meta charset="utf-8"><title>Sem internet</title><p style="font:18px sans-serif;padding:16px">Sem internet e o app ainda não foi guardado neste celular. Abra uma vez com internet.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

// é um dos arquivos do app (lista CASCA)?
function eDaCasca(url) {
  const base = new URL('./', self.registration.scope);
  return CASCA.some((u) => new URL(u, base).pathname === url.pathname);
}

// Arquivos do app: usa a cópia guardada na hora e atualiza por trás.
// (outros arquivos do site, como docs/, vêm da rede e não são guardados)
async function daCasca(ev) {
  const req = ev.request;
  const c = await caches.open(CACHE);
  const daCascaMesmo = eDaCasca(new URL(req.url));
  const guardada = daCascaMesmo ? await c.match(req, { ignoreSearch: true }) : null;
  const daRede = fetch(req).then(async (r) => {
    if (daCascaMesmo && r && r.ok && r.type === 'basic') await c.put(req.url.split('?')[0], r.clone());
    return r;
  });
  if (guardada) {
    manter(ev, daRede);
    return guardada;
  }
  return daRede;
}

// CSS das fontes do Google: cópia guardada primeiro; sem nada, CSS vazio (fontes do sistema).
async function cssFontes(ev) {
  const req = ev.request;
  const c = await caches.open(CACHE);
  const guardada = await c.match(req);
  const daRede = fetch(req).then(async (r) => {
    if (r && r.ok) await c.put(req, r.clone());
    return r;
  });
  if (guardada) {
    manter(ev, daRede);
    return guardada;
  }
  try {
    return await daRede;
  } catch (e) {
    return new Response('', { headers: { 'Content-Type': 'text/css' } });
  }
}

// Arquivos de fonte: nunca mudam; guarda na primeira vez.
async function arquivoFonte(req) {
  const c = await caches.open(CACHE);
  const guardada = await c.match(req);
  if (guardada) return guardada;
  try {
    const r = await fetch(req);
    if (r && (r.ok || r.type === 'opaque')) await c.put(req, r.clone());
    return r;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'sem internet' });
  }
}
