// Driver Node do teste diferencial: lê casos.txt e responde usando o agenda.js do app.
// Uso: node driver.cjs <casos.txt> <saida.txt>
// Além da resposta, confere sozinho (sem o Python):
//  - proximaMudanca contra uma busca minuto a minuto feita com o próprio programaAtivo;
//  - blocosDoDia contra programaAtivo minuto a minuto.
// Divergências internas vão para stderr como "INTERNO ...".
'use strict';
const fs = require('fs');
const path = require('path');
// AGENDA_JS: outro agenda.js (usado só no teste de mutantes)
const Agenda = require(process.env.AGENDA_JS || path.join(__dirname, '..', '..', 'agenda.js'));

function leRegras(p, i) {
  const n = Number(p[i++]);
  const rs = [];
  for (let j = 0; j < n; j++) {
    const k = Number(p[i++]), en = Number(p[i++]), w = Number(p[i++]);
    const p1 = Number(p[i++]), p2 = Number(p[i++]), p3 = Number(p[i++]), p4 = Number(p[i++]);
    if (k === 0) rs.push({ k: 'f', h: p1, d: p2, w: w, en: en });
    else rs.push({ k: 'c', a: p1, b: p2, on: p3, off: p4, w: w, en: en });
  }
  return [rs, i];
}

// busca minuto a minuto (a regra do §4.3), independente do proximaMudanca
function forcaBruta(rs, ep, tz, maxMin) {
  const atual = Agenda.programaAtivo(rs, ep + tz * 60);
  let t = (Math.floor(ep / 60) + 1) * 60;
  for (let m = 0; m < maxMin; m++, t += 60) {
    const on = Agenda.programaAtivo(rs, t + tz * 60);
    if (on !== atual) return t + ' ' + (on ? 1 : 0);
  }
  return 'null';
}

function blocosForca(rs, D) {
  const bl = [];
  let ini = -1;
  for (let m = 0; m <= 1440; m++) {
    const on = m < 1440 && Agenda.programaAtivo(rs, D * 86400 + m * 60);
    if (on && ini < 0) ini = m;
    if (!on && ini >= 0) { bl.push(ini + '-' + m); ini = -1; }
  }
  return bl.length ? bl.join(',') : '-';
}

const linhas = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const out = [];
let internos = 0;
for (let n = 0; n < linhas.length; n++) {
  const ln = linhas[n];
  if (!ln) continue;
  const p = ln.split(' ');
  const tipo = p[0];
  const [rs, i] = leRegras(p, 1);
  if (tipo === 'R') {
    const L = Number(p[i]);
    let bits = '';
    for (const r of rs) bits += Agenda.regraAtiva(r, L) ? '1' : '0';
    out.push(bits + ' ' + (Agenda.programaAtivo(rs, L) ? '1' : '0'));
  } else if (tipo === 'P' || tipo === 'Q') {
    const ep = Number(p[i]), tz = Number(p[i + 1]), mx = Number(p[i + 2]);
    const r = mx < 0 ? Agenda.proximaMudanca(rs, ep, tz) : Agenda.proximaMudanca(rs, ep, tz, mx);
    const txt = r ? r.ep + ' ' + (r.on ? 1 : 0) : 'null';
    out.push(txt);
    const fb = forcaBruta(rs, ep, tz, mx < 0 ? 8 * 1440 : mx);
    if (fb !== txt) {
      internos++;
      if (internos <= 20) process.stderr.write('INTERNO linha ' + (n + 1) + ': proximaMudanca=' + txt + ' forca_bruta=' + fb + ' | ' + ln + '\n');
    }
  } else if (tipo === 'B') {
    const D = Number(p[i]);
    const bl = Agenda.blocosDoDia(rs, D);
    const txt = bl.length ? bl.map((b) => b[0] + '-' + b[1]).join(',') : '-';
    out.push(txt);
    const fb = blocosForca(rs, D);
    if (fb !== txt) {
      internos++;
      if (internos <= 20) process.stderr.write('INTERNO linha ' + (n + 1) + ': blocosDoDia=' + txt + ' forca_bruta=' + fb + ' | ' + ln + '\n');
    }
  } else {
    out.push('ERRO');
  }
}
fs.writeFileSync(process.argv[3], out.join('\n') + '\n');
process.stderr.write('node: ' + out.length + ' linhas, ' + internos + ' divergências internas\n');
process.exit(internos ? 1 : 0);
