// Teste ponta a ponta do overlay em navegador real (Playwright + Chromium).
//
//   npm run build
//   node e2e/overlay.e2e.mjs [pastaDeCapturas]
//
// Sobe o servidor de produção em outra porta com AUTOPLAY=off (somente eventos explícitos
// mudam o placar) e armazenamento volátil, abre /overlay, dispara eventos de TESTE pela API
// administrativa autenticada e lê o estado real das torres via window.__towers()
// (ativo com ?debugTower=1).
//
// Requer o pacote `playwright`. Se não estiver em node_modules, aponte PLAYWRIGHT_DIR para a
// pasta node_modules que o contém.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'e2e-output'));
mkdirSync(outDir, { recursive: true });

const require = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR}/` : `${root}/`);
const { chromium } = require('playwright');

const [VIEW_W, VIEW_H] = (process.env.VIEWPORT ?? '540x960').split('x').map(Number);
const PORT = Number(process.env.E2E_PORT ?? 3101);
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const ADMIN_TOKEN = 'e2e-token-0123456789-abcdef';
const server = spawn('node', ['server-dist/server/index.js'], {
  cwd: root,
  env: {
    ...process.env, NODE_ENV: 'production', PORT: String(PORT), AUTOPLAY: 'off',
    ADMIN_TOKEN, ALLOW_EPHEMERAL: 'true', ENABLE_TEST_EVENTS: 'true', TIKTOK_USERNAME: '', TIKTOK_AUTOCONNECT: 'false',
  },
  stdio: 'ignore',
});
const adminCall = (route, method, body) =>
  fetch(`${URL}/api/admin${route}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => response.json().catch(() => ({})));
let browser;
let admin;

