# Operação — deploy no Railway e LIVE de teste

> Estado: tudo abaixo foi preparado e ensaiado **localmente** (PostgreSQL real, `NODE_ENV=production`).
> O deploy no Railway **ainda não foi executado**: exige a sua conta. Siga a Parte 1.

## Parte 1 — Publicar no Railway (ações suas)

O projeto não é um repositório git. O Railway precisa do código por GitHub **ou** pelo CLI (`railway up`).

### Opção A — pelo painel + GitHub (recomendado)

1. Crie um repositório **privado** e envie o projeto (o `.gitignore` já exclui `node_modules`, `dist`, `.env`).
   ```bash
   git init && git add -A && git commit -m "Batalha dos Blocos"
   git remote add origin <url-do-seu-repo> && git push -u origin main
   ```
2. Em railway.com: **New Project → Deploy from GitHub repo** e escolha o repositório.
3. No mesmo projeto: **New → Database → Add PostgreSQL**.
4. No serviço da aplicação → **Variables**:

   | Variável | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `ADMIN_TOKEN` | texto aleatório longo (veja abaixo) |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referência ao plugin) |
   | `TIKTOK_USERNAME` | `@` do canal, sem o `@` (opcional; pode ser definido no painel) |
   | `AUTOPLAY` | `off` (remove o gerador automático por completo) ou `on` (apenas permite ligá-lo no painel; vem desligado) |
   | `ENABLE_TEST_EVENTS` | `false` (padrão em produção: só LIVE real pontua). Use `true` apenas para um teste pontual |
   | `EULER_SIGN_API_KEY` | opcional (chave do eulerstream.com) |

   Gerar o token: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
5. **Settings → Networking → Generate Domain** (HTTPS automático).
6. Confirme que há **1 réplica**. O `railway.json` já define build, `preDeployCommand` (`npm run migrate`), start, health check `/health` e `numReplicas: 1`.

### Opção B — CLI

```bash
npm i -g @railway/cli        # ou: brew install railway
railway login
railway init                 # cria o projeto
railway add --database postgres
railway up                   # envia e publica
railway domain               # gera o domínio público
```
Defina as variáveis da tabela acima em **Variables** do serviço (ou `railway variables`; confira a sintaxe com `railway variables --help`, ela varia entre versões do CLI).

### Depois do deploy — validação (preencha com resultados reais)

| Verificação | Como | Resultado |
|---|---|---|
| Health | `curl https://SEU-DOMINIO/health` → `{"ok":true,"role":"leader","store":"postgres"}` | |
| Overlay | abrir `https://SEU-DOMINIO/overlay` | |
| Painel | `https://SEU-DOMINIO/admin` + `ADMIN_TOKEN` | |
| Socket.IO | no `/admin` o indicador "SISTEMA ONLINE" fica verde; no overlay o placar sobe | |
| Modo somente LIVE | placar permanece **0 × 0**, status "AGUARDANDO LIVE", cronômetro parado em 05:00 | |
| Simulações | `/admin` mostra "Modo somente LIVE" e `POST /api/admin/test/*` devolve 403 | |
| Persistência | **Redeploy/Restart** do serviço: mapeamentos e configurações voltam iguais | |

> Para validar torres/presentes **antes** da LIVE, defina `ENABLE_TEST_EVENTS=true`, faça o teste (aparece como **TESTE**), use "Reiniciar rodada" e volte para `false`.

## Parte 2 — Identificar e mapear os 12 presentes

O mapeamento inicial (IDs informados) é aplicado **uma única vez** em banco novo, somente em slots vazios:

| Equipe | Ícone | Valor | giftId | Base da associação |
|---|---|---:|---:|---|
| Lula | Rosa vermelha | +5 | 5655 (Rose) | nome |
| Lula | Flor rosa | +10 | 8913 (Rosa) | ordem da tabela |
| Lula | Donut | +30 | 5879 (Rosquinha) | nome |
| Lula | Chapéu | +100 | 6427 (Chapéu e Bigode) | nome |
| Lula | Gênio azul | +500 | 919332 (Ney místico) | **ordem da tabela — conferir** |
| Lula | Coroa | +1000 | 1266941 (Coroa) | nome |
| Bolsonaro | Rosa branca | +5 | 8239 (Rosa branca) | nome |
| Bolsonaro | Dinossauro verde | +10 | 6560 (Mini dino) | nome |
| Bolsonaro | Capivara | +30 | 14488 (Capybara) | nome |
| Bolsonaro | Origami | +100 | 5659 (Grou de papel) | nome |
| Bolsonaro | Saxofone | +500 | 282718 (Clarinete do groove) | **ordem da tabela — conferir** |
| Bolsonaro | Ilha com coqueiro | +1000 | 5794 (Coqueiro) | nome |

