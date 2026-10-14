import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { GiftIcon } from '../components/GiftIcon';
import { AdminAudio } from './AdminAudio';
import { GIFTS } from '../game/gifts';
import { TEAM_LABELS, type GameConfig, type Team } from '../game/types';
import {
  ApiError,
  api,
  loadToken,
  openAdminSocket,
  saveToken,
  type ConnectionState,
  type Overview,
  type IgnoredReasonRow,
  type ProcessedSummary,
  type SlotView,
  type StatRow,
} from './admin-api';

const BLOCK_TEST_AMOUNTS = [1, 5, 10, 30, 100, 500, 1000] as const;
const TEAMS: Team[] = ['lula', 'bolsonaro'];

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  CONNECTED: 'CONECTADO',
  CONNECTING: 'CONECTANDO',
  DISCONNECTED: 'DESCONECTADO',
  LIVE_NOT_STARTED: 'LIVE NÃO INICIADA',
  ERROR: 'ERRO',
};

const REASON_LABEL: Record<string, string> = {
  unmapped_gift: 'presente sem mapeamento',
  inactive_gift: 'presente desativado',
  invalid_gift_id: 'giftId inválido',
  combo_already_counted: 'combo já contabilizado',
  combo_end_already_counted: 'fechamento do combo já contabilizado',
  combo_intermediate_unreliable: 'combo sem identificação confiável',
  follower_already_counted: 'seguidor já contado',
  follow_without_user_id: 'seguir sem identificador',
  result_phase: 'tela de resultado',
  paused: 'partida pausada',
  recent_cache: 'duplicado',
  comment_rate_limited: 'comentário repetido rápido demais',
  accumulated: 'acumulando curtidas',
  already_recorded: 'duplicado',
};

