# Batalha dos Blocos — TikTok LIVE

Jogo automático em formato vertical 9:16, com arena renderizada em PixiJS, frontend React/Vite e servidor oficial de partida Node.js + Socket.IO + PostgreSQL, integrado à TikTok LIVE.

## Executar localmente

Requer Node.js 20.19 ou superior.

```bash
npm install
npm run dev
```

- Overlay: http://localhost:5173/overlay
- Painel administrativo: http://localhost:5173/admin
- Saúde do servidor: http://localhost:3001/health

O jogo fica **aguardando a LIVE**: o placar só muda com eventos reais (e o relógio da rodada só começa no primeiro evento). O gerador automático de blocos vem desligado e as simulações do painel ficam desativadas em produção (`ENABLE_TEST_EVENTS`). Em desenvolvimento, sem `ADMIN_TOKEN`, o servidor gera um token temporário e o imprime uma única vez no terminal; informe-o em `/admin`.

### Testar os eventos visuais

1. Mantenha `/overlay` aberto em uma janela.
2. Abra `/admin` em outra janela.
3. Vá até **Testar eventos visuais**.
4. Use `LIKE`, `SEGUIR` ou qualquer um dos seis presentes de cada equipe.

Cada comando adiciona a pontuação indicada, faz blocos finos atravessarem a tela desde o topo, destaca o item lateral e mostra um popup no overlay. A torre cresce a cada pouso da rajada. Os testes +1, +5 e +10 exibem respectivamente 1, 5 e 10 quedas; valores altos usam rajadas progressivamente agrupadas para evitar excesso de sprites.

## Backend TikTok LIVE

O servidor é a **fonte oficial** do placar, do tempo e das rodadas; o overlay apenas representa o estado recebido.

```text
TikTok LIVE ──► TikTokLiveService ──► LivePipeline ──► GameService ──► Socket.IO ──► /overlay
 (conector)      conexão/backoff       giftId, combos,   transação +     snapshot +      (torres)
                                       seguidores,       fila única      incrementos
                                       idempotência      + PostgreSQL
/admin ──► REST autenticado (/api/admin) + namespace Socket.IO /admin (status em tempo real)
```

| Arquivo | Papel |
|---|---|
| `server/game-engine.ts` | Estado oficial: rodada, relógio, vitória, empate, gerador automático. `plan()/commit()` separam cálculo e aplicação. |
| `server/game-service.ts` | Serializa todas as mudanças, grava evento + placar na **mesma transação** e só então aplica/notifica. |
| `server/live-pipeline.ts` | Regras de like, follow, presentes e combos (fila FIFO única). |
| `server/tiktok/live-service.ts` | Conexão real, estados, backoff, limite de tentativas, catálogo de presentes. |
| `server/tiktok/normalize.ts` | Converte payloads do conector (protobuf v3 e legado) em eventos normalizados. |
| `server/gift-registry.ts`, `gift-slots.ts` | Os 12 presentes visuais e seu mapeamento por `giftId`. |
| `server/store/` | Contrato `Store`, `PgStore` (PostgreSQL, migrações) e `MemoryStore` (desenvolvimento/testes). |
| `server/app.ts`, `index.ts`, `auth.ts`, `config.ts` | HTTP, Socket.IO, autenticação, CORS, rate limit, ciclo de vida. |

### Regras de pontuação

