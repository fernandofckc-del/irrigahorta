// Servidor estático simples para testar o app (só 127.0.0.1).
// Uso: node testes/servidor.cjs [porta]      (porta 0 = qualquer livre)
// Em outro script: const { iniciar } = require('./servidor.cjs'); const s = await iniciar(0); s.porta; s.fechar();
// Opção para os testes: iniciar(0, undefined, { trocar(caminho, dados) { return dados; } })
//   muda o conteúdo servido (ex.: um sw.js diferente para testar o aviso de versão nova).
//   caminho = '/sw.js', '/index.html'…; devolva um Buffer/texto (ou nada para servir igual).
// Também: { status(caminho) { return 404; } } responde com esse código (site fora do ar).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

function iniciar(porta = 0, raiz = RAIZ, opcoes = {}) {
  const servidor = http.createServer((req, res) => {
    let caminho;
    try {
      caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch (e) {
      res.writeHead(400).end('pedido ruim');
      return;
    }
    if (caminho.endsWith('/')) caminho += 'index.html';
    const arquivo = path.resolve(raiz, '.' + caminho);
    // nada fora da raiz, nada escondido (.git, .saida)
    const relativo = path.relative(raiz, arquivo);
    if (relativo.startsWith('..') || path.isAbsolute(relativo) || relativo.split(path.sep).some((p) => p.startsWith('.'))) {
      res.writeHead(404).end('não encontrado');
      return;
    }
    const st = typeof opcoes.status === 'function' ? opcoes.status('/' + relativo.split(path.sep).join('/')) : undefined;
    if (st) {
      res.writeHead(st, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }).end('fora do ar (' + st + ')');
      return;
    }
    fs.readFile(arquivo, (erro, dados) => {
      if (erro) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('não encontrado');
        return;
      }
      if (typeof opcoes.trocar === 'function') {
        const novo = opcoes.trocar('/' + relativo.split(path.sep).join('/'), dados);
        if (novo !== undefined && novo !== null) dados = Buffer.isBuffer(novo) ? novo : Buffer.from(String(novo));
      }
      res.writeHead(200, {
        'Content-Type': TIPOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : dados);
    });
  });
  return new Promise((ok, falha) => {
    servidor.once('error', falha);
    servidor.listen(porta, '127.0.0.1', () => {
      const p = servidor.address().port;
      ok({
        porta: p,
        url: 'http://127.0.0.1:' + p + '/',
        fechar: () => new Promise((r) => servidor.close(() => r()))
      });
    });
  });
}

module.exports = { iniciar };

if (require.main === module) {
  iniciar(Number(process.argv[2] || 8080)).then((s) => {
    console.log('Servindo ' + RAIZ + ' em ' + s.url);
  });
}