Fora dos 12 slots (conhecidos, **não pontuam**): Heart Me 7934, Palmas 231956, Luvas de boxe 6007, Corgi 6267, Dança do Cacto 58236, Pistola de dinheiro 7168, Você é demais 9948. **Boa noite**: sem ID — pendente, não inventado.

Ao conectar à LIVE, clique **ATUALIZAR PRESENTES**: nome, imagem e **moedas** reais do TikTok aparecem em cada cartão. Se algum nome/valor não bater com o ícone, troque o `giftId` no cartão (ou vincule pela lista "sem associação").

Para um presente que ainda não está na lista: peça **uma unidade** na LIVE → ele aparece em "sem associação" (e em "Eventos reais descartados → presente sem mapeamento") → vincule a um slot pelo seletor.

## Parte 3 — Checklist da transmissão de teste

Pré-requisitos: deploy validado (Parte 1), `TIKTOK_USERNAME` correto, overlay aberto no LIVE Studio como **fonte de navegador 1080×1920** e `/admin` aberto em outra aba.

1. [ ] Com a LIVE **no ar**, `/admin` → **CONECTAR**. Esperado: **CONECTADO**, "Sala LIVE conectada" preenchida, "Conta TikTok" = seu canal. Se aparecer *LIVE NÃO INICIADA* ou *ERRO*, a LIVE ainda não está no ar ou o canal/assinatura falhou — leia a mensagem.
2. [ ] **ATUALIZAR PRESENTES** → a lista "Presentes identificados" é preenchida.
3. [ ] Receber **uma curtida** (de outra conta). Esperado: "Eventos recebidos → curtidas" +1, Lula +N, torre vermelha cresce, evento real no feed.
4. [ ] Receber **um novo seguidor** (conta que ainda não segue). Esperado: Bolsonaro +1. Seguir/deixar de seguir/seguir de novo na mesma LIVE conta **uma vez**.
5. [ ] Receber **um presente real** (você decide e autoriza o gasto): ele aparece com `giftId`/nome/moedas. Se não estiver mapeado, vincule.
6. [ ] Conferir a pontuação: valor do cartão × equipe correta (rosa vermelha +5 Lula etc.).
7. [ ] Conferir a **queda dos blocos** na torre da equipe certa.
8. [ ] **Combo** (se viável): enviar 3–5 do mesmo presente em sequência → pontos = quantidade × valor (nada de soma acumulada). Confira "descartados por motivo" (combo já contabilizado é esperado).
9. [ ] **Áudio**: clicar "TOQUE PARA ATIVAR O SOM" no overlay (uma vez) e confirmar que o som sai **na transmissão** (fonte de navegador precisa de "Controlar áudio via OBS/LIVE Studio" habilitado).
10. [ ] **Próxima rodada**: a rodada só começa a contar tempo no **primeiro evento real**. Deixe uma rodada terminar (meta 2.000 ou 300 s) → tela de resultado por 10 s → nova rodada volta a "aguardar" e inicia no próximo evento.
11. [ ] Derrubar/reiniciar o serviço no Railway durante a LIVE: o placar volta, a conexão TikTok retoma sozinha.

**Não** execute ações pagas sem decisão sua. Os botões de teste do painel não gastam nada e aparecem como TESTE.

## Parte 4 — Sons e bordões

### Como funciona
- Você envia os arquivos no `/admin` → **Sons e bordões** (MP3/WAV/OGG, até 5 MB e 2 min). Eles ficam guardados no **PostgreSQL** e sobrevivem a deploys e reinícios. Para guardar em disco, monte um **Volume** no Railway e defina `AUDIO_STORAGE_DIR` com o caminho do volume.
- O servidor **não toca som**: ele decide quando tocar e envia a ordem ao **overlay**, que reproduz. Por isso o áudio só sai na LIVE se o **overlay aberto no LIVE Studio** estiver com o áudio ativo.
- O painel não gera nem presume áudios dos políticos: tudo vem dos arquivos que você enviar.