async function cleanup() {
  admin?.close();
  await browser?.close();
  server.kill('SIGTERM');
}

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${URL}/health`)).ok) break;
    } catch { /* aguardando o servidor */ }
    await sleep(100);
  }

  // Observador do estado oficial (canal público, somente leitura).
  admin = io(URL, { transports: ['websocket'] });
  await new Promise((resolve) => admin.on('connect', resolve));
  let serverState = null;
  admin.on('state', (state) => { serverState = state; });
  const send = (team, amount) => { void adminCall('/test/increment', 'POST', { team, amount }); };

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H }, deviceScaleFactor: 1 });
  const consoleTower = [];
  page.on('console', (message) => { if (message.text().includes('[TowerController]')) consoleTower.push(message.text()); });
  page.on('pageerror', (error) => check('sem erros de página', false, error.message));

  const towers = () => page.evaluate(() => window.__towers?.());
  const waitFor = async (predicate, timeout = 20_000, step = 50) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await towers();
      if (value && predicate(value)) return value;
      await sleep(step);
    }
    return towers();
  };
  const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

  await page.goto(`${URL}/overlay?debugTower=1`);
  await page.waitForFunction(() => typeof window.__towers === 'function');
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas').getBoundingClientRect();
    const h = document.querySelector('.pixi-host').getBoundingClientRect();
    return { canvas: [c.width, c.height], host: [h.width, h.height] };
  });
  check('canvas acompanha o tamanho do overlay (sem torres fora do quadro)',
    canvas.canvas[0] === canvas.host[0] && canvas.canvas[1] === canvas.host[1], JSON.stringify(canvas));
  let state = await towers();
  check('pilhas começam vazias', state.lula.settledLayers === 0 && state.bolsonaro.settledLayers === 0);
  await shot('00-vazio');

  // ---- TESTE A: Lula, 10 pontos graduais
  const heightsA = [];
  const heightsB = [];
  let maxFalling = 0;
  let previousHeight = -1; // a 1ª placa fica sobre a base (altura 0)
  let monotonic = true;
  let sawFalling = false;
  for (let point = 1; point <= 10; point += 1) {
    send('lula', 1);
    const during = await waitFor((s) => s.lula.fallingNodes === 1, 2000, 15);
    if (during.lula.fallingNodes === 1) sawFalling = true;
    if (point === 4) await shot('A1-lula-queda');
    const after = await waitFor((s) => s.lula.landedScore === point && !s.lula.hasActivePiece, 4000, 25);
    maxFalling = Math.max(maxFalling, after.lula.fallingNodes);
    if (after.lula.stackHeight <= previousHeight) monotonic = false;
    previousHeight = after.lula.stackHeight;
    heightsA.push(Number(after.lula.stackHeight.toFixed(1)));
  }
  state = await towers();
  check('A: blocos vermelhos aparecem caindo', sawFalling);
  check('A: uma placa por vez em queda', maxFalling <= 1);
  check('A: 10 placas permanecem empilhadas', state.lula.settledLayers === 10, `layers=${state.lula.settledLayers}`);
  check('A: altura cresce a cada placa', monotonic && state.lula.stackHeight > 80, `alturas=${heightsA.join(',')}`);
  check('A: Bolsonaro permanece intocado', state.bolsonaro.settledLayers === 0 && state.bolsonaro.landedScore === 0);
  await shot('A2-lula-10');

  // ---- TESTE B: Bolsonaro, 10 pontos graduais
  previousHeight = -1;
  monotonic = true;
  sawFalling = false;
  maxFalling = 0;
  for (let point = 1; point <= 10; point += 1) {
    send('bolsonaro', 1);
    const during = await waitFor((s) => s.bolsonaro.fallingNodes === 1, 2000, 15);
    if (during.bolsonaro.fallingNodes === 1) sawFalling = true;
    const after = await waitFor((s) => s.bolsonaro.landedScore === point && !s.bolsonaro.hasActivePiece, 4000, 25);
    maxFalling = Math.max(maxFalling, after.bolsonaro.fallingNodes);
    if (after.bolsonaro.stackHeight <= previousHeight) monotonic = false;
    previousHeight = after.bolsonaro.stackHeight;
    heightsB.push(Number(after.bolsonaro.stackHeight.toFixed(1)));
  }
  state = await towers();
  check('B: blocos verdes aparecem caindo', sawFalling);
  check('B: uma placa por vez em queda', maxFalling <= 1);
  check('B: 10 placas permanecem empilhadas', state.bolsonaro.settledLayers === 10);
  check('B: altura cresce a cada placa', monotonic && state.bolsonaro.stackHeight > 80, `alturas=${heightsB.join(',')}`);
  check('B: Lula permanece com as 10 placas', state.lula.settledLayers === 10);
  await shot('B-bolsonaro-10');

  // ---- TESTE C: simultâneo
  send('lula', 5);
  send('bolsonaro', 5);
  let both = 0;
  let maxA = 0;
  let maxB = 0;
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const s = await towers();
    if (s.lula.fallingNodes === 1 && s.bolsonaro.fallingNodes === 1) both += 1;
    maxA = Math.max(maxA, s.lula.fallingNodes);
    maxB = Math.max(maxB, s.bolsonaro.fallingNodes);
    if (both === 1) await shot('C-simultaneo');
    if (s.lula.landedScore === 15 && s.bolsonaro.landedScore === 15 && !s.lula.hasActivePiece && !s.bolsonaro.hasActivePiece) break;
    await sleep(40);
  }
  state = await towers();
  check('C: as duas torres constroem ao mesmo tempo', both > 0, `quadros simultâneos=${both}`);
  check('C: no máximo uma placa em queda por torre', maxA <= 1 && maxB <= 1);
  check('C: ambas somam +5 de forma independente (pontos e camadas)',
    state.lula.landedScore === 15 && state.bolsonaro.landedScore === 15
      && state.lula.settledLayers >= 14 && state.lula.settledLayers === state.bolsonaro.settledLayers,
    `${state.lula.settledLayers}/${state.bolsonaro.settledLayers} camadas`);

  // ---- TESTE D: eventos grandes
  const startedBig = Date.now();
  send('lula', 500);
  send('bolsonaro', 1000);
  let maxFallL = 0;
  let maxFallB = 0;
  let maxQueued = 0;
  let midShot = false;
  let done = false;
  while (Date.now() - startedBig < 25_000) {
    const s = await towers();
    maxFallL = Math.max(maxFallL, s.lula.fallingNodes);
    maxFallB = Math.max(maxFallB, s.bolsonaro.fallingNodes);
    maxQueued = Math.max(maxQueued, s.lula.queued, s.bolsonaro.queued);
    if (!midShot && Date.now() - startedBig > 700) { midShot = true; await shot('D1-grande-meio'); }
    if (s.lula.landedScore === 515 && s.bolsonaro.landedScore === 1015 && !s.lula.hasActivePiece && !s.bolsonaro.hasActivePiece) { done = true; break; }
    await sleep(50);
  }
  const bigSeconds = (Date.now() - startedBig) / 1000;
  state = await towers();
  check('D: +500 e +1000 concluem sem travar', done, `${bigSeconds.toFixed(1)}s`);
  check('D: nunca mais de uma placa caindo por torre', maxFallL <= 1 && maxFallB <= 1);
  check('D: fila limitada (agrupamento, sem centenas de sprites)', maxQueued <= 12, `maxFila=${maxQueued}`);
  check('D: camadas renderizadas limitadas', state.lula.settledLayers < 160 && state.bolsonaro.settledLayers < 160,
    `${state.lula.settledLayers}/${state.bolsonaro.settledLayers}`);
  check('D: visual acompanha a pontuação oficial',
    state.lula.landedScore === serverState.teams.lula.score && state.bolsonaro.landedScore === serverState.teams.bolsonaro.score,
    `${state.lula.landedScore}/${state.bolsonaro.landedScore}`);
  check('D: pilha maior para quem tem mais pontos', state.bolsonaro.stackHeight > state.lula.stackHeight);
  await shot('D2-grande-fim');

  // ---- TESTE E: recarregar durante a rodada
  const before = await towers();
  consoleTower.length = 0;
  send('lula', 5);
  await sleep(120);
  await page.reload();
  await page.waitForFunction(() => typeof window.__towers === 'function');
  const afterReload = consoleTower.length;
  const reloaded = await waitFor((s) => s.lula.landedScore >= 520, 8000, 25);
  await sleep(1500);
  const earlyFalling = consoleTower.slice(afterReload).filter((line) => line.includes('state: falling')).length;
  check('E: pilhas restauradas ao recarregar',
    reloaded.lula.landedScore === serverState.teams.lula.score && reloaded.bolsonaro.landedScore === serverState.teams.bolsonaro.score,
    `${reloaded.lula.landedScore}/${reloaded.bolsonaro.landedScore}`);
  check('E: nenhuma animação antiga é reproduzida', reloaded.lula.queued === 0 && reloaded.bolsonaro.queued === 0 && earlyFalling === 0,
    `quedas após reload=${earlyFalling}`);
  check('E: altura restaurada não é menor que a anterior', reloaded.bolsonaro.stackHeight >= before.bolsonaro.stackHeight - 1);
  await shot('E-recarregado');

  // ---- TESTE F: fim de rodada e reinício automático
  await adminCall('/game/reset', 'POST', {});
  await sleep(300);
  await adminCall('/game/config', 'PUT', { target: 10, resultSeconds: 3 });
  await sleep(300);
  const roundBefore = serverState.round;
  send('lula', 10);
  const phaseResult = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (serverState.phase === 'result') return true;
      await sleep(50);
    }
    return false;
  })();
  check('F: rodada finaliza ao atingir a meta', phaseResult);
  await waitFor((s) => s.lula.landedScore === 10 && !s.lula.hasActivePiece, 6000, 50);
  await shot('F1-fim-de-rodada');
  const restarted = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (serverState.phase === 'playing' && serverState.round === roundBefore + 1) return true;
      await sleep(50);
    }
    return false;
  })();
  check('F: nova rodada inicia automaticamente', restarted, `rodada ${roundBefore} → ${serverState.round}`);
  await adminCall('/game/config', 'PUT', { target: 2000, resultSeconds: 10 });
  const cleared = await waitFor((s) => s.lula.settledLayers === 0 && s.bolsonaro.settledLayers === 0 && s.lula.landedScore === 0, 4000, 50);
  check('F: as duas pilhas são limpas', cleared.lula.settledLayers === 0 && cleared.bolsonaro.settledLayers === 0);
  send('lula', 1);
  send('bolsonaro', 1);
  const rebuilt = await waitFor((s) => s.lula.landedScore === 1 && s.bolsonaro.landedScore === 1 && !s.lula.hasActivePiece && !s.bolsonaro.hasActivePiece, 4000, 50);
  check('F: construção recomeça do zero', rebuilt.lula.settledLayers === 1 && rebuilt.lula.settledTopY === 1712 && rebuilt.bolsonaro.settledLayers === 1);
  await shot('F2-nova-rodada');
} catch (error) {
  check('execução sem exceções', false, String(error?.stack ?? error));
} finally {
  await cleanup();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram. Capturas em ${outDir}`);
process.exit(failed.length ? 1 : 0);
