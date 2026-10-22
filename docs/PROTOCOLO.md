# Irriga Horta · especificação (v1)

Este documento é o contrato entre o **firmware do ESP32** (`firmware/ControladorRega/`) e o **app PWA**
(`index.html` + `agenda.js` na raiz do repositório). Qualquer mudança aqui precisa ser feita nos dois lados.

- Placa: **ESP32-WROOM-32 DevKit** (30 ou 38 pinos), núcleo Arduino-ESP32 **2.0.x e 3.x** (o firmware tem que compilar nos dois).
- Biblioteca externa única: **ArduinoJson 7.x**.
- Ligação app ↔ ESP32: **Bluetooth Low Energy** (Web Bluetooth no Chrome do Android). Sem Wi-Fi e sem internet.
- Site do app: `https://fernandofckc-del.github.io/irrigahorta/` (GitHub Pages, HTTPS — obrigatório para o Web Bluetooth).
- Repositório: `fernandofckc-del/irrigahorta`. Nome do app: **Irriga Horta** (nome curto no celular: **Irriga**).

---

## 1. Hardware e pinos (fixos no firmware)

| Função | GPIO | Observação |
|---|---|---|
| Válvula 1 — lado A (IN1 da ponte H) | 25 | |
| Válvula 1 — lado B (IN2 da ponte H) | 26 | |
| Válvula 2 — lado A (IN3 da ponte H) | 27 | |
| Válvula 2 — lado B (IN4 da ponte H) | 33 | |
| Relé 1 — saída 3 (Hidroponia) | 16 | |
| Relé 2 — saída 4 (livre: luz, aerador…) | 17 | |
| Sensor de corrente 1 | 34 | ADC1, só entrada |
| Sensor de corrente 2 | 35 | ADC1, só entrada |
| I²C SDA (relógio DS3231, opcional) | 21 | |
| I²C SCL (relógio DS3231, opcional) | 22 | |
| LED de estado (LED azul da placa) | 2 | |
| Botão BOOT da placa | 0 | segurar 3 s = pausa da rega, só as válvulas (ver §6.4) |

Pinos escolhidos para **não pulsar no boot** (evitados: 0, 1, 2, 3, 5, 12, 14, 15 para a ponte H e relés).

**Ponte H** (L298N, TB6612FNG, DRV8833, L9110S…): cada válvula usa 2 entradas (A e B).
- **Abrir** = A em nível alto, B em nível baixo, durante `pms` milissegundos; depois A e B em nível baixo.
- **Fechar** = A baixo, B alto, durante `pms` ms; depois os dois em nível baixo.
- Com `inv = 1` na válvula, troca: abrir = B alto, fechar = A alto.
- **Nunca** A e B altos ao mesmo tempo. **Nunca** deixar um lado alto depois do pulso (queima a bobina).
- Dois pulsos nunca acontecem ao mesmo tempo: são feitos um de cada vez, com **pelo menos 300 ms** entre o fim de um e o início do próximo.

**Relés**: **desligado = pino solto** (`INPUT`, alta impedância, sem pull-up/pull-down), em qualquer caso — assim nenhum tipo de módulo liga sozinho no 1º boot ou antes de a configuração ser lida, e módulos de 5 V acionados em nível baixo desligam de verdade. **Ligado** = `OUTPUT` em nível alto; com `inv = 1` (módulos "acionados em nível baixo"), `OUTPUT` em nível baixo.

**Sensores de corrente** (analógicos, lidos com `analogReadMilliVolts`):
- ACS712 (5 A = 185 mV/A, 20 A = 100 mV/A, 30 A = 66 mV/A), alimentado em 5 V, **com divisor** 10 k (em cima) + 20 k (embaixo) → `div = 0.667`.
- SCT-013 com saída em tensão (ex.: SCT-013-030 = 1 V para 30 A → 33,3 mV/A), com polarização em 1,65 V → `div = 1`.

---

## 2. As 4 saídas e as 2 entradas de corrente

Índices usados em todo o protocolo:

