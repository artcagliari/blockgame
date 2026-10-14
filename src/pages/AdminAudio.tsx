import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AudioBinding, AudioBindingKey, AudioCategory, AudioClipInfo, AudioConfig, AudioTeam, Team } from '../game/types';
import { api } from './admin-api';

interface AudioOverview {
  clips: AudioClipInfo[];
  config: AudioConfig;
  storage: 'database' | 'filesystem';
  limits: { maxBytes: number; maxClips: number; formats: string[] };
  eventKeys: AudioBindingKey[];
  slots: Array<{ key: AudioBindingKey; team: Team; label: string; visualId: string; blocks: number }>;
  defaultCooldowns: Record<string, number>;
  diagnostics: {
    storage: string;
    overlays: Array<{
      clientId: string; ageMs: number;
      status: null | { page: string; engine: string; loaded: number; total: number; failedLoads: string[]; playing: number; queued: number; lastError: string | null; masterVolume: number; userAgent: string };
    }>;
    dispatches: Array<{ playId: string; key: string; clipName: string; at: number; priority: number; acks: Record<string, { status: string; error?: string }> }>;
  };
}

const CATEGORY_LABEL: Record<AudioCategory, string> = { bordao: 'Bordão', comemoracao: 'Comemoração', efeito: 'Efeito', vinheta: 'Vinheta' };
const TEAM_LABEL: Record<AudioTeam, string> = { lula: 'Lula', bolsonaro: 'Bolsonaro', geral: 'Geral' };
const EVENT_LABEL: Record<string, string> = {
  'event:like': 'Like',
  'event:follow': 'Novo seguidor',
  'event:gift': 'Presente recebido (sem som próprio)',
  'event:combo': 'Combo',
  'event:blocks': 'Queda de blocos',
  'event:roundStart': 'Início de rodada',
  'event:countdown': 'Últimos 10 segundos',
  'event:leadChange': 'Virada na liderança',
  'event:victory:lula': 'Vitória do Lula',
  'event:victory:bolsonaro': 'Vitória do Bolsonaro',
  'event:draw': 'Empate',
};

/** Duração e verificação de decodificação no navegador antes do envio. */
async function measureDuration(file: File): Promise<number | null> {
  try {
    const Ctor = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Ctor) return null;
    const context = new Ctor(1, 1, 44_100);
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    return Math.round(buffer.duration * 1000);
  } catch {
    return null;
  }
}