export function Admin() {
  const [token, setToken] = useState(loadToken);
  const [authError, setAuthError] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<GameConfig | null>(null);
  const [username, setUsername] = useState('');
  const [online, setOnline] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const logout = useCallback(() => {
    saveToken('');
    setToken('');
    setOverview(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api<Overview>(token, '/overview');
      setOverview(data);
      setOnline(true);
      setAuthError('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthError('Token inválido.');
        logout();
      } else {
        setOnline(false);
      }
    }
  }, [token, logout]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 250);
  }, [refresh]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    const socket = openAdminSocket(token);
    socketRef.current = socket;
    socket.on('connectionStatus', scheduleRefresh);
    socket.on('processed', scheduleRefresh);
    socket.on('unknownGift', scheduleRefresh);
    socket.on('giftsUpdated', scheduleRefresh);
    socket.on('connect_error', (error) => { if (error.message === 'unauthorized') logout(); });
    return () => {
      window.clearInterval(interval);
      socket.close();
      socketRef.current = null;
    };
  }, [token, refresh, scheduleRefresh, logout]);

  useEffect(() => {
    if (overview && !form) setForm(overview.state.config);
    if (overview && !username) setUsername(overview.connection.username ?? '');
  }, [overview, form, username]);

  const run = useCallback(async (label: string, path: string, init?: { method?: string; body?: unknown }) => {
    try {
      const result = await api<Record<string, unknown>>(token, path, init);
      setNotice(`${label}: concluído.`);
      void refresh();
      return result;
    } catch (error) {
      setNotice(`${label}: ${(error as Error).message}`);
      return null;
    }
  }, [token, refresh]);

  const submitToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('token') ?? '').trim();
    if (!value) return;
    saveToken(value);
    setToken(value);
    setAuthError('');
  };

  if (!token) {
    return (
      <main className="admin-page">
        <div className="admin-wrap admin-login">
          <p className="admin-kicker">CENTRAL DE CONTROLE</p>
          <h1>Batalha dos Blocos</h1>
          <p>Acesso restrito. Informe o token administrativo configurado no servidor (ADMIN_TOKEN).</p>
          <form onSubmit={submitToken} className="admin-login__form">
            <input name="token" type="password" autoComplete="current-password" placeholder="Token administrativo" autoFocus />
            <button className="button button--start" type="submit">ENTRAR</button>
          </form>
          {authError && <p className="admin-error" role="alert">{authError}</p>}
        </div>
      </main>
    );
  }

  if (!overview || !form) {
    return (
      <main className="admin-page">
        <div className="admin-wrap admin-login">
          <p className="admin-kicker">CENTRAL DE CONTROLE</p>
          <h1>Batalha dos Blocos</h1>
          <p>{online ? 'Carregando…' : 'Conectando ao servidor…'}</p>
          <button className="button button--reset" onClick={logout}>SAIR</button>
        </div>
      </main>
    );
  }

  const { state, connection } = overview;
  const update = <K extends keyof GameConfig>(key: K, value: GameConfig[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const progress = (team: Team) => Math.min(100, state.teams[team].score / state.config.target * 100);
  const sum = (rows: StatRow[], status = 'applied') => rows.filter((row) => row.status === status).reduce((total, row) => total + row.points, 0);
  const count = (rows: StatRow[], status: string) => rows.filter((row) => row.status === status).reduce((total, row) => total + row.events, 0);

  return (
    <main className="admin-page">
      <div className="admin-wrap">
        <header className="admin-header">
          <div>
            <p className="admin-kicker">CENTRAL DE CONTROLE</p>
            <h1>Batalha dos Blocos</h1>
            <p>Gerencie a rodada ao vivo sem exibir controles no overlay.</p>
          </div>
          <div className="admin-header__side">
            <div className={`status-pill ${online ? 'online' : ''}`}><span />{online ? 'SISTEMA ONLINE' : 'RECONECTANDO'}</div>
            <button className="button button--reset admin-logout" onClick={logout}>SAIR</button>
          </div>
        </header>

        {notice && <p className="admin-notice" role="status" onClick={() => setNotice('')}>{notice}</p>}

        <section className="admin-stats">
          <article><span>RODADA</span><strong>#{state.round}</strong></article>
          <article><span>STATUS</span><strong>{state.phase === 'playing' ? (state.startedAt === null ? 'AGUARDANDO LIVE' : 'EM JOGO') : state.phase === 'paused' ? 'PAUSADO' : 'RESULTADO'}</strong></article>
          <article><span>META</span><strong>{state.config.target.toLocaleString('pt-BR')}</strong></article>
          <article><span>PLACAR GERAL</span><strong><i className="red">{state.teams.lula.wins}</i> × <i className="green">{state.teams.bolsonaro.wins}</i></strong></article>
        </section>

        <section className="panel connection-panel">
          <div className="panel-title"><span>00</span><div><h2>Conexão TikTok LIVE</h2><p>Estado real informado pelo conector — nunca presumido</p></div></div>
          <div className="connection-row">
            <div className={`connection-state connection-state--${connection.state.toLowerCase()}`}>
              <i /><b>{CONNECTION_LABEL[connection.state]}</b>
            </div>
            <form className="connection-user" onSubmit={(event) => {
              event.preventDefault();
              void run('Usuário TikTok', '/tiktok/username', { method: 'PUT', body: { username } });
            }}>
              <label>Usuário da LIVE
                <input value={username} placeholder="@usuario" maxLength={40} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <button className="button button--reset" type="submit">SALVAR USUÁRIO</button>
            </form>
          </div>
          <div className="connection-actions">
            <button className="button button--start" onClick={() => void run('Conectar', '/tiktok/connect', { body: {} })} disabled={connection.state === 'CONNECTING' || connection.state === 'CONNECTED'}>CONECTAR</button>
            <button className="button button--pause" onClick={() => void run('Reconectar', '/tiktok/reconnect', { body: {} })}>RECONECTAR</button>
            <button className="button button--reset" onClick={() => void run('Desconectar', '/tiktok/disconnect', { body: {} })}>DESCONECTAR</button>
            <button className="button button--reset" onClick={() => void run('Atualizar presentes', '/tiktok/refresh-gifts', { body: {} })}>ATUALIZAR PRESENTES</button>
          </div>
          <dl className="connection-meta">
            <div><dt>Conta TikTok</dt><dd>{connection.username ? `@${connection.username}` : 'não configurada'}</dd></div>
            <div><dt>Sala LIVE conectada</dt><dd>{connection.roomId ?? '—'}</dd></div>
            <div><dt>Desde</dt><dd>{new Date(connection.since).toLocaleTimeString('pt-BR')}</dd></div>
            <div><dt>Tentativas</dt><dd>{connection.attempts}</dd></div>
            <div><dt>Próxima tentativa</dt><dd>{connection.nextRetryAt ? new Date(connection.nextRetryAt).toLocaleTimeString('pt-BR') : '—'}</dd></div>
            <div><dt>Último evento recebido</dt><dd>{connection.lastEventAt ? new Date(connection.lastEventAt).toLocaleTimeString('pt-BR') : '—'}{overview.lastRealEvent ? ` · ${describeEvent(overview.lastRealEvent)}` : ''}</dd></div>
            <div><dt>Eventos recebidos</dt><dd>{connection.counters.gifts} presentes · {connection.counters.likes} curtidas · {connection.counters.follows} seguidores · {connection.counters.shares} compartilhamentos · {connection.counters.comments} comentários</dd></div>
            <div><dt>Descartados (reais)</dt><dd>{overview.ignoredReal.reduce((total, row) => total + row.events, 0)}</dd></div>
          </dl>
          {connection.lastError && <p className="admin-error">{connection.lastError}</p>}
          <p className="admin-hint">O jogo continua em execução mesmo com a LIVE desconectada. Servidor: {overview.server.role === 'leader' ? 'líder' : overview.server.role} · armazenamento {overview.server.store === 'postgres' ? 'PostgreSQL' : 'em memória (volátil)'}.</p>
        </section>

        <div className="admin-grid">
          <section className="panel controls-panel">
            <div className="panel-title"><span>01</span><div><h2>Controle da rodada</h2><p>Comandos operacionais imediatos</p></div></div>
            <div className="primary-actions">
              <button className="button button--start" onClick={() => void run('Continuar', '/game/resume', { body: {} })} disabled={state.phase !== 'paused'}><span>▶</span> CONTINUAR</button>
              <button className="button button--pause" onClick={() => void run('Pausar', '/game/pause', { body: {} })} disabled={state.phase !== 'playing'}><span>Ⅱ</span> PAUSAR</button>
            </div>
            <button className="button button--reset" onClick={() => void run('Reiniciar rodada', '/game/reset', { body: {} })}><span>↻</span> REINICIAR RODADA</button>
            <a className="overlay-link" href="/overlay" target="_blank" rel="noreferrer">ABRIR OVERLAY <span>↗</span></a>
          </section>

          <section className="panel settings-panel">
            <div className="panel-title"><span>02</span><div><h2>Configuração</h2><p>Parâmetros aplicados em tempo real</p></div></div>
            <label>Meta de blocos<input type="number" min="10" max="100000" value={form.target} onChange={(e) => update('target', Number(e.target.value))} /></label>
            <label>Curtidas por bloco ({TEAM_LABELS.lula})<input type="number" min="1" max="10000" value={form.likesPerBlock} onChange={(e) => update('likesPerBlock', Number(e.target.value))} /></label>
            <label>Comentários “13”/“22” por bloco<input type="number" min="1" max="10000" value={form.commentsPerBlock} onChange={(e) => update('commentsPerBlock', Number(e.target.value))} /></label>
            <Toggle title="Comentários valem blocos" hint="Quem comenta só “13” ou “22” ajuda a equipe (1 por pessoa a cada 3 s)" value={form.commentVotes} onChange={(value) => update('commentVotes', value)} />
            <label>Duração da rodada <span>{Math.round(form.durationSeconds / 60 * 10) / 10} min</span><input type="range" min="30" max="1800" step="30" value={form.durationSeconds} onChange={(e) => update('durationSeconds', Number(e.target.value))} /></label>
            <label>Intervalo entre rodadas <span>{form.resultSeconds} s</span><input type="range" min="3" max="60" step="1" value={form.resultSeconds} onChange={(e) => update('resultSeconds', Number(e.target.value))} /></label>
            <label>Velocidade automática <span>{form.autoSpeed.toFixed(1)}×</span><input type="range" min="0.1" max="5" step="0.1" value={form.autoSpeed} onChange={(e) => update('autoSpeed', Number(e.target.value))} /></label>
            <Toggle title="Pontuação automática" hint="Gera blocos sem depender da LIVE (identificados como AUTO)" value={form.autoEnabled} onChange={(value) => update('autoEnabled', value)} />
            <Toggle title="Automático para Lula" hint="Incrementos automáticos da equipe vermelha" value={form.autoTeams.lula} onChange={(value) => update('autoTeams', { ...form.autoTeams, lula: value })} />
            <Toggle title="Automático para Bolsonaro" hint="Incrementos automáticos da equipe verde" value={form.autoTeams.bolsonaro} onChange={(value) => update('autoTeams', { ...form.autoTeams, bolsonaro: value })} />
            <Toggle title="Reinício automático" hint="Nova rodada ao fim do intervalo de resultado" value={form.autoRestart} onChange={(value) => update('autoRestart', value)} />
            <Toggle title="Efeitos sonoros" hint="Som no overlay após liberação do navegador" value={form.soundEnabled} onChange={(value) => update('soundEnabled', value)} />
            <button className="button button--save" onClick={() => void run('Configurações', '/game/config', { method: 'PUT', body: form })}>SALVAR CONFIGURAÇÕES</button>
          </section>
        </div>

        <section className="panel live-panel">
          <div className="panel-title"><span>03</span><div><h2>Estado da partida</h2><p>Dados sincronizados com todas as telas</p></div></div>
          <div className="team-live-grid">
            {TEAMS.map((team) => (
              <article className={`team-live team-live--${team}`} key={team}>
                <div><span>{team === 'lula' ? 'EQUIPE VERMELHA · LULA' : 'EQUIPE VERDE · BOLSONARO'}</span><h3>{TEAM_LABELS[team]}</h3></div>
                <strong>{state.teams[team].score.toLocaleString('pt-BR')}<small> / {state.config.target.toLocaleString('pt-BR')}</small></strong>
                {team === 'lula' && <p className="admin-hint">Curtidas acumuladas: {state.pendingLikes ?? 0} / {state.config.likesPerBlock} para o próximo bloco</p>}
                {state.config.commentVotes && <p className="admin-hint">Comentários “{TEAM_LABELS[team]}” acumulados: {state.pendingComments?.[team] ?? 0} / {state.config.commentsPerBlock}</p>}
                <div className="admin-progress"><span style={{ width: `${progress(team)}%` }} /></div>
                {overview.server.testEvents && (
                  <div className="test-actions">
                    {[5, 25, 100].map((amount) => (
                      <button key={amount} onClick={() => void run(`Teste +${amount}`, '/test/increment', { body: { team, amount } })}>+{amount}</button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        <GiftMapping token={token} overview={overview} onChanged={() => void refresh()} onNotice={setNotice} />

        {overview.server.testEvents ? (
          <section className="panel event-panel">
            <div className="panel-title"><span>05</span><div><h2>Testar eventos visuais</h2><p>Simulações aparecem como TESTE e ficam fora dos relatórios reais</p></div></div>
              <div className="event-specials">
              <button className="event-button event-button--lula" onClick={() => void run('LIKES de teste', '/test/like', { body: { count: Math.min(100, state.config.likesPerBlock) } })}><span>❤</span><b>{Math.min(100, state.config.likesPerBlock)} LIKES</b><small>{state.config.likesPerBlock} LIKES = +1 {TEAM_LABELS.lula}</small></button>
              <button className="event-button event-button--bolsonaro" onClick={() => void run('SEGUIR de teste', '/test/follow', { body: {} })}><span>♟</span><b>SEGUIR</b><small>+1 {TEAM_LABELS.bolsonaro}</small></button>
            </div>
            <div className="event-specials">
            {TEAMS.map((team) => (
              <button key={team} className={`event-button event-button--${team}`} onClick={() => void run(`${state.config.commentsPerBlock} comentários “${TEAM_LABELS[team]}”`, '/test/comment', { body: { team, count: Math.min(100, state.config.commentsPerBlock) } })}>
                <span>💬</span><b>{Math.min(100, state.config.commentsPerBlock)}× “{TEAM_LABELS[team]}”</b><small>{state.config.commentsPerBlock} COMENTÁRIOS = +1</small>
              </button>
            ))}
          </div>
          <div className="block-test-grid">
              {TEAMS.map((team) => (
                <div className={`block-test-column block-test-column--${team}`} key={team}>
                  <h3>TESTAR PILHA {TEAM_LABELS[team]}</h3>
                  <div>
                    {BLOCK_TEST_AMOUNTS.map((amount) => (
                      <button key={amount} onClick={() => void run(`+${amount} ${team}`, '/test/increment', { body: { team, amount } })} aria-label={`Adicionar ${amount} blocos para ${team}`}>
                        +{amount}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="gift-test-grid">
              {TEAMS.map((team) => (
                <div className={`gift-test-column gift-test-column--${team}`} key={team}>
                  <h3>{team === 'lula' ? 'PRESENTES LULA' : 'PRESENTES BOLSONARO'}</h3>
                  {GIFTS.map((gift) => (
                    <button key={gift.id} onClick={() => void run(`Presente ${gift.labels[team]}`, '/test/gift', { body: { slotId: `${team}:${gift.id}` } })}>
                      <GiftIcon team={team} giftId={gift.id} /><b>{gift.name}</b><small>+{gift.amount}</small>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="scenario-grid">
              <button className="button button--reset" onClick={async () => {
                const result = await run('Combo de 5 rosas (teste)', '/test/combo', { body: { slotId: 'lula:impulso', total: 5 } });
                if (result) setNotice(`Combo de 5 presentes: ${String(result.applied)} blocos aplicados (esperado ${(overview.slots.find((slot) => slot.slotId === 'lula:impulso')?.blocks ?? 5) * 5}).`);
              }}>COMBO 5× (Lula)</button>
              <button className="button button--reset" onClick={async () => {
                const result = await run('Combo com reconexão (teste)', '/test/reconnect', { body: { slotId: 'bolsonaro:super-impulso' } });
                if (result) setNotice(`Combo com reconexão: ${String(result.applied)} aplicados, esperado ${String(result.expected)} — ${result.ok ? 'SEM duplicação' : 'DIVERGÊNCIA'}.`);
              }}>COMBO + RECONEXÃO (Bolsonaro)</button>
              <button className="button button--reset" onClick={() => void run('Eventos simultâneos (teste)', '/test/burst', { body: { size: 12 } })}>12 EVENTOS SIMULTÂNEOS</button>
            </div>
          </section>
        ) : (
          <section className="panel event-panel">
            <div className="panel-title"><span>05</span><div><h2>Modo somente LIVE</h2><p>Simulações desativadas neste servidor</p></div></div>
            <p className="admin-hint">Somente curtidas, seguidores e presentes reais da LIVE alteram o placar. Para liberar os botões de teste, defina <code>ENABLE_TEST_EVENTS=true</code> no servidor.</p>
          </section>
        )}

        <section className="panel report-panel">
          <div className="panel-title"><span>06</span><div><h2>Eventos processados</h2><p>Reais (TikTok), automáticos e testes são contabilizados separadamente</p></div></div>
          <div className="report-grid">
            <ReportCard title="REAIS (TIKTOK)" tone="real" applied={sum(overview.statsReal)} events={count(overview.statsReal, 'applied')} ignored={count(overview.statsReal, 'ignored')} />
            <ReportCard title="AUTOMÁTICOS" tone="auto" applied={sum(overview.statsAuto)} events={count(overview.statsAuto, 'applied')} ignored={0} />
            <ReportCard title="TESTE" tone="test" applied={sum(overview.statsTest)} events={count(overview.statsTest, 'applied')} ignored={count(overview.statsTest, 'ignored')} />
          </div>
          <IgnoredTable rows={overview.ignoredReal} />
          <div className="report-feeds">
            <EventFeed title="Últimos eventos reais" items={overview.recentReal} />
            <EventFeed title="Últimos testes" items={overview.recentTest} />
          </div>
          {overview.comments.length > 0 && (
            <details className="report-comments">
              <summary>Comentários recentes (diagnóstico, não armazenados)</summary>
              <ul>{overview.comments.map((comment, index) => <li key={`${comment.at}-${index}`}><b>{comment.user}</b> {comment.text}</li>)}</ul>
            </details>
          )}
          {overview.mismatches.length > 0 && (
            <p className="admin-error">Divergência de metadados em {overview.mismatches.length} presente(s) mapeado(s); confira o valor em moedas.</p>
          )}
        </section>

        <AdminAudio token={token} onNotice={setNotice} />

        <footer className="admin-footer">BATALHA DOS BLOCOS • SERVIDOR OFICIAL DO PLACAR • EVENTOS REAIS E DE TESTE SEPARADOS</footer>
      </div>
    </main>
  );
}

function Toggle({ title, hint, value, onChange }: { title: string; hint: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-row">
      <div><b>{title}</b><small>{hint}</small></div>
      <button type="button" className={`toggle ${value ? 'active' : ''}`} onClick={() => onChange(!value)} aria-pressed={value}><span /></button>
    </label>
  );
}

function ReportCard({ title, tone, applied, events, ignored }: { title: string; tone: string; applied: number; events: number; ignored: number }) {
  return (
    <article className={`report-card report-card--${tone}`}>
      <span>{title}</span>
      <strong>{applied.toLocaleString('pt-BR')}<small> blocos</small></strong>
      <p>{events} eventos pontuados · {ignored} ignorados</p>
    </article>
  );
}

function EventFeed({ title, items }: { title: string; items: ProcessedSummary[] }) {
  return (
    <div className="event-feed">
      <h3>{title}</h3>
      {items.length === 0 ? <p className="admin-hint">Nenhum evento ainda.</p> : (
        <ul>
          {items.slice(0, 12).map((item, index) => (
            <li key={`${item.at}-${index}`} className={`event-feed__item event-feed__item--${item.status}`}>
              <time>{new Date(item.at).toLocaleTimeString('pt-BR')}</time>
              {item.origin === 'test' && <em>TESTE</em>}
              <b>{item.kind === 'gift' ? (item.giftName ?? `presente ${item.giftId ?? ''}`) : item.kind === 'like' ? 'curtida' : item.kind === 'comment' ? 'comentário' : 'seguidor'}</b>
              {item.status === 'applied'
                ? <span className={`team-tag team-tag--${item.team}`}>+{item.points} → {item.team ? TEAM_LABELS[item.team] : ''}</span>
                : <span className="reason">{item.status === 'duplicate' ? 'duplicado' : REASON_LABEL[item.reason ?? ''] ?? item.reason ?? item.status}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GiftMapping({ token, overview, onChanged, onNotice }: {
  token: string;
  overview: Overview;
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const unmapped = useMemo(() => overview.knownGifts.filter((gift) => !gift.slotId), [overview.knownGifts]);

  const save = async (slot: SlotView, patch: { giftId?: string | null; blocks?: number; active?: boolean; allowManual?: boolean }) => {
    try {
      await api(token, `/gifts/slots/${encodeURIComponent(slot.slotId)}`, { method: 'PUT', body: patch });
      onNotice(`${slot.label}: salvo.`);
      setDrafts((current) => { const { [slot.slotId]: _removed, ...rest } = current; return rest; });
      onChanged();
    } catch (error) {
      onNotice(`${slot.label}: ${(error as Error).message}`);
    }
  };

  return (
    <section className="panel gifts-panel">
      <div className="panel-title"><span>04</span><div><h2>Presentes do TikTok</h2><p>Associe cada um dos 12 ícones do jogo a um giftId real. A associação é sempre por giftId, nunca por nome.</p></div></div>
      <details className="gift-procedure">
        <summary>Procedimento para identificar e mapear os presentes reais</summary>
        <ol>
          <li>Conecte à LIVE e clique em <b>ATUALIZAR PRESENTES</b> para carregar nomes, imagens e moedas do TikTok.</li>
          <li>Peça a alguém para enviar <b>um</b> presente (uma unidade). Ele aparece abaixo em “sem associação” e <b>não pontua</b> enquanto não for vinculado.</li>
          <li>Confira o <b>giftId</b>, o nome e as moedas na lista e vincule ao cartão do ícone correspondente.</li>
          <li>Repita para os 12 ícones. Cartões marcados “SEM GIFT ID” ainda não pontuam.</li>
          <li>Teste com o botão do presente correspondente e depois com um envio real.</li>
        </ol>
      </details>
      <div className="gift-map-grid">
        {TEAMS.map((team) => (
          <div className={`gift-map-column gift-map-column--${team}`} key={team}>
            <h3>{team === 'lula' ? `${TEAM_LABELS.lula} (LULA) — VERMELHO` : `${TEAM_LABELS.bolsonaro} (BOLSONARO) — VERDE`}</h3>
            {overview.slots.filter((slot) => slot.team === team).map((slot) => {
              const draft = drafts[slot.slotId] ?? slot.giftId ?? '';
              const known = overview.knownGifts.find((gift) => gift.giftId === draft);
              return (
                <article className={`gift-map-card ${slot.mapped ? 'is-mapped' : ''} ${slot.active ? '' : 'is-off'}`} key={slot.slotId}>
                  <header>
                    <GiftIcon team={team} giftId={slot.visualId} />
                    <div><b>{slot.label}</b><small>{slot.visualName} · padrão +{slot.defaultBlocks}</small></div>
                    <span className={`gift-state ${slot.mapped ? 'gift-state--ok' : 'gift-state--pending'}`}>{slot.mapped ? (slot.active ? 'ATIVO' : 'INATIVO') : 'SEM GIFT ID'}</span>
                  </header>
                  <div className="gift-map-row">
                    <input
                      list="known-gifts"
                      inputMode="numeric"
                      placeholder="giftId do TikTok"
                      value={draft}
                      onChange={(event) => setDrafts((current) => ({ ...current, [slot.slotId]: event.target.value.replace(/\D/g, '') }))}
                    />
                    <button className="button button--reset" disabled={!draft || draft === slot.giftId}
                      onClick={() => void save(slot, { giftId: draft, allowManual: !known })}>
                      ASSOCIAR
                    </button>
                    {slot.giftId && <button className="button button--reset" onClick={() => void save(slot, { giftId: null })}>LIMPAR</button>}
                  </div>
                  {(slot.giftName || slot.giftImageUrl || slot.giftCoins !== null) && (
                    <p className="gift-meta">
                      {slot.giftImageUrl && <img src={slot.giftImageUrl} alt="" width={24} height={24} />}
                      {slot.giftName ?? 'Nome não informado'}{slot.giftCoins !== null ? ` · ${slot.giftCoins} moedas` : ''}
                    </p>
                  )}
                  <div className="gift-map-row">
                    <label>Blocos
                      <input type="number" min={1} max={5000} defaultValue={slot.blocks} key={`${slot.slotId}-${slot.blocks}`}
                        onBlur={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isInteger(value) && value !== slot.blocks) void save(slot, { blocks: value });
                        }} />
                    </label>
                    <Toggle title="Ativo" hint="" value={slot.active} onChange={(value) => void save(slot, { active: value })} />
                  </div>
                </article>
              );
            })}
          </div>
        ))}
      </div>
      <datalist id="known-gifts">
        {overview.knownGifts.map((gift) => <option key={gift.giftId} value={gift.giftId}>{gift.name ?? ''}</option>)}
      </datalist>
      <div className="gift-known">
        <h3>Presentes identificados ({overview.knownGifts.length}) — {unmapped.length} sem associação</h3>
        {overview.knownGifts.length === 0 ? (
          <p className="admin-hint">Nenhum presente identificado ainda. Conecte à LIVE e use “Atualizar presentes”, ou aguarde um presente real: presentes desconhecidos são registrados aqui e não pontuam.</p>
        ) : (
          <ul>
            {overview.knownGifts.slice(0, 80).map((gift) => (
              <li key={gift.giftId} className={gift.slotId ? 'is-mapped' : ''}>
                {gift.imageUrl && <img src={gift.imageUrl} alt="" width={28} height={28} loading="lazy" />}
                <code>{gift.giftId}</code>
                <b>{gift.name ?? 'sem nome'}</b>
                <small>{gift.coins !== null ? `${gift.coins} moedas` : ''}{gift.seenCount ? ` · visto ${gift.seenCount}×` : ''}</small>
                {gift.slotId ? <em>{`→ ${gift.slotId}`}</em> : (
                  <select
                    aria-label={`Vincular ${gift.giftId} a um slot`}
                    value=""
                    onChange={(event) => {
                      const slot = overview.slots.find((item) => item.slotId === event.target.value);
                      if (slot) void save(slot, { giftId: gift.giftId, allowManual: true });
                    }}
                  >
                    <option value="">sem associação — vincular a…</option>
                    {overview.slots.filter((slot) => !slot.mapped).map((slot) => (
                      <option key={slot.slotId} value={slot.slotId}>{slot.team === 'lula' ? 'Lula' : 'Bolsonaro'} · {slot.label} (+{slot.blocks})</option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function describeEvent(item: ProcessedSummary): string {
  const what = item.kind === 'gift' ? `presente ${item.giftName ?? item.giftId ?? ''}`.trim() : item.kind === 'like' ? 'curtida' : item.kind === 'comment' ? 'comentário' : 'seguidor';
  if (item.status === 'applied') return `${what} → +${item.points} para ${item.team ? TEAM_LABELS[item.team] : ''}`;
  if (item.status === 'accumulated') return `${what} → acumulando para o próximo bloco`;
  if (item.status === 'duplicate') return `${what} → duplicado`;
  return `${what} → descartado (${REASON_LABEL[item.reason ?? ''] ?? item.reason ?? item.status})`;
}

function IgnoredTable({ rows }: { rows: IgnoredReasonRow[] }) {
  return (
    <div className="ignored-table">
      <h3>Eventos reais descartados, por motivo</h3>
      {rows.length === 0 ? <p className="admin-hint">Nenhum evento real descartado.</p> : (
        <table>
          <thead><tr><th>Tipo</th><th>Motivo</th><th>Eventos</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.kind}-${row.reason}`}>
                <td>{row.kind === 'gift' ? 'presente' : row.kind === 'like' ? 'curtida' : row.kind === 'comment' ? 'comentário' : 'seguir'}</td>
                <td>{REASON_LABEL[row.reason] ?? row.reason}</td>
                <td>{row.events}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