| índice | saída | tipo |
|---|---|---|
| 0 | Válvula 1 | latch (ponte H) |
| 1 | Válvula 2 | latch (ponte H) |
| 2 | Relé 1 (padrão "Hidroponia") | relé |
| 3 | Relé 2 | relé |

Sensores: índice 0 = GPIO34, índice 1 = GPIO35.

---

## 3. Hora

- O ESP32 guarda a hora em **UTC (epoch em segundos)**. `tz` = fuso em **minutos** (Brasil = `-180`; sem horário de verão).
- **Hora local em segundos**: `L = ep + tz*60`.
- **Dia**: `D = floor(L / 86400)`. **Segundo do dia**: `L - D*86400`.
- **Dia da semana** do dia `D`: `wd(D) = ((D + 4) mod 7 + 7) mod 7` → 0 = domingo, 1 = segunda … 6 = sábado (1/1/1970 foi quinta-feira).
- **Máscara de dias `w`**: bit 0 = domingo … bit 6 = sábado. `127` = todos os dias.
- Hora **válida** = `ep >= 1700000000`. Sem hora válida a programação **não liga nada** (só o manual funciona).
- Fontes de hora: (1) o app manda a hora do celular a cada conexão; (2) relógio **DS3231** opcional (endereço I²C 0x68; guarda UTC; se o bit OSF — registrador 0x0F, bit 7 — estiver ligado, a hora do DS3231 é inválida; ao acertar, grava a hora e limpa o OSF); (3) a hora do sistema que sobreviveu a um reinício por software (`time() >= 1700000000` no boot).

---

## 4. Regras de programação (mesma conta no firmware `agenda.h` e no app `agenda.js`)

Cada saída tem até **8 regras**. A saída está ligada pelo programa se **qualquer** regra habilitada (`en = 1`) estiver ativa.

### 4.1 Horário fixo — `{"k":"f","h":360,"d":20,"w":127,"en":1}`
- `h` = início em minutos do dia (0–1439), `d` = duração em minutos (1–1440), `w` = dias (0–127).
- Ativa em `L` se, para algum `k ∈ {0, 1}`: com `Dk = D - k`, o bit `wd(Dk)` de `w` está ligado e
  `Dk*86400 + h*60 <= L < Dk*86400 + h*60 + d*60`.
  (O dia que conta é o **dia em que começou**; um horário de 23:50 por 20 min termina às 00:10 do dia seguinte.)

### 4.2 Ciclo — `{"k":"c","a":360,"b":1140,"on":15,"off":15,"w":127,"en":1}`
- Janela das `a` às `b` (minutos do dia, 0–1439). Se `b <= a` a janela passa da meia-noite; se `b == a` a janela é de 24 h.
- Comprimento da janela em minutos: `len = (b - a + 1440) mod 1440`; se `len == 0` então `len = 1440`.
- `on` = minutos ligado (1–1440), `off` = minutos desligado (0–1440; 0 = ligado direto na janela).
- Ativa em `L` se, para algum `k ∈ {0, 1}`: com `Dk = D - k` e `W = Dk*86400 + a*60`, o bit `wd(Dk)` de `w` está ligado,
  `W <= L < W + len*60` e (`off == 0` ou `(L - W) mod ((on+off)*60) < on*60`).
  (O ciclo **recomeça ligado** no início de cada janela.)

### 4.3 Observações
- Todas as mudanças acontecem em **início de minuto** (local). Para achar a próxima mudança basta testar minuto a minuto.
- Regra com `en = 0` ou `w = 0` nunca fica ativa.
- `agenda.js` exporta (navegador: `window.Agenda`; Node: `module.exports`):
  - `regraAtiva(regra, L) → bool`
  - `programaAtivo(regras, L) → bool`
  - `proximaMudanca(regras, ep, tz, maxMin = 8*1440) → {ep, on} | null` — primeiro minuto (> `ep`, alinhado ao minuto) em que o estado do programa muda; `on` = novo estado. Procura até `ep + maxMin*60` (inclusive); se nada muda até lá, `null`.
  - `blocosDoDia(regras, D) → [[iniMin, fimMin], …]` — intervalos ligados dentro do dia local `D` (minutos 0–1440, `fim` exclusivo).