- **Curtida** (`like`): `+count` ao Lula, onde `count` é a quantidade *incremental* da mensagem. O total da sala nunca é somado. Teto por mensagem: `MAX_LIKES_PER_EVENT`.
- **Seguir** (`follow`, ou `social` com evidência explícita de follow): `+1` ao Bolsonaro, uma vez por usuário **por sessão LIVE** (sala). `FOLLOW` e `SOCIAL` da mesma pessoa usam a mesma chave. Entrar na sala e compartilhar **não** pontuam. Sem ID de usuário no evento, nada é pontuado (registrado como limitação).
- **Presentes**: pelo `giftId` real, nunca por nome. Cada um dos 12 slots tem `blocks` (padrão 5/10/30/100/500/1000) e pode ser ativado/desativado. Presente desconhecido ou desativado é registrado e **não pontua**.
- **Combos**: chave `sessão:usuário:giftId:groupId`. Só o incremento do `repeatCount` ainda não contabilizado vale ponto (5 rosas = 25, não 5+10+15+20+25). O estado do combo é persistido, então reconexões e reentregas não duplicam. Sem `groupId` ou usuário confiáveis, só a mensagem de fechamento (`repeatEnd`) conta.
- **Fases**: durante pausa ou tela de resultado os eventos são registrados como ignorados (motivo gravado). A rodada termina uma única vez; o excedente sobre a meta é descartado.
- **Origem**: cada evento carrega `origin` = `real` (TikTok), `auto` (gerador) ou `test` (simulação). Estatísticas e listas ficam separadas; testes aparecem como TESTE.

### Contrato com o overlay (Socket.IO público, somente leitura)

- `state` — snapshot completo (`seq`, `roundId`, placar, config, fase). Enviado ao conectar, a cada mudança e a cada segundo.
- `increment` — delta que dispara a animação: `id`, `roundId`, `seq`, `team`, `amount`, `total`, `opponentTotal`, `origin`, `kind`, `giftId` (ícone visual), `giftName`, `viewerName`, `count`, `at`.
- `roundStarted` / `roundEnded` — snapshots.
- Cliente → servidor: apenas `sync` (pede snapshot). O overlay descarta snapshots antigos (`seq`), incrementos repetidos e, ao detectar lacuna, pede novo snapshot. Nenhum evento do cliente altera o jogo.

### Sons e bordões

- **Biblioteca:**
  - Upload de MP3, WAV e OGG, validados pelo conteúdo, não pela extensão.
  - Metadados no PostgreSQL (`audio_clips`); bytes no PostgreSQL (`audio_blobs`) ou em volume (`AUDIO_STORAGE_DIR`).
- **Decisão no servidor (`server/audio/audio-service.ts`):** gatilhos por presente (12) e por evento (11), cooldowns, prioridades, bordões aleatórios por intervalo e diagnóstico.
- **Reprodução no overlay (`src/game/audio-manager.ts`):** fila com prioridade, canal de voz exclusivo, limite de simultâneos, intervalo mínimo entre bordões, pré-carga, descarte de sons vencidos e confirmação ao servidor.
- **Rotas públicas:**
  - `GET /audio/:id`: somente áudios ativos, somente leitura.
  - Socket `audio:manifest`, `audio:play`, `audio:stop` (servidor → overlay) e `audio:report` (telemetria validada, sem efeito no jogo).
- **Rotas administrativas** (`Authorization: Bearer`):
  - `GET/POST /api/admin/audio` (POST com o arquivo no corpo e `name`, `category`, `team`, `volume` na query).
  - `PUT/DELETE /api/admin/audio/:id`, `GET/PUT /api/admin/audio/:id/file`.
  - `PUT /api/admin/audio/config`.
  - `POST /api/admin/audio/play | stop | trigger | random`.
- **Diagnóstico:** `/overlay?audioDebug=1` e `/audio-diagnostico`. Configuração no LIVE Studio: [docs/OPERACAO-LIVE.md](docs/OPERACAO-LIVE.md), Parte 4.

### Variáveis de ambiente

Veja `.env.example` (todas documentadas). Obrigatórias em produção: `ADMIN_TOKEN` e `DATABASE_URL`. `TIKTOK_USERNAME` define o canal; pode ser trocado no painel e fica persistido.

### Iniciar localmente

```bash
npm install
cp .env.example .env            # opcional; exporte as variáveis ou use um gerenciador de .env
ADMIN_TOKEN=um-token-longo-e-aleatorio TIKTOK_USERNAME=seu_canal npm run dev
```