async function sendFile(token: string, path: string, method: 'POST' | 'PUT', file: File) {
  const response = await fetch(`/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message ?? data?.error ?? `Erro ${response.status}`);
  return data;
}

const formatMs = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}:${String(Math.round(ms % 60_000 / 1000)).padStart(2, '0')}`);
const formatBytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function AdminAudio({ token, onNotice }: { token: string; onNotice: (message: string) => void }) {
  const [data, setData] = useState<AudioOverview | null>(null);
  const [filter, setFilter] = useState<{ category: string; team: string; text: string }>({ category: '', team: '', text: '' });
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const previewRef = useRef(previews);
  previewRef.current = previews;

  const load = useCallback(async () => {
    try {
      setData(await api<AudioOverview>(token, '/audio'));
    } catch { /* o painel principal já indica falhas de conexão */ }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => () => { for (const url of Object.values(previewRef.current)) URL.revokeObjectURL(url); }, []);

  const call = useCallback(async (label: string, path: string, init?: { method?: string; body?: unknown }) => {
    try {
      const result = await api<Record<string, unknown>>(token, path, init);
      onNotice(typeof result.message === 'string' ? `${label}: ${result.message}` : `${label}: concluído.`);
      void load();
      // Ordens de reprodução: busca de novo para exibir a confirmação vinda do overlay.
      if (path.startsWith('/audio/play') || path.startsWith('/audio/trigger') || path.startsWith('/audio/random') || path.startsWith('/audio/stop')) {
        window.setTimeout(() => void load(), 900);
      }
      return result;
    } catch (error) {
      onNotice(`${label}: ${(error as Error).message}`);
      return null;
    }
  }, [token, load, onNotice]);

  const saveConfig = (patch: Partial<AudioConfig>, label = 'Configuração de áudio') => call(label, '/audio/config', { method: 'PUT', body: patch });

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const file = values.get('file');
    if (!(file instanceof File) || file.size === 0) { onNotice('Escolha um arquivo MP3, WAV ou OGG.'); return; }
    if (data && file.size > data.limits.maxBytes) { onNotice(`Arquivo maior que ${formatBytes(data.limits.maxBytes)}.`); return; }
    setUploading(true);
    try {
      const duration = await measureDuration(file);
      if (duration === null) onNotice('Aviso: o navegador não conseguiu decodificar o arquivo; o servidor fará a validação.');
      const params = new URLSearchParams({
        name: String(values.get('name') || file.name.replace(/\.[^.]+$/, '')).slice(0, 60),
        category: String(values.get('category')),
        team: String(values.get('team')),
        volume: String(Number(values.get('volume') ?? 100) / 100),
      });
      if (duration) params.set('durationMs', String(duration));
      await sendFile(token, `/audio?${params}`, 'POST', file);
      onNotice(`Áudio “${params.get('name')}” enviado.`);
      form.reset();
      void load();
    } catch (error) {
      onNotice(`Envio: ${(error as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const replace = async (clip: AudioClipInfo, file: File) => {
    try {
      const duration = await measureDuration(file);
      await sendFile(token, `/audio/${clip.id}/file${duration ? `?durationMs=${duration}` : ''}`, 'PUT', file);
      onNotice(`“${clip.name}” substituído.`);
      setPreviews((current) => { const { [clip.id]: old, ...rest } = current; if (old) URL.revokeObjectURL(old); return rest; });
      void load();
    } catch (error) {
      onNotice(`Substituir: ${(error as Error).message}`);
    }
  };

  const preview = async (clip: AudioClipInfo) => {
    if (previews[clip.id]) return;
    try {
      const response = await fetch(`/api/admin/audio/${clip.id}/file`, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Erro ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      setPreviews((current) => ({ ...current, [clip.id]: url }));
    } catch (error) {
      onNotice(`Prévia: ${(error as Error).message}`);
    }
  };

  const clips = data?.clips ?? [];
  const visible = useMemo(() => clips.filter((clip) =>
    (!filter.category || clip.category === filter.category)
    && (!filter.team || clip.team === filter.team)
    && (!filter.text || clip.name.toLowerCase().includes(filter.text.toLowerCase()))), [clips, filter]);

  if (!data) {
    return (
      <section className="panel audio-panel">
        <div className="panel-title"><span>07</span><div><h2>Sons e bordões</h2><p>Carregando…</p></div></div>
      </section>
    );
  }

  const { config } = data;
  const binding = (key: AudioBindingKey): AudioBinding => config.bindings[key] ?? { clipIds: [], mode: 'random', enabled: true, cooldownMs: data.defaultCooldowns[key] ?? 0 };
  const saveBinding = (key: AudioBindingKey, patch: Partial<AudioBinding>) => saveConfig({ bindings: { [key]: { ...binding(key), ...patch } } } as Partial<AudioConfig>, 'Vínculo de áudio');
  const active = clips.filter((clip) => clip.active);

  return (
    <section className="panel audio-panel">
      <div className="panel-title"><span>07</span><div><h2>Sons e bordões</h2><p>Os arquivos são enviados por você. O overlay da transmissão é quem toca o som; o servidor só envia as ordens.</p></div></div>

      {/* ---------------- Mesa de sons ---------------- */}
      <div className="audio-board">
        <div className="audio-board__controls">
          <button className="button button--pause audio-stop" onClick={() => void call('Parar áudio', '/audio/stop', { body: {} })}>■ PARAR ÁUDIO</button>
          <label>Volume geral <span>{Math.round(config.masterVolume * 100)}%</span>
            <input type="range" min={0} max={100} defaultValue={Math.round(config.masterVolume * 100)} key={`mv-${config.masterVolume}`}
              onMouseUp={(event) => void saveConfig({ masterVolume: Number(event.currentTarget.value) / 100 }, 'Volume geral')}
              onTouchEnd={(event) => void saveConfig({ masterVolume: Number(event.currentTarget.value) / 100 }, 'Volume geral')}
              onKeyUp={(event) => void saveConfig({ masterVolume: Number(event.currentTarget.value) / 100 }, 'Volume geral')} />
          </label>
          <label>Sons simultâneos <span>{config.maxConcurrent}</span>
            <input type="range" min={1} max={6} defaultValue={config.maxConcurrent} key={`mc-${config.maxConcurrent}`}
              onMouseUp={(event) => void saveConfig({ maxConcurrent: Number(event.currentTarget.value) })} />
          </label>
          <label>Intervalo mínimo entre bordões <span>{(config.minVoiceGapMs / 1000).toFixed(1)} s</span>
            <input type="range" min={0} max={10_000} step={250} defaultValue={config.minVoiceGapMs} key={`gap-${config.minVoiceGapMs}`}
              onMouseUp={(event) => void saveConfig({ minVoiceGapMs: Number(event.currentTarget.value) })} />
          </label>
          <label className="audio-inline-toggle">
            <input type="checkbox" checked={config.builtinEffects} onChange={(event) => void saveConfig({ builtinEffects: event.target.checked })} />
            Efeitos sintetizados originais (bipes do jogo)
          </label>
        </div>
        <h3>Mesa de sons — reproduz no overlay da LIVE</h3>
        {active.length === 0 ? <p className="admin-hint">Nenhum áudio ativo. Envie arquivos abaixo.</p> : (
          <div className="audio-pads">
            {active.map((clip) => (
              <button key={clip.id} className={`audio-pad audio-pad--${clip.team}`} onClick={() => void call(`“${clip.name}” na LIVE`, '/audio/play', { body: { clipId: clip.id } })}>
                <b>{clip.name}</b>
                <small>{CATEGORY_LABEL[clip.category]} · {formatMs(clip.durationMs)}</small>
                <em>REPRODUZIR NA LIVE</em>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---------------- Envio ---------------- */}
      <form className="audio-upload" onSubmit={upload}>
        <h3>Enviar áudio</h3>
        <input name="file" type="file" accept=".mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg" required />
        <input name="name" placeholder="Nome (ex.: Bordão 1)" maxLength={60} />
        <select name="category" defaultValue="bordao">{Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select name="team" defaultValue="geral">{Object.entries(TEAM_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <label>Volume <input name="volume" type="number" min={0} max={100} defaultValue={100} />%</label>
        <button className="button button--start" type="submit" disabled={uploading}>{uploading ? 'ENVIANDO…' : 'ENVIAR'}</button>
        <p className="admin-hint">MP3, WAV ou OGG, até {formatBytes(data.limits.maxBytes)} e 2 minutos. {clips.length}/{data.limits.maxClips} áudios · armazenamento: {data.storage === 'database' ? 'PostgreSQL' : 'volume persistente'}.</p>
      </form>

      {/* ---------------- Biblioteca ---------------- */}
      <div className="audio-library">
        <div className="audio-library__filters">
          <h3>Biblioteca ({clips.length})</h3>
          <input placeholder="Buscar" value={filter.text} onChange={(event) => setFilter({ ...filter, text: event.target.value })} />
          <select value={filter.category} onChange={(event) => setFilter({ ...filter, category: event.target.value })}>
            <option value="">Todas as categorias</option>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={filter.team} onChange={(event) => setFilter({ ...filter, team: event.target.value })}>
            <option value="">Todas as equipes</option>
            {Object.entries(TEAM_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {visible.length === 0 ? <p className="admin-hint">Nenhum áudio.</p> : (
          <ul>
            {visible.map((clip) => (
              <li key={clip.id} className={`audio-clip ${clip.active ? '' : 'is-off'}`}>
                <input className="audio-clip__name" defaultValue={clip.name} key={`n-${clip.id}-${clip.name}`} maxLength={60}
                  onBlur={(event) => { if (event.target.value.trim() && event.target.value !== clip.name) void call('Renomear', `/audio/${clip.id}`, { method: 'PUT', body: { name: event.target.value } }); }} />
                <select value={clip.category} onChange={(event) => void call('Categoria', `/audio/${clip.id}`, { method: 'PUT', body: { category: event.target.value } })}>
                  {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select value={clip.team} onChange={(event) => void call('Equipe', `/audio/${clip.id}`, { method: 'PUT', body: { team: event.target.value } })}>
                  {Object.entries(TEAM_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <span className="audio-clip__meta">{formatMs(clip.durationMs)} · {formatBytes(clip.sizeBytes)} · {clip.mime.replace('audio/', '').toUpperCase()}</span>
                <label className="audio-clip__volume">Vol. {Math.round(clip.volume * 100)}%
                  <input type="range" min={0} max={100} defaultValue={Math.round(clip.volume * 100)} key={`v-${clip.id}-${clip.volume}`}
                    onMouseUp={(event) => void call('Volume', `/audio/${clip.id}`, { method: 'PUT', body: { volume: Number(event.currentTarget.value) / 100 } })} />
                </label>
                <label className="audio-inline-toggle">
                  <input type="checkbox" checked={clip.active} onChange={(event) => void call(event.target.checked ? 'Ativar' : 'Desativar', `/audio/${clip.id}`, { method: 'PUT', body: { active: event.target.checked } })} /> Ativo
                </label>
                <div className="audio-clip__actions">
                  {previews[clip.id]
                    ? <audio controls src={previews[clip.id]} preload="auto" />
                    : <button type="button" onClick={() => void preview(clip)}>▶ PRÉVIA</button>}
                  <button type="button" disabled={!clip.active} onClick={() => void call(`“${clip.name}” na LIVE`, '/audio/play', { body: { clipId: clip.id } })}>REPRODUZIR NA LIVE</button>
                  <label className="audio-replace">SUBSTITUIR
                    <input type="file" accept=".mp3,.wav,.ogg,audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void replace(clip, file); event.target.value = ''; }} />
                  </label>
                  <button type="button" className="danger" onClick={() => { if (window.confirm(`Excluir “${clip.name}”? Ele será removido de todos os vínculos.`)) void call('Excluir', `/audio/${clip.id}`, { method: 'DELETE' }); }}>EXCLUIR</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------------- Vínculos ---------------- */}
      <div className="audio-bindings">
        <h3>Sons dos 12 presentes</h3>
        <div className="audio-bindings__grid">
          {data.slots.map((slot) => (
            <BindingRow key={slot.key} title={`${slot.team === 'lula' ? 'Lula' : 'Bolsonaro'} · ${slot.label} (+${slot.blocks})`} team={slot.team}
              binding={binding(slot.key)} clips={clips} onSave={(patch) => void saveBinding(slot.key, patch)}
              onTest={() => void call('Testar gatilho', '/audio/trigger', { body: { key: slot.key } })} />
          ))}
        </div>
        <h3>Eventos automáticos</h3>
        <div className="audio-bindings__grid">
          {data.eventKeys.map((key) => (
            <BindingRow key={key} title={EVENT_LABEL[key] ?? key} team="geral" binding={binding(key)} clips={clips}
              onSave={(patch) => void saveBinding(key, patch)} onTest={() => void call('Testar gatilho', '/audio/trigger', { body: { key } })} />
          ))}
        </div>
      </div>

      {/* ---------------- Bordões aleatórios ---------------- */}
      <div className="audio-random">
        <h3>Bordões aleatórios durante a partida</h3>
        <label className="audio-inline-toggle">
          <input type="checkbox" checked={config.randomBordoes.enabled} onChange={(event) => void saveConfig({ randomBordoes: { ...config.randomBordoes, enabled: event.target.checked } })} />
          Ativar (só tocam com a rodada em andamento)
        </label>
        <label>A cada <input type="number" min={10} max={3600} defaultValue={config.randomBordoes.intervalSeconds} key={`ri-${config.randomBordoes.intervalSeconds}`}
          onBlur={(event) => void saveConfig({ randomBordoes: { ...config.randomBordoes, intervalSeconds: Number(event.target.value) } })} /> s</label>
        <label>Variação ± <input type="number" min={0} max={90} defaultValue={config.randomBordoes.jitterPercent} key={`rj-${config.randomBordoes.jitterPercent}`}
          onBlur={(event) => void saveConfig({ randomBordoes: { ...config.randomBordoes, jitterPercent: Number(event.target.value) } })} /> %</label>
        <ClipPicker clips={clips} selected={config.randomBordoes.clipIds} onChange={(clipIds) => void saveConfig({ randomBordoes: { ...config.randomBordoes, clipIds } })} />
        <button className="button button--reset" onClick={() => void call('Bordão aleatório', '/audio/random', { body: {} })}>TOCAR UM AGORA</button>
      </div>

      {/* ---------------- Diagnóstico ---------------- */}
      <div className="audio-diagnostics">
        <h3>Diagnóstico do áudio no overlay</h3>
        <p className="admin-hint">
          Cada overlay aberto (inclusive a fonte de navegador do LIVE Studio) informa aqui o estado do áudio. Para ver o painel dentro do próprio overlay use <code>/overlay?audioDebug=1</code>; para testar só o áudio, <code>/audio-diagnostico</code>.
          Confirmação de reprodução aqui significa que o navegador do overlay tocou o som — a saída na transmissão só é confirmada ouvindo a captura do LIVE Studio.
        </p>
        {data.diagnostics.overlays.length === 0 ? <p className="admin-error">Nenhum overlay conectado informou o estado do áudio.</p> : (
          <table>
            <thead><tr><th>Overlay</th><th>Mecanismo</th><th>Arquivos</th><th>Tocando/fila</th><th>Último erro</th><th>Visto</th></tr></thead>
            <tbody>
              {data.diagnostics.overlays.map((overlay) => (
                <tr key={overlay.clientId}>
                  <td title={overlay.status?.userAgent}>{overlay.status?.page ?? '—'} · {overlay.clientId.slice(0, 8)}</td>
                  <td className={`engine engine--${overlay.status?.engine ?? 'unknown'}`}>{overlay.status?.engine === 'running' ? 'ATIVO' : overlay.status?.engine === 'locked' ? 'BLOQUEADO (autoplay)' : overlay.status?.engine ?? '—'}</td>
                  <td>{overlay.status ? `${overlay.status.loaded}/${overlay.status.total}` : '—'}{overlay.status?.failedLoads.length ? ` · ${overlay.status.failedLoads.length} falha(s)` : ''}</td>
                  <td>{overlay.status ? `${overlay.status.playing}/${overlay.status.queued}` : '—'}</td>
                  <td>{overlay.status?.lastError ?? '—'}</td>
                  <td>há {Math.round(overlay.ageMs / 1000)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>Últimas ordens de áudio</h3>
        {data.diagnostics.dispatches.length === 0 ? <p className="admin-hint">Nenhuma ordem enviada ainda.</p> : (
          <ul className="audio-dispatches">
            {data.diagnostics.dispatches.map((item) => {
              const acks = Object.values(item.acks);
              const played = acks.filter((ack) => ack.status === 'played').length;
              return (
                <li key={item.playId}>
                  <time>{new Date(item.at).toLocaleTimeString('pt-BR')}</time>
                  <b>{item.clipName}</b>
                  <span>{EVENT_LABEL[item.key] ?? item.key}</span>
                  <em className={played ? 'ok' : acks.length ? 'warn' : ''}>
                    {acks.length === 0 ? 'sem confirmação de nenhum overlay' : acks.map((ack) => ack.status === 'played' ? 'tocou' : `${ack.status}${ack.error ? ` (${ack.error})` : ''}`).join(' · ')}
                  </em>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function ClipPicker({ clips, selected, onChange }: { clips: AudioClipInfo[]; selected: string[]; onChange: (ids: string[]) => void }) {
  if (clips.length === 0) return <p className="admin-hint">Envie áudios para poder vinculá-los.</p>;
  return (
    <div className="clip-picker">
      {clips.map((clip) => {
        const on = selected.includes(clip.id);
        return (
          <button type="button" key={clip.id} className={`clip-chip ${on ? 'is-on' : ''} ${clip.active ? '' : 'is-off'}`}
            onClick={() => onChange(on ? selected.filter((id) => id !== clip.id) : [...selected, clip.id])}>
            {on ? '✓ ' : ''}{clip.name}
          </button>
        );
      })}
    </div>
  );
}

function BindingRow({ title, team, binding, clips, onSave, onTest }: {
  title: string; team: AudioTeam; binding: AudioBinding; clips: AudioClipInfo[];
  onSave: (patch: Partial<AudioBinding>) => void; onTest: () => void;
}) {
  return (
    <article className={`binding-row binding-row--${team}`}>
      <header>
        <b>{title}</b>
        <label className="audio-inline-toggle"><input type="checkbox" checked={binding.enabled} onChange={(event) => onSave({ enabled: event.target.checked })} /> ativo</label>
      </header>
      <ClipPicker clips={clips} selected={binding.clipIds} onChange={(clipIds) => onSave({ clipIds })} />
      <footer>
        <select value={binding.mode} onChange={(event) => onSave({ mode: event.target.value as AudioBinding['mode'] })}>
          <option value="random">Aleatório</option>
          <option value="sequential">Sequencial</option>
        </select>
        <label>Intervalo mín. <input type="number" min={0} max={600} step={0.5} defaultValue={binding.cooldownMs / 1000} key={`cd-${binding.cooldownMs}`}
          onBlur={(event) => onSave({ cooldownMs: Math.round(Number(event.target.value) * 1000) })} /> s</label>
        <button type="button" disabled={binding.clipIds.length === 0} onClick={onTest}>TESTAR NA LIVE</button>
      </footer>
    </article>
  );
}