- `agenda.h` expõe as mesmas contas em C++ puro (sem Arduino), com `int64_t` para `L`.

---

## 5. Estado de cada saída (prioridades)

A cada segundo o firmware calcula o estado desejado de cada saída, nesta ordem (a primeira que valer decide):

| ordem | condição | estado | origem `o` |
|---|---|---|---|
| 1 | saída desabilitada (`en = 0`) | desligada | 7 |
| 2 | bloqueada por corrente alta (`b = 1`) | desligada | 3 |
| 3 | manual ativo (`agora < ma`) | `mo` | 1 |
| 4 | pausada (`agora < pa`) | desligada | 2 |
| 5 | sem hora válida | desligada | 0 |
| 6 | programa (§4) | ligado/desligado | 0 |

- **Manual** (`ma` = até quando, epoch; `mo` = ligado/desligado): quando vence, volta sozinho ao programa (`ma = 0`).
- **Pausa** (`pa`, epoch, por saída): ao pausar, o manual daquela saída é cancelado. **A pausa e o bloqueio ficam gravados** (sobrevivem a falta de energia); o manual não.
- **Válvula**: o firmware não sabe a posição real; guarda o estado que **mandou**. No boot fecha as duas (pulso de fechar em cada uma, origem 4). Quando o desejado muda, entra na fila de pulsos. Com `f2 = 1`, depois de cada **fechamento** manda um 2º pulso de fechar 2 s depois (sem registrar evento).
- **Relé**: liga/desliga o pino na hora.
- `hj` = segundos ligada **hoje** (dia local); zera na virada do dia. Só em memória.

---

## 6. Corrente

### 6.1 Medição
- A cada **250 ms** o firmware faz uma janela de **100 ms** (6 ciclos de 60 Hz, 5 de 50 Hz), lendo os sensores habilitados alternadamente.
- `sens = mva * div` (mV por A no pino).
- **DC**: `I = (média_mV - z_mV) / sens * aj`. Se `|I| < zona morta` → `0`. Zona morta = `max(0.01, 3 * ruído_mV / sens * aj)`.
- **AC**: `rms = raiz(média((v - média)²))`; `I = raiz(max(0, rms² - ruído²)) / sens * aj`.
- **Zerar**: com todas as saídas desligadas, mede 1 s e guarda `z_mV` (média) e `ruído_mV` (desvio padrão) de cada sensor. Feito **sozinho no boot** (tudo desligado) e pelo comando `zero`. Não é gravado.

### 6.2 O que cada sensor vigia — campo `sa`
- `-1` = só mostra.
- `-2` = **pulso das válvulas**: durante cada pulso, lê o sensor sem parar e guarda o **pico** `|v - z| / sens * aj` em A (`pk` da válvula). Se `min > 0` e o pico ficar abaixo de `min` → alarme 20.
- `0..3` = vigia a **saída** de índice `sa` (útil para a bomba no relé):
  - Saída ligada há ≥ 5 s e `|I| < min` (com `min > 0`) por 3 s seguidos → alarme 21 (uma vez por vez que liga).
  - `max > 0` e `|I| > max` por 2 s seguidos → alarme 22 (uma vez por vez que liga); se `corta = 1` → **bloqueia** a saída (`b = 1`, evento 23, desliga com origem 3).
- Bloqueio sai com o comando `lib` ou com um `man` ligando a saída.

### 6.3 Envio
- Mensagem `i` a cada 250 ms enquanto conectado (§8).

### 6.4 Botão BOOT
- Segurar **3 s** = "pausa da rega" **só das válvulas** (saídas 0 e 1; os relés da hidroponia continuam no programa — parar a bomba 24 h pode matar as plantas):
  se nenhuma das duas válvulas estiver pausada → pausa as duas por 24 h (um evento 13 para cada válvula, `o = 5`, `v = 24`); se alguma estiver pausada → cancela a pausa das duas (um evento 14 para cada válvula pausada, `o = 5`).