Sem `DATABASE_URL` o servidor usa memória (o placar não sobrevive a reinício). Com PostgreSQL:
`DATABASE_URL=postgres://user:senha@localhost:5432/blocos npm run dev`. As migrações rodam sozinhas.

### Publicar no Railway

> Passo a passo completo, validação pós-deploy e checklist da LIVE de teste: **[docs/OPERACAO-LIVE.md](docs/OPERACAO-LIVE.md)**.

1. Crie um projeto a partir deste repositório (o `railway.json` já define build, `preDeployCommand` de migração, start e `/health`). `npm run migrate` aplica as migrações manualmente.
2. Adicione o plugin **PostgreSQL** ao projeto.
3. No serviço, defina as variáveis: `NODE_ENV=production`, `ADMIN_TOKEN` (aleatório e longo), `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `TIKTOK_USERNAME` e, se tiver, `EULER_SIGN_API_KEY`.
4. Deixe **1 réplica** (já fixado em `railway.json`). Uma trava consultiva no PostgreSQL impede que uma segunda instância consuma a LIVE ou rode rodadas: ela fica em *standby* até a líder cair. Durante um deploy com sobreposição, a nova instância assume sozinha quando a antiga encerra.
5. Gere o domínio público (HTTPS automático). Use `https://SEU-DOMINIO/overlay` como **Fonte de navegador** no TikTok LIVE Studio (1080×1920) e `https://SEU-DOMINIO/admin` para operar.

### Descobrir e mapear os 12 giftIds

1. No `/admin`, informe o usuário e clique **CONECTAR**. O painel só mostra **CONECTADO** depois da confirmação do conector.
2. Clique **ATUALIZAR PRESENTES** (usa `fetchAvailableGifts`). A lista “Presentes identificados” mostra `giftId`, nome, imagem e moedas reais.
3. Presentes enviados durante a LIVE e ainda não mapeados também entram na lista (sem pontuar).
4. Em cada um dos 12 cartões, escolha/digite o `giftId` e clique **ASSOCIAR**. Um `giftId` só pode apontar para um slot. IDs que ainda não foram vistos exigem confirmação manual implícita (campo digitado) e ficam marcados como `manual`.
5. Ajuste os **Blocos** e o estado **Ativo** se quiser. Use os botões de teste para validar.

### Privacidade

Identificadores de espectadores nunca são gravados em claro: apenas um HMAC-SHA256 truncado, usado para deduplicação. Apelidos aparecem só no feed em memória do painel. Eventos, combos e seguidores são apagados após `RETENTION_DAYS` (padrão 30). Cookies, tokens e URLs assinadas são redigidos dos logs.

### Limitações conhecidas

- A integração com `tiktok-live-connector` (API não oficial) foi verificada contra os tipos e o código da versão 2.5.0 e com eventos sintéticos; **não foi exercitada com uma LIVE real**. Veja a lista de pendências abaixo.
- O conector usa um serviço de assinatura de terceiros (Euler Stream); sem `EULER_SIGN_API_KEY` há limites de uso.
- O TikTok pode não enviar todas as curtidas em lives grandes (documentado pelo conector).

## Produção

```bash
npm run build
NODE_ENV=production ADMIN_TOKEN=... DATABASE_URL=postgres://... npm start
```

Em produção, o servidor Express entrega a pasta `dist` e mantém o Socket.IO na mesma origem. O arquivo `railway.json` já contém o build, o start e o healthcheck necessários para um serviço Railway.

## Estrutura