### Configurar no TikTok LIVE Studio
1. **Adicionar fonte → Link/Navegador (Browser source)** com `https://SEU-DOMINIO/overlay`, tamanho **1080 × 1920**.
2. Ative a opção de **capturar/controlar o áudio da fonte** (o nome varia por versão: "Controlar áudio via LIVE Studio", "Áudio da página" ou similar) e deixe o volume dessa fonte audível no **mixer** do LIVE Studio.
3. Fontes de navegador costumam permitir autoplay. Se o overlay mostrar **"TOQUE PARA ATIVAR O SOM"**, use **Interagir** com a fonte e clique uma vez no botão.
4. No `/admin` → **Diagnóstico do áudio no overlay**, a linha do overlay deve mostrar **Mecanismo: ATIVO** e **Arquivos: N/N**. Se mostrar **BLOQUEADO (autoplay)**, repita o passo 3.
5. Clique **REPRODUZIR NA LIVE** em um som da mesa: a ordem deve aparecer como **tocou**. Isso confirma que o navegador do overlay reproduziu.
6. **Confirme ouvindo a transmissão**: grave alguns segundos, ou acompanhe por outra conta/dispositivo. O painel não tem como saber se o LIVE Studio capturou o áudio. Só considere o áudio validado depois desse teste.

Ferramentas de diagnóstico:
- `https://SEU-DOMINIO/overlay?audioDebug=1`: mostra o painel de áudio dentro do overlay. Use só para teste, não na transmissão.
- `https://SEU-DOMINIO/audio-diagnostico`: apenas o mecanismo de áudio, sem o jogo, recebendo as mesmas ordens.

### Preparar os sons da partida
1. Envie os arquivos e escolha categoria (**Bordão/Comemoração** tocam um de cada vez; **Efeito/Vinheta** podem sobrepor) e equipe.
2. Em **Sons dos 12 presentes**, marque um ou mais áudios por presente e escolha **Aleatório** ou **Sequencial**.
3. Em **Eventos automáticos**, configure like, seguidor, combo, queda de blocos, início, últimos 10 s, virada, vitórias e empate. O **intervalo mínimo** evita um som a cada curtida (padrão do like: 5 s).
4. **Bordões aleatórios**: ative, defina o intervalo e escolha os áudios. Eles só tocam com a rodada em andamento.
5. **Mesa de sons**: botões para tocar qualquer áudio na LIVE, **PARAR ÁUDIO** e **Volume geral**.
6. Use **TESTAR NA LIVE** em cada gatilho: dispara o som sem alterar o placar.
7. **Música de fundo**: envie faixas com a categoria **Música de fundo** (até 20 MB e 15 min cada), monte a playlist e clique **LIGAR MÚSICA**. Ajuste o volume da música e o volume "durante bordões": a música abaixa sozinha quando toca um bordão ou comemoração. **PRÓXIMA FAIXA** pula a música. Marque "Só durante a rodada" se ela não deve tocar enquanto o jogo aguarda a LIVE. **PARAR ÁUDIO** interrompe bordões e efeitos, mas não a música, que tem seu próprio liga/desliga.

> Use apenas músicas que você tenha direito de usar na transmissão: o TikTok pode silenciar ou derrubar LIVEs com música protegida.

### Checklist de áudio na LIVE de teste
- [ ] Overlay no LIVE Studio com mecanismo **ATIVO** no diagnóstico
- [ ] Som manual ouvido **na transmissão**
- [ ] Bordão de um presente real (ou testado pelo gatilho) ouvido na transmissão
- [ ] Rajada de curtidas: no máximo 1 som de like a cada intervalo configurado
- [ ] Comemoração de vitória interrompe bordões comuns
- [ ] PARAR ÁUDIO silencia imediatamente
- [ ] Volume geral ajustado em relação ao microfone

## Parte 5 — Em caso de problema

| Sintoma | Causa provável / ação |
|---|---|
| ERRO "Não foi possível obter a sala da LIVE" | usuário digitado errado, LIVE ainda não iniciada ou serviço de assinatura limitado → confira o `@`, aguarde, configure `EULER_SIGN_API_KEY` |
| Presentes chegam mas não pontuam | veja "Eventos reais descartados": `presente sem mapeamento` → vincule; `presente desativado` → ative |
| Curtidas não aparecem | o TikTok nem sempre envia curtidas em salas grandes (limitação do conector) |
| Overlay mostra 0×0 sem mudar | o serviço está em *standby* (outra instância é líder) ou o domínio não alcança o servidor — `/health` mostra `role` |
| Painel mostra "tocou", mas a LIVE não tem som | captura de áudio da fonte desligada ou volume zerado no mixer do LIVE Studio (Parte 4) |
| Diagnóstico: BLOQUEADO (autoplay) | interaja com a fonte e clique em "TOQUE PARA ATIVAR O SOM" |
| Nenhum overlay no diagnóstico | o overlay não está aberto ou não alcança o servidor |
| Pontos duplicados suspeitos | compare "Eventos reais" × feed; envie o print do painel — todo evento tem motivo registrado |