### 6.5 LED (GPIO 2)
- Conectado ao app: **aceso**.
- Sem hora válida: pisca rápido (liga/desliga a cada 250 ms).
- Normal: pisca curto (100 ms) a cada 3 s.

---

## 7. Bluetooth (GATT)

| item | UUID | propriedades |
|---|---|---|
| Serviço | `7a3e0001-9c4b-4f8e-b3a1-2d6c5e4f1a90` | |
| RX (app → ESP32) | `7a3e0002-9c4b-4f8e-b3a1-2d6c5e4f1a90` | WRITE, WRITE_NR |
| TX (ESP32 → app) | `7a3e0003-9c4b-4f8e-b3a1-2d6c5e4f1a90` | NOTIFY (com descritor CCCD 0x2902) |

- Nome no anúncio: `nome` da configuração (padrão `Rega-XXXX`, XXXX = 4 últimos dígitos hex do MAC), no **scan response**. O pacote de anúncio leva flags + UUID do serviço (o app filtra pelo serviço).
- Um celular por vez. Ao desconectar, volta a anunciar.
- MTU local 517. O ESP32 informa o MTU combinado na mensagem `oi`.
- **Mensagens = 1 objeto JSON por linha, terminado em `\n`, UTF-8.** Cada lado corta a linha em pedaços e o outro junta até achar `\n`.
  - ESP32 → app: pedaços de até `mtu - 3` bytes (máx. 500); se o MTU não for conhecido, 20 bytes. Uma notificação por pedaço.
  - App → ESP32: pedaços de até 20 bytes até receber `oi`; depois até `mtu - 3` (máx. 500). Escrita **com resposta**, uma de cada vez.
  - O app decodifica com `TextDecoder` em modo `stream` (um caractere acentuado pode vir partido entre dois pedaços).
  - Linha maior que 4096 bytes é descartada.
  - O último pedaço de uma linha nunca é só o `\n` (o app junta o `\n` ao pedaço anterior).
  - Se um envio falha no meio de uma linha, a próxima linha vai com um `\n` na frente (nos dois sentidos), para fechar a linha pela metade. O app descarta a linha pela metade que recebe e ignora a resposta `err` com `r = ""` que o ESP32 manda por causa da que ele mandou pela metade.

### 7.1 PIN (opcional)
- Se a configuração tiver PIN, depois de conectar só valem `oi` e `auth` até acertar. Outros comandos respondem `{"t":"err","r":"<t>","m":"pin"}`.
- 5 PINs errados seguidos → o ESP32 responde `{"t":"auth","ok":0,"espera":60}`, desconecta **e recusa qualquer `auth` por 60 s** (mesmo depois de reconectar; o contador e a trava ficam em memória, valem para todas as conexões). Durante a trava, `auth` responde `{"t":"auth","ok":0,"espera":<segundos que faltam>}` sem conferir o PIN. Um PIN certo zera o contador. Quando a trava acaba, o contador recomeça do zero (mais 5 tentativas). Um reinício do ESP32 apaga a trava e o contador (só em memória).
- O app: mostra a contagem da espera, não tenta de novo sozinho e não apaga o PIN guardado. Uma queda da ligação durante o `auth` logo depois de 4 erros seguidos conta como trava de 60 s.

---

## 8. Mensagens

Toda mensagem tem `t` (tipo). Datas = epoch UTC em segundos. Correntes em A com até 3 casas.

### 8.1 App → ESP32