```text
server/
  game-engine.ts       Motor autoritativo de rodadas infinitas
  index.ts             Express, Socket.IO e entrega de produção
src/
  components/          HUD reutilizável
  game/
    GameStage.ts       Composição PixiJS e coordenação das duas torres
    TowerController.ts Fila, queda, impacto e assentamento de uma torre (uma instância por equipe)
    tower-layout.ts    Layout determinístico: posição das placas em função da pontuação
    tower-queue.ts     Fila FIFO independente, planejamento das rajadas e agrupamento de peças
    block-visuals.ts   Conversão de incrementos em rajadas visuais limitadas
    audio.ts           Sintetizador modular de efeitos Web Audio
    socket.ts          Cliente Socket.IO tipado
    tiktok-adapter.ts  Contrato para integração futura (não conectado)
    gifts.ts           Catálogo e valores equivalentes das equipes
    types.ts           Tipos compartilhados
    useGame.ts         Sincronização React/Socket.IO
  pages/
    Overlay.tsx        Tela pública 9:16 sem controles administrativos
    Admin.tsx          Central de controle separada
public/assets/         Fotos, recortes, atlas de presentes e créditos
```

## Mecânica automática

- Meta inicial de 2.000 blocos.
- Rodadas de até 5 minutos (configurável).
- Resultado exibido por 10 segundos e reinício automático.
- Mesma distribuição aleatória e mesmas regras para ambas as equipes.
- Cada equipe possui fila FIFO própria e no máximo uma placa em movimento; a placa nasce ~260px acima do topo, cai, bate, quica e fica assentada.
- A posição das placas é uma função pura da pontuação (`tower-layout.ts`): cada ponto inicial sobe ~14px, o ganho por ponto diminui de forma logarítmica e a torre alcança o limite superior exatamente na meta. Poucas dezenas de placas ficam sempre vivas (~130 no máximo); recarregar o overlay reconstrói a mesma pilha.
- A cadência da animação acelera conforme o atraso da fila e peças vizinhas são agrupadas (máx. 12 aguardando, soma de pontos preservada), então a pilha acompanha o placar mesmo com +500/+1000 ou rajadas contínuas.
- Os incrementos internos não são apresentados como presentes ou votos reais.

### Diagnóstico das torres

Causa raiz de "as torres não aparecem": o Pixi com `autoDensity` grava `style.width/height` inline no canvas (1080×1920) e isso vence qualquer regra CSS. Em qualquer overlay diferente de 1080×1920 o canvas ficava maior que o quadro e as torres (x≈350/730, y≈1712) eram desenhadas fora da área visível. `GameStage.mount` agora força `100%` no canvas.

Abra `http://localhost:5173/overlay?debugTower=1` para registrar no console cada peça enfileirada, em queda, no impacto e assentada, incluindo equipe, pontuação, coordenadas e identificador. Sem esse parâmetro, o overlay não produz logs de animação.

## Áudio

Os seis tipos de som são sintetizados no navegador, sem arquivos externos. Por regra dos navegadores, a primeira reprodução exige interação; o overlay apresenta somente um botão discreto de consentimento de áudio e o remove após a liberação.

## Imagens

As fontes, créditos e nomes dos arquivos estão documentados em `public/assets/CREDITS.md`. As fotos originais foram preservadas ao lado dos recortes transparentes usados pelo overlay.

## Testes

```bash
npm test          # unitários: motor do jogo, fila, layout e controlador das torres
npm run build
npm run test:e2e  # navegador real (Playwright): sobe o servidor com AUTOPLAY=off e valida as torres
```

O teste ponta a ponta exige o pacote `playwright` (`PLAYWRIGHT_DIR=<pasta node_modules>` se não estiver instalado no projeto) e um `npm run build` prévio. Ele grava capturas em `e2e-output/`.

`AUTOPLAY=off npm start` desliga o gerador automático de pontos: só eventos do painel admin alteram o placar.

Backend: motor de rodadas, pipeline (curtidas, seguidores, 12 presentes, combos, duplicidade, simultaneidade), serviço de conexão (estados, backoff, limite de tentativas), normalização do conector, contrato do `Store` em memória **e em PostgreSQL real** (via `embedded-postgres`, sem Docker), autenticação, CORS, rate limit, reinício do servidor e liderança.
