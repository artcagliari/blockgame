export type Team = 'lula' | 'bolsonaro';
export type RoundPhase = 'playing' | 'paused' | 'result';

export interface GameConfig {
  target: number;
  durationSeconds: number;
  resultSeconds: number;
  autoSpeed: number;
  soundEnabled: boolean;
  /** Gerador automático de blocos (independente dos eventos do TikTok). */
  autoEnabled: boolean;
  /** Quais equipes recebem incrementos automáticos. */
  autoTeams: Record<Team, boolean>;
  /** Inicia a próxima rodada sozinho ao fim do intervalo de resultado. */
  autoRestart: boolean;
}

export interface TeamState {
  score: number;
  wins: number;
}

export interface GameState {
  /** Número exibido da rodada (não muda em "reiniciar rodada"). */
  round: number;
  /** Identificador único de cada início de rodada, usado para descartar eventos de rodadas antigas. */
  roundId: number;
  /** Sequência monotônica do estado oficial: cada mudança incrementa. */
  seq: number;
  phase: RoundPhase;
  teams: Record<Team, TeamState>;
  config: GameConfig;
  startedAt: number | null;
  pausedAt: number | null;
  pauseAccumulatedMs: number;
  resultStartedAt: number | null;
  winner: Team | 'draw' | null;
  serverNow: number;
}

/** real = TikTok LIVE; auto = gerador do jogo; test = simulação do painel administrativo. */
export type EventOrigin = 'real' | 'auto' | 'test';
export type EventKind = 'like' | 'follow' | 'gift' | 'auto' | 'manual';

export interface IncrementEvent {
  id: string;
  roundId: number;
  /** Sequência do estado oficial após aplicar este evento. */
  seq: number;
  team: Team;
  /** Pontos efetivamente adicionados (limitados pela meta). */
  amount: number;
  /** Pontuação atual da equipe após o evento. */
  total: number;
  opponentTotal: number;
  source: 'automatic' | 'admin' | 'gift';
  origin: EventOrigin;
  kind: EventKind;
  effect?: 'like' | 'follow' | 'gift';
  /** Identificador visual do presente (catálogo do jogo), não o ID do TikTok. */
  giftId?: string;
  giftName?: string;
  /** Quantidade de presentes representados (combos). */
  count?: number;
  viewerName?: string;
  at: number;
}

/**
 * Canal público (overlay): somente leitura. Nenhum evento do cliente altera o jogo.
 * `state` é o snapshot completo; `increment` é o delta que aciona a animação de queda.
 */
export interface ServerToClientEvents {
  state: (state: GameState) => void;
  increment: (event: IncrementEvent) => void;
  roundStarted: (state: GameState) => void;
  roundEnded: (state: GameState) => void;
  /** Lista de áudios ativos para pré-carregar + volume geral. */
  'audio:manifest': (manifest: AudioManifest) => void;
  /** Ordem do servidor para o overlay reproduzir um áudio. */
  'audio:play': (command: AudioPlayCommand) => void;
  /** Interrompe tudo o que estiver tocando e esvazia a fila. */
  'audio:stop': () => void;
  /** Comando da música de fundo (pular faixa). Ligar/desligar vai pelo manifesto. */
  'audio:music': (command: { action: 'next' }) => void;
}

export interface ClientToServerEvents {
  /** Pede um snapshot atualizado (após lacuna de sequência ou reconexão). */
  sync: () => void;
  /** Telemetria do overlay (somente diagnóstico; não altera o jogo). */
  'audio:report': (report: AudioReport) => void;
}

// ---------------- Áudio ----------------

export type AudioTeam = Team | 'geral';
/** bordao/comemoracao tocam um de cada vez (canal de voz); efeito/vinheta podem sobrepor. */
export type AudioCategory = 'bordao' | 'comemoracao' | 'efeito' | 'vinheta' | 'musica';
/** music = música de fundo contínua (streaming, não é pré-decodificada). */
export type AudioChannel = 'voice' | 'sfx' | 'music';