| `t` | campos | o que faz | resposta |
|---|---|---|---|
| `oi` | — | pede apresentação (o app manda logo depois de ligar as notificações) | `oi` |
| `auth` | `pin` (texto) | libera os comandos | `{"t":"auth","ok":1}` ou `{"t":"auth","ok":0}`; com `espera` (segundos) no 5º erro e durante a trava (§7.1) |
| `hora` | `ep`, `tz` (opcional) | acerta a hora (e o DS3231). Se vier `tz` diferente, grava na configuração (o app **não** manda `tz`: o fuso só muda pelo `cfg`, §12). Evento 11 se a hora era inválida ou mudou mais de 60 s | `ok` + `st` |
| `cfg?` | — | pede a configuração | `cfg` |
| `cfg` | `c` (configuração §9) | valida, corrige limites, grava e aplica (evento 12) | `ok` + `cfg` (já corrigida) + `st`, ou `err` |
| `man` | `s` (0–3), `on` (0/1), `ate` (epoch) | manual da saída `s` até `ate`; `ate = 0` cancela o manual (volta ao programa). `on = 1` também tira o bloqueio | `ok` + `st` |
| `pausa` | `s` (0–3, ou -1 = todas), `ate` (epoch; 0 = cancela) | pausa (evento 13 com `v` = horas) ou cancela (evento 14). Pausar cancela o manual | `ok` + `st` |
| `lib` | `s` | tira o bloqueio (evento 24) | `ok` + `st` |
| `zero` | — | zera os sensores (§6.1). Se alguma saída estiver ligada: `err` com `m` = "Desligue todas as saídas antes de zerar" | `ok` (evento 30) |
| `log?` | `de` (epoch, opcional) | pede os eventos com `ep >= de` (ou todos) | uma ou mais `log` |
| `reiniciar` | — | responde `ok` e reinicia o ESP32 ~500 ms depois | `ok` |

Comando desconhecido ou campo errado → `{"t":"err","r":"<t>","m":"<mensagem em português>"}`.
Linha que não é JSON, ou sem `t` → `{"t":"err","r":"","m":"…"}`; o app trata `r` vazio como resposta ao pedido pendente mais antigo.

### 8.2 ESP32 → app

**`oi`**
```json
{"t":"oi","fw":"1.0.0","id":"1A2B","nome":"Rega-1A2B","mtu":517,"pin":0,"hv":1,"rtc":1,"ep":1761000000}
```
`pin` = 1 se precisa de PIN · `hv` = hora válida · `rtc` = DS3231 encontrado.

**`st`** — a cada 1 s enquanto conectado (e logo depois de cada comando que muda algo)
```json
{"t":"st","ep":1761000000,"hv":1,"up":3600,"rtc":1,
 "s":[{"on":1,"mo":0,"ma":0,"pa":0,"b":0,"hj":1200,"pk":1.234},
      {"on":0,"mo":0,"ma":0,"pa":0,"b":0,"hj":0,"pk":-1},
      {"on":1,"mo":1,"ma":1761003600,"pa":0,"b":0,"hj":5400,"pk":-1},
      {"on":0,"mo":0,"ma":0,"pa":0,"b":0,"hj":0,"pk":-1}],
 "i":[0.000,1.870]}
```
- `on` = estado atual (válvula: o último pulso mandado) · `mo`/`ma` = manual · `pa` = pausa até · `b` = bloqueada · `hj` = segundos ligada hoje · `pk` = pico do último pulso em A (só válvulas com sensor `sa = -2`; `-1` = sem medida).
- `i` = corrente de cada sensor; `null` se o sensor está desabilitado. `up` = segundos desde que ligou.

**`i`** — a cada 250 ms enquanto conectado
```json
{"t":"i","i":[0.000,1.870]}
```

**`ev`** — na hora que um evento acontece
```json
{"t":"ev","e":[1761000000,0,1,0,0]}
```

**`log`** — resposta de `log?`, em pedaços de até 20 eventos; o último tem `fim = 1`
```json
{"t":"log","l":[[1761000000,0,1,0,0],[1761001200,0,2,0,0]],"fim":1}
```

**`cfg`** — `{"t":"cfg","c":{…}}` (§9)

**`ok`** — `{"t":"ok","r":"man"}` · **`err`** — `{"t":"err","r":"cfg","m":"…"}` · **`auth`** — `{"t":"auth","ok":1}`

