import { gameSocket } from './socket';

const KEY = 'bdb-last-auto-reload';

/**
 * Recarrega a página quando o servidor publica uma versão nova do frontend.
 * Importante para a fonte de navegador do LIVE Studio, que fica aberta por horas
 * e não recarrega sozinha depois de um deploy.
 */
export function enableAutoUpdate(): void {
  const current = currentScript();
  if (!current) return; // desenvolvimento (Vite) não tem bundle com hash
  gameSocket.on('build', ({ script }) => {
    if (!script || script === current) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem(KEY) ?? 0); } catch { /* sem armazenamento */ }
    if (Date.now() - last < 60_000) return; // evita laço de recarga
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* sem armazenamento */ }
    window.setTimeout(() => window.location.reload(), 1_500);
  });
}

function currentScript(): string | null {
  const tag = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  if (!tag) return null;
  try {
    return new URL(tag.src, window.location.href).pathname;
  } catch {
    return null;
  }
}