export interface MusicSettings {
  /** Liga/desliga a música em todos os overlays. */
  enabled: boolean;
  clipIds: string[];
  mode: 'sequential' | 'shuffle';
  /** 0..1, multiplicado pelo volume geral. */
  volume: number;
  /** Fração do volume da música enquanto toca um bordão/comemoração (0..1). */
  duck: number;
  /** Só toca com a rodada em andamento (senão, toca também aguardando a LIVE). */
  onlyDuringMatch: boolean;
}

export const AUDIO_EVENT_KEYS = [
  'event:like',
  'event:follow',
  'event:gift',
  'event:combo',
  'event:blocks',
  'event:roundStart',
  'event:countdown',
  'event:leadChange',
  'event:victory:lula',
  'event:victory:bolsonaro',
  'event:draw',
] as const;
export type AudioEventKey = (typeof AUDIO_EVENT_KEYS)[number];
/** `gift:<equipe>:<id visual>` — um por presente (12). */
export type AudioBindingKey = AudioEventKey | `gift:${Team}:${string}`;

export interface AudioClipInfo {
  id: string;
  name: string;
  category: AudioCategory;
  team: AudioTeam;
  mime: string;
  sizeBytes: number;
  durationMs: number | null;
  /** 0..1 */
  volume: number;
  active: boolean;
  sha256: string;
  createdAt: number;
  updatedAt: number;
}

export interface AudioBinding {
  clipIds: string[];
  mode: 'random' | 'sequential';
  enabled: boolean;
  /** Intervalo mínimo entre duas reproduções deste gatilho. */
  cooldownMs: number;
}

export interface AudioConfig {
  /** 0..1, aplicado no overlay. */
  masterVolume: number;
  /** Efeitos sintetizados originais do jogo (bipes). */
  builtinEffects: boolean;
  /** Máximo de sons simultâneos no overlay. */
  maxConcurrent: number;
  /** Intervalo mínimo entre dois bordões (canal de voz). */
  minVoiceGapMs: number;
  bindings: Partial<Record<AudioBindingKey, AudioBinding>>;
  randomBordoes: {
    enabled: boolean;
    intervalSeconds: number;
    /** Variação aleatória de ±% do intervalo. */
    jitterPercent: number;
    clipIds: string[];
  };
  music: MusicSettings;
}

export interface AudioManifest {
  clips: Array<{ id: string; url: string; volume: number; channel: AudioChannel; durationMs: number | null; name: string }>;
  masterVolume: number;
  builtinEffects: boolean;
  maxConcurrent: number;
  minVoiceGapMs: number;
  music: MusicSettings & { tracks: Array<{ id: string; url: string; name: string }> };
  version: number;
}

export interface AudioPlayCommand {
  playId: string;
  clipId: string;
  url: string;
  key: AudioBindingKey | 'manual' | 'random' | 'trigger';
  priority: number;
  channel: AudioChannel;
  volume: number;
  /** Depois disso o som é descartado em vez de tocar atrasado. */
  expiresAt: number;
  at: number;
}

export type MusicState = 'off' | 'playing' | 'paused' | 'waiting' | 'blocked' | 'error';
export type AudioEngineState = 'unsupported' | 'locked' | 'running' | 'suspended' | 'error';

export type AudioReport =
  | {
      type: 'status';
      clientId: string;
      page: 'overlay' | 'diagnostico';
      engine: AudioEngineState;
      loaded: number;
      total: number;
      failedLoads: string[];
      playing: number;
      queued: number;
      lastError: string | null;
      masterVolume: number;
      userAgent: string;
      music?: { state: MusicState; track: string | null; volume: number };
    }
  | { type: 'ack'; clientId: string; playId: string; status: 'played' | 'failed' | 'dropped' | 'blocked'; error?: string };

export const DEFAULT_CONFIG: GameConfig = {
  target: 2000,
  durationSeconds: 300,
  resultSeconds: 10,
  autoSpeed: 1,
  soundEnabled: true,
  // Somente eventos reais da LIVE pontuam. O gerador automático é opt-in pelo painel.
  autoEnabled: false,
  autoTeams: { lula: true, bolsonaro: true },
  autoRestart: true,
};

export const TEAM_LABELS: Record<Team, string> = {
  lula: 'LULA',
  bolsonaro: 'BOLSONARO',
};