### 8.3 Eventos — `[ep, s, c, o, v]`
- `ep` = quando (epoch). Eventos de antes da hora válida guardam também o tempo desde o boot; quando a hora é acertada, o firmware corrige o `ep` deles. Se ainda não tem hora: `ep = 0`.
- `s` = saída (0–3) ou `-1` = sistema. `o` = origem (tabela de §5; 4 = início, 5 = botão). `v` = valor (A, horas, segundos…) ou 0.
- O firmware guarda os **últimos 200** em memória (perde ao desligar). O app guarda o que recebe.

| `c` | evento | `v` |
|---|---|---|
| 1 | saída ligou / válvula abriu | pico do pulso (A) nas válvulas com sensor, senão 0 |
| 2 | saída desligou / válvula fechou | idem |
| 10 | controlador ligou (boot) | 0 |
| 11 | hora acertada pelo app | diferença em s (nova − antiga; 0 se antes era inválida) |
| 12 | configuração salva | 0 |
| 13 | pausa | horas |
| 14 | pausa cancelada | 0 |
| 20 | alarme: pulso sem corrente | pico (A) |
| 21 | alarme: ligada sem corrente | corrente (A) |
| 22 | alarme: corrente alta | corrente (A) |
| 23 | bloqueada por corrente alta | corrente (A) |
| 24 | bloqueio retirado | 0 |
| 30 | sensores zerados | 0 |

---

## 9. Configuração (`cfg`)

```json
{
 "v":1,
 "nome":"Rega-1A2B",
 "tz":-180,
 "pms":80,
 "f2":1,
 "temPin":0,
 "s":[
  {"n":"Válvula 1","en":1,"inv":0,"r":[{"k":"f","h":360,"d":20,"w":42,"en":1}]},
  {"n":"Válvula 2","en":1,"inv":0,"r":[]},
  {"n":"Hidroponia","en":1,"inv":0,"r":[
     {"k":"c","a":360,"b":1140,"on":15,"off":15,"w":127,"en":1},
     {"k":"c","a":1140,"b":360,"on":15,"off":45,"w":127,"en":1}]},
  {"n":"Relé 2","en":0,"inv":0,"r":[]}
 ],
 "sen":[
  {"n":"Válvulas","en":0,"tp":"dc","mva":185,"div":0.667,"aj":1,"sa":-2,"min":0.1,"max":0,"corta":0},
  {"n":"Bomba","en":0,"tp":"ac","mva":33.3,"div":1,"aj":1,"sa":2,"min":0.1,"max":0,"corta":0}
 ]
}
```

| campo | limites | padrão |
|---|---|---|
| `nome` | 1–20 bytes UTF-8 | `Rega-XXXX` |
| `tz` | −720 a 840 | −180 |
| `pms` | 10–1000 ms | 80 |
| `f2` | 0/1 | 1 |
| `s` | sempre 4 saídas; se vier menos, as que faltam ficam como estavam | |
| `s[].n` | até 24 bytes | Válvula 1, Válvula 2, Hidroponia, Relé 2 |
| `s[].en` | 0/1 | 1, 1, 1, 0 |
| `s[].inv` | 0/1 (válvula: troca a polaridade; relé: aciona em nível baixo) | 0 |
| `s[].r` | até 8 regras (§4); valores fora do limite são cortados para o limite; regra com `k` desconhecido é descartada | vazio (nada liga sozinho) |
| `sen` | sempre 2 | |
| `sen[].tp` | `"dc"` ou `"ac"` | dc, ac |
| `sen[].mva` | 1–2000 mV/A | 185, 33.3 |
| `sen[].div` | 0,05–1 | 0.667, 1 |
| `sen[].aj` | 0,5–2 | 1 |
| `sen[].sa` | −2 a 3 | −2, 2 |
| `sen[].min`, `sen[].max` | 0–100 A (0 = sem limite) | 0.1 / 0 |
| `sen[].corta` | 0/1 | 0 |
| `pin` | **só na escrita**: texto de 0–8 dígitos. Se vier, troca o PIN (vazio = sem PIN). Se não vier, mantém | sem PIN |
| `temPin` | **só na leitura**: 1 se tem PIN | |

- Gravada no NVS (`Preferences`, espaço `rega`, chave `cfg`, texto JSON ≤ 4000 bytes). Pausas e bloqueios na chave `est`.
- Primeira vez (NVS vazio) = padrões acima.

---

## 10. Teste nativo do firmware (sem placa)

A lógica do firmware fica em `firmware/ControladorRega/nucleo.h` (C++17 puro + ArduinoJson, **sem** cabeçalhos do Arduino).
O `.ino` só liga o núcleo ao hardware (pinos, ADC, BLE, NVS, DS3231, LED, botão).
`testes/nativo/` compila o mesmo núcleo no PC (`g++`) com um hardware de mentira:

- **stdin**: linhas JSON do app (como chegariam pelo RX) **ou** linhas de controle começando com `#`:
  - `#avanca <segundos>` — avança o relógio simulado (rodando o laço como se o tempo passasse).
  - `#corrente <sensor> <A>` — corrente simulada que o sensor passa a ler (AC: RMS; DC: valor). Sensor com `sa = -2` (pulso das válvulas) só lê essa corrente **durante** os pulsos; fora deles lê 0 (como no aparelho, onde a ponte H só puxa corrente no pulso).
  - `#reinicia` — simula reinício (mantém o que estava "gravado" no NVS simulado).
  - `#hora <ep>` — põe o relógio do sistema nesse epoch (0 = sem hora).
  - `#pinos` — imprime em stderr o estado dos pinos e os pulsos feitos.
- **stdout**: as linhas JSON que o ESP32 mandaria pelo TX (inteiras, sem cortar).
- **stderr**: registro de depuração.
- O processo começa "ligando" (boot) com relógio `#hora` = 1792584000 (21/10/2026 12:00 UTC) a não ser que receba `--sem-hora`.

## 11. Web Bluetooth de mentira (testes do app)

`testes/ble-falso.js` é injetado antes do app (Playwright `addInitScript`) e cria `navigator.bluetooth` falso:
- `requestDevice()` / `getDevices()` devolvem um aparelho com `gatt.connect()`, serviço e as 2 características.
- Escritas no RX viram texto e vão para `window.__bleBackend.send(texto)`.
- O backend entrega linhas com `window.__bleEntrega(linha)`; o falso corta em pedaços de `window.__bleMtu - 3` bytes (padrão MTU 23) e dispara `characteristicvaluechanged` no TX.
- Backend padrão = um ESP32 simulado simples em JS (para mexer no app sem placa). Nos testes de ponta a ponta o Playwright troca o backend pelo **núcleo nativo** (§10) via `exposeFunction`.

## 12. Regras do app (o que cada botão manda)

- **Abrir/Ligar por N min** → `man` com `on = 1`, `ate = agora + N*60`.
- **Fechar/Desligar** → se o programa diz ligado agora: `man` com `on = 0` e `ate = min(proximaMudanca(...).ep, agora + 24 h)` (se o programa nunca muda, 24 h); senão `man` com `ate = 0` (volta ao programa, que já está desligado).
- **Voltar ao programa** → `man` com `ate = 0`.
- **Pausar a rega (chuva)** → `pausa` para `s = 0` e para `s = 1` (dois comandos; nunca `s = -1`, que pararia também a hidroponia). Não encurta uma pausa mais longa que já existe: a válvula que já está pausada além do novo `ate` fica como está (e o aviso diz isso). O botão vira "Cancelar pausa da rega" só quando **todas** as válvulas habilitadas estão pausadas.
- As contas de "próxima mudança" usam o `tz` **do controlador** (da configuração), não o fuso do celular.
- **Hora**: a cada conexão o app manda `hora` só com `ep` (sem `tz`). Se o relógio do celular estiver antes de `1700000000`, não manda e avisa. O fuso do controlador muda só em Ajustes → "Fuso horário do controlador" (vai no `cfg`); o app avisa quando o fuso do celular é diferente.
