import { describe, expect, it } from 'vitest';
import { GIFT_SLOTS } from './gift-slots.js';
import { GIFTS } from '../src/game/gifts.js';
import { follow, gift, like, makeHarness } from './test-helpers.js';
import { commentVote } from './live-pipeline.js';
import type { DiagnosticLiveEvent } from './tiktok/events.js';

/** Associa os 12 slots a giftIds sintéticos 1001..1012 (apenas para teste). */
async function mapAll(registry: Awaited<ReturnType<typeof makeHarness>>['registry']) {
  let id = 1001;
  for (const slot of GIFT_SLOTS) {
    await registry.assign(slot.slotId, { giftId: String(id), allowManual: true });
    id += 1;
  }
}

describe('catálogo dos 12 presentes', () => {
  it('espelha src/game/gifts.ts (valores, nomes e equipes)', () => {
    expect(GIFT_SLOTS).toHaveLength(12);
    for (const slot of GIFT_SLOTS) {
      const catalog = GIFTS.find((item) => item.id === slot.visualId)!;
      expect(catalog).toBeDefined();
      expect(slot.defaultBlocks).toBe(catalog.amount);
      expect(slot.label).toBe(catalog.labels[slot.team]);
    }
    expect(GIFT_SLOTS.filter((slot) => slot.team === 'lula').map((slot) => slot.defaultBlocks)).toEqual([5, 10, 30, 100, 500, 1000]);
    expect(GIFT_SLOTS.filter((slot) => slot.team === 'bolsonaro').map((slot) => slot.defaultBlocks)).toEqual([5, 10, 30, 100, 500, 1000]);
  });
});

describe('LIKE e FOLLOW', () => {
  it('curtida válida concede +1 ao Lula', async () => {
    const { pipeline, engine } = await makeHarness();
    const outcome = await pipeline.handle(like({ count: 1 }), 'real', 'room1');
    expect(outcome.status).toBe('applied');
    expect(engine.getState().teams.lula.score).toBe(1);
    expect(engine.getState().teams.bolsonaro.score).toBe(0);
  });

  it('lote de curtidas usa a quantidade incremental e nunca o total acumulado da sala', async () => {
    const { pipeline, engine } = await makeHarness();
    await pipeline.handle(like({ count: 7, total: 9_000 }), 'real', 'room1');
    await pipeline.handle(like({ count: 3, total: 9_003 }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(10);
  });

  it('lote acima do limite é limitado, não multiplicado', async () => {
    const { pipeline, engine } = await makeHarness();
    await pipeline.handle(like({ count: 5_000 }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(100);
  });

  it('entrega duplicada da mesma mensagem de curtida não soma', async () => {
    const { pipeline, engine } = await makeHarness();
    const event = like({ count: 4 });
    expect((await pipeline.handle(event, 'real', 'room1')).status).toBe('applied');
    expect((await pipeline.handle({ ...event }, 'real', 'room1')).status).toBe('duplicate');
    expect(engine.getState().teams.lula.score).toBe(4);
  });

  it('contagem inválida é ignorada', async () => {
    const { pipeline, engine } = await makeHarness();
    expect((await pipeline.handle(like({ count: 0 }), 'real', 'room1')).status).toBe('ignored');
    expect((await pipeline.handle(like({ count: -3 }), 'real', 'room1')).status).toBe('ignored');
    expect(engine.getState().teams.lula.score).toBe(0);
  });

  it('novo seguidor concede +1 ao Bolsonaro uma única vez por usuário na sessão', async () => {
    const { pipeline, engine } = await makeHarness();
    expect((await pipeline.handle(follow({ userId: 'a' }), 'real', 'room1')).status).toBe('applied');
    expect((await pipeline.handle(follow({ userId: 'a' }), 'real', 'room1')).status).toBe('duplicate');
    expect((await pipeline.handle(follow({ userId: 'b' }), 'real', 'room1')).status).toBe('applied');
    expect(engine.getState().teams.bolsonaro.score).toBe(2);
    expect(engine.getState().teams.lula.score).toBe(0);
  });

  it('FOLLOW e SOCIAL da mesma ação não duplicam o bônus', async () => {
    const { pipeline, engine } = await makeHarness();
    await pipeline.handle(follow({ userId: 'x', via: 'follow' }), 'real', 'room1');
    await pipeline.handle(follow({ userId: 'x', via: 'social' }), 'real', 'room1');
    expect(engine.getState().teams.bolsonaro.score).toBe(1);
  });

  it('o mesmo usuário pode ser contado de novo em outra sessão LIVE', async () => {
    const { pipeline, engine } = await makeHarness();
    await pipeline.handle(follow({ userId: 'a' }), 'real', 'room1');
    await pipeline.handle(follow({ userId: 'a' }), 'real', 'room2');
    expect(engine.getState().teams.bolsonaro.score).toBe(2);
  });

  it('seguir sem identificador de usuário é ignorado (limitação registrada, nada inventado)', async () => {
    const { pipeline, engine } = await makeHarness();
    const outcome = await pipeline.handle(follow({ userId: '' }), 'real', 'room1');
    expect(outcome).toMatchObject({ status: 'ignored', reason: 'follow_without_user_id' });
    expect(engine.getState().teams.bolsonaro.score).toBe(0);
  });
});

describe('presentes: mapeamento por giftId', () => {
  it('todos os 12 mapeamentos pontuam o valor e a equipe corretos', async () => {
    const { pipeline, engine, registry } = await makeHarness();
    await mapAll(registry);
    let id = 1001;
    const expected = { lula: 0, bolsonaro: 0 };
    const events: Array<{ giftId?: string; team: string; amount: number }> = [];
    engine.on('increment', (event) => events.push(event));
    for (const slot of GIFT_SLOTS) {
      const outcome = await pipeline.handle(gift({ giftId: String(id), streakable: false, groupId: '', repeatCount: 1, giftName: `Nome real ${id}` }), 'real', 'room1');
      expect(outcome.status).toBe('applied');
      expected[slot.team] += slot.defaultBlocks;
      id += 1;
    }
    expect(expected).toEqual({ lula: 1645, bolsonaro: 1645 });
    expect(engine.getState().teams).toMatchObject({ lula: { score: 1645 }, bolsonaro: { score: 1645 } });
    expect(events.map((event) => event.giftId)).toEqual(GIFT_SLOTS.map((slot) => slot.visualId));
    expect(events.map((event) => event.amount)).toEqual(GIFT_SLOTS.map((slot) => slot.defaultBlocks));
  });

  it('exemplos do enunciado: rosa vermelha +5 Lula, dinossauro +10 Bolsonaro, coroa +1000 Lula', async () => {
    const { pipeline, engine, registry } = await makeHarness();
    await mapAll(registry);
    await pipeline.handle(gift({ giftId: '1001', streakable: false, groupId: '' }), 'real', 'r');
    await pipeline.handle(gift({ giftId: '1008', streakable: false, groupId: '' }), 'real', 'r');
    await pipeline.handle(gift({ giftId: '1006', streakable: false, groupId: '' }), 'real', 'r');
    expect(engine.getState().teams.lula.score).toBe(1005);
    expect(engine.getState().teams.bolsonaro.score).toBe(10);
  });

  it('presente desconhecido é registrado para configuração, mas não pontua', async () => {
    const { pipeline, engine, registry, store } = await makeHarness();
    const outcome = await pipeline.handle(gift({ giftId: '99999', giftName: 'Leão', coins: 29999, streakable: false, groupId: '' }), 'real', 'room1');
    expect(outcome).toEqual({ status: 'ignored', reason: 'unmapped_gift' });
    expect(engine.getState().teams.lula.score + engine.getState().teams.bolsonaro.score).toBe(0);
    expect(registry.known().find((entry) => entry.giftId === '99999')).toMatchObject({ name: 'Leão', coins: 29999, slotId: null });
    expect((await store.listGiftRegistry()).some((entry) => entry.giftId === '99999')).toBe(true);
  });

  it('nome parecido não associa: só o giftId conta', async () => {
    const { pipeline, engine, registry } = await makeHarness();
    await registry.assign('lula:impulso', { giftId: '5655', allowManual: true });
    const outcome = await pipeline.handle(gift({ giftId: '7777', giftName: 'Rosa vermelha', streakable: false, groupId: '' }), 'real', 'room1');
    expect(outcome).toMatchObject({ status: 'ignored', reason: 'unmapped_gift' });
    expect(engine.getState().teams.lula.score).toBe(0);
  });

  it('presente inativo não pontua; giftId malformado é rejeitado', async () => {
    const { pipeline, engine, registry } = await makeHarness();
    await registry.assign('lula:turbo', { giftId: '1234', allowManual: true });
    await registry.assign('lula:turbo', { active: false });
    expect(await pipeline.handle(gift({ giftId: '1234', streakable: false, groupId: '' }), 'real', 'room1'))
      .toMatchObject({ status: 'ignored', reason: 'inactive_gift' });
    expect(await pipeline.handle(gift({ giftId: 'rose; DROP', streakable: false, groupId: '' }), 'real', 'room1'))
      .toMatchObject({ status: 'ignored', reason: 'invalid_gift_id' });
    expect(engine.getState().teams.lula.score).toBe(0);
  });

  it('um giftId não pode apontar para dois slots', async () => {
    const { registry } = await makeHarness();
    await registry.assign('lula:impulso', { giftId: '5655', allowManual: true });
    await expect(registry.assign('bolsonaro:impulso', { giftId: '5655', allowManual: true })).rejects.toThrow(/já está associado/);
  });

  it('associação exige presente conhecido, salvo confirmação manual', async () => {
    const { registry } = await makeHarness();
    await expect(registry.assign('lula:impulso', { giftId: '4242' })).rejects.toThrow(/ainda não foi visto/);
    await registry.importCatalog([{ giftId: '4242', name: 'Rose', imageUrl: 'https://img/x.png', coins: 1 }]);
    const slot = await registry.assign('lula:impulso', { giftId: '4242' });
    expect(slot).toMatchObject({ giftId: '4242', giftName: 'Rose', giftCoins: 1, mapped: true });
  });

  it('valor de blocos configurável por presente', async () => {
    const { pipeline, engine, registry } = await makeHarness();
    await registry.assign('bolsonaro:turbo', { giftId: '2222', allowManual: true, blocks: 45 });
    await pipeline.handle(gift({ giftId: '2222', streakable: false, groupId: '' }), 'real', 'room1');
    expect(engine.getState().teams.bolsonaro.score).toBe(45);
  });
});

describe('combos', () => {
  async function roses() {
    const harness = await makeHarness();
    await harness.registry.assign('lula:impulso', { giftId: '5655', allowManual: true });
    return harness;
  }

  it('5 rosas em sequência concedem exatamente 25 blocos (não 5+10+15+20+25)', async () => {
    const { pipeline, engine } = await roses();
    for (let count = 1; count <= 5; count += 1) {
      await pipeline.handle(gift({ repeatCount: count, repeatEnd: false }), 'real', 'room1');
    }
    await pipeline.handle(gift({ repeatCount: 5, repeatEnd: true }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(25);
  });

  it('atualizações que pulam valores contam só o incremento', async () => {
    const { pipeline, engine } = await roses();
    for (const count of [1, 4, 9]) await pipeline.handle(gift({ repeatCount: count }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(9 * 5);
  });

  it('reenvio do fechamento do combo (mesma e outra mensagem) não duplica', async () => {
    const { pipeline, engine } = await roses();
    await pipeline.handle(gift({ repeatCount: 3 }), 'real', 'room1');
    const end = gift({ repeatCount: 3, repeatEnd: true });
    expect((await pipeline.handle(end, 'real', 'room1')).status).toBe('ignored');
    expect((await pipeline.handle({ ...end }, 'real', 'room1')).status).toBe('duplicate');
    expect(engine.getState().teams.lula.score).toBe(15);
  });

  it('reconexão durante o combo: reentrega de atualizações antigas e continuação somam 25', async () => {
    const { pipeline, engine } = await roses();
    const send = (count: number, end = false) => pipeline.handle(gift({ repeatCount: count, repeatEnd: end }), 'real', 'room1');
    await send(1); await send(2); await send(3);
    // conexão cai; ao voltar o TikTok reenvia estados anteriores com novos msgIds
    await send(2); await send(3);
    await send(4); await send(5); await send(5, true);
    expect(engine.getState().teams.lula.score).toBe(25);
  });

  it('atualizações perdidas durante a queda são recuperadas pelo fechamento', async () => {
    const { pipeline, engine } = await roses();
    await pipeline.handle(gift({ repeatCount: 2 }), 'real', 'room1');
    await pipeline.handle(gift({ repeatCount: 7, repeatEnd: true }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(35);
  });

  it('combos de usuários e grupos diferentes são independentes', async () => {
    const { pipeline, engine } = await roses();
    await pipeline.handle(gift({ userId: 'a', groupId: 'g1', repeatCount: 3 }), 'real', 'room1');
    await pipeline.handle(gift({ userId: 'b', groupId: 'g1', repeatCount: 2 }), 'real', 'room1');
    await pipeline.handle(gift({ userId: 'a', groupId: 'g2', repeatCount: 1 }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe((3 + 2 + 1) * 5);
  });

  it('sem groupId confiável: intermediários são ignorados e só o fechamento conta', async () => {
    const { pipeline, engine } = await roses();
    for (const count of [1, 2, 3]) {
      const outcome = await pipeline.handle(gift({ groupId: '', repeatCount: count }), 'real', 'room1');
      expect(outcome).toMatchObject({ status: 'ignored', reason: 'combo_intermediate_unreliable' });
    }
    await pipeline.handle(gift({ groupId: '', repeatCount: 3, repeatEnd: true }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(15);
  });

  it('presente sem sequência soma repeatCount × blocos uma única vez', async () => {
    const { pipeline, engine } = await roses();
    const event = gift({ streakable: false, groupId: '', repeatCount: 3 });
    await pipeline.handle(event, 'real', 'room1');
    await pipeline.handle({ ...event }, 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(15);
  });

  it('partes do combo recebidas durante o resultado não são creditadas na rodada seguinte', async () => {
    const { pipeline, engine, game } = await roses();
    await game.updateConfig({ target: 10 });
    await pipeline.handle(gift({ userId: 'z', groupId: 'gz', streakable: false, repeatCount: 1 }), 'real', 'room1');
    await pipeline.handle(gift({ userId: 'z', groupId: 'gz', streakable: false, repeatCount: 1 }), 'real', 'room1');
    expect(engine.getState().phase).toBe('result');
    // combo novo chega durante a tela de resultado
    const during = await pipeline.handle(gift({ userId: 'q', groupId: 'gq', repeatCount: 4 }), 'real', 'room1');
    expect(during).toMatchObject({ status: 'ignored', reason: 'result_phase' });
    await game.resetRound();
    // fechamento do mesmo combo já na nova rodada: nada além do que passou após o reinício
    await pipeline.handle(gift({ userId: 'q', groupId: 'gq', repeatCount: 4, repeatEnd: true }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(0);
  });
});

describe('fases, simultaneidade e separação real/teste', () => {
  it('eventos durante pausa ou resultado são registrados e ignorados', async () => {
    const { pipeline, engine, game, store } = await makeHarness();
    await game.pause();
    expect(await pipeline.handle(like({ count: 5 }), 'real', 'room1')).toMatchObject({ status: 'ignored', reason: 'paused' });
    await game.resume();
    expect(engine.getState().teams.lula.score).toBe(0);
    const stats = await store.stats();
    expect(stats.find((row) => row.kind === 'like' && row.status === 'ignored')?.events).toBe(1);
  });

  it('Lula e Bolsonaro recebem eventos simultâneos sem interferência', async () => {
    const { pipeline, engine, registry } = await makeHarness();
    await registry.assign('lula:escudo', { giftId: '1', allowManual: true });
    await registry.assign('bolsonaro:escudo', { giftId: '2', allowManual: true });
    const tasks = [];
    for (let index = 0; index < 25; index += 1) {
      tasks.push(pipeline.handle(like({ userId: `l${index}` }), 'real', 'room1'));
      tasks.push(pipeline.handle(follow({ userId: `f${index}` }), 'real', 'room1'));
      tasks.push(pipeline.handle(gift({ giftId: '1', userId: `a${index}`, streakable: false, groupId: '' }), 'real', 'room1'));
      tasks.push(pipeline.handle(gift({ giftId: '2', userId: `b${index}`, streakable: false, groupId: '' }), 'real', 'room1'));
    }
    await Promise.all(tasks);
    const { lula, bolsonaro } = engine.getState().teams;
    // meta 2000: 25 likes + 25 escudos (100) = 2525 ⇒ a rodada termina uma única vez
    expect(engine.getState().phase).toBe('result');
    expect(engine.getState().winner === 'lula' || engine.getState().winner === 'bolsonaro').toBe(true);
    expect(lula.wins + bolsonaro.wins).toBe(1);
    expect(Math.max(lula.score, bolsonaro.score)).toBe(2000);
  });

  it('muitos presentes simultâneos encerram a rodada exatamente uma vez', async () => {
    const { pipeline, engine, registry, game } = await makeHarness({ target: 500 });
    await registry.assign('lula:ultra-turbo', { giftId: '10', allowManual: true });
    await registry.assign('bolsonaro:ultra-turbo', { giftId: '11', allowManual: true });
    let ended = 0;
    game.on('roundEnded', () => { ended += 1; });
    await Promise.all(Array.from({ length: 30 }, (_, index) =>
      pipeline.handle(gift({ giftId: index % 2 ? '10' : '11', userId: `u${index}`, streakable: false, groupId: '' }), 'real', 'room1')));
    expect(ended).toBe(1);
    const { lula, bolsonaro } = engine.getState().teams;
    expect(lula.wins + bolsonaro.wins).toBe(1);
  });

  it('eventos de teste ficam separados dos reais nas estatísticas e carregam origem TESTE', async () => {
    const { pipeline, engine, store } = await makeHarness();
    const seen: string[] = [];
    engine.on('increment', (event) => seen.push(event.origin));
    await pipeline.handle(like({ count: 3 }), 'real', 'room1');
    await pipeline.handle(like({ count: 2 }), 'test', 'test-session');
    expect(seen).toEqual(['real', 'test']);
    const stats = await store.stats();
    const real = stats.filter((row) => row.origin === 'real').reduce((sum, row) => sum + row.points, 0);
    const test = stats.filter((row) => row.origin === 'test').reduce((sum, row) => sum + row.points, 0);
    expect(real).toBe(3);
    expect(test).toBe(2);
    expect((await store.recentEvents('real', 10)).every((row) => row.origin === 'real')).toBe(true);
  });

  it('teste de presente por slot funciona sem giftId real mapeado', async () => {
    const { pipeline, engine } = await makeHarness();
    await pipeline.handle(gift({ giftId: '', slotId: 'bolsonaro:recuperacao', streakable: false, groupId: '' }), 'test', 'test-session');
    expect(engine.getState().teams.bolsonaro.score).toBe(500);
  });
});

describe('concorrência na entrega em rajada (regressão)', () => {
  it('atualizações de combo disparadas sem aguardar continuam somando 25 para 5 rosas', async () => {
    const { pipeline, engine, registry } = await makeHarness();
    await registry.assign('lula:impulso', { giftId: '5655', allowManual: true });
    const pending = [1, 2, 3, 4, 5].map((count) => pipeline.handle(gift({ repeatCount: count }), 'real', 'room1'));
    pending.push(pipeline.handle(gift({ repeatCount: 5, repeatEnd: true }), 'real', 'room1'));
    await Promise.all(pending);
    expect(engine.getState().teams.lula.score).toBe(25);
  });

  it('o mesmo seguidor entregue em paralelo (follow + social) conta uma vez', async () => {
    const { pipeline, engine } = await makeHarness();
    await Promise.all([
      pipeline.handle(follow({ userId: 'p', via: 'follow' }), 'real', 'room1'),
      pipeline.handle(follow({ userId: 'p', via: 'social' }), 'real', 'room1'),
    ]);
    expect(engine.getState().teams.bolsonaro.score).toBe(1);
  });
});

describe('curtidas por bloco (padrão do jogo: 120)', () => {
  it('120 curtidas valem 1 bloco; o resto fica acumulado para o próximo', async () => {
    const { pipeline, engine } = await makeHarness({ likesPerBlock: 120 });
    const events: Array<{ amount: number; count?: number }> = [];
    engine.on('increment', (event) => events.push(event));
    expect(await pipeline.handle(like({ count: 100 }), 'real', 'room1')).toMatchObject({ status: 'accumulated', pending: 100, perBlock: 120 });
    expect(engine.getState().teams.lula.score).toBe(0);
    await pipeline.handle(like({ count: 50 }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(1);
    expect(engine.getState().pendingLikes).toBe(30);
    expect(events).toEqual([expect.objectContaining({ amount: 1, count: 50, kind: 'like', team: 'lula' })]);
  });

  it('lote grande converte vários blocos de uma vez', async () => {
    const { pipeline, engine } = await makeHarness({ likesPerBlock: 120 });
    for (let index = 0; index < 5; index += 1) await pipeline.handle(like({ count: 100 }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(4); // 500 curtidas = 4 blocos + 20
    expect(engine.getState().pendingLikes).toBe(20);
  });

  it('duplicata não soma curtidas acumuladas; nova rodada zera o acumulado', async () => {
    const { pipeline, engine, game } = await makeHarness({ likesPerBlock: 120 });
    const event = like({ count: 90 });
    await pipeline.handle(event, 'real', 'room1');
    await pipeline.handle({ ...event }, 'real', 'room1');
    expect(engine.getState().pendingLikes).toBe(90);
    await game.resetRound();
    expect(engine.getState().pendingLikes).toBe(0);
  });

  it('curtidas não contam durante pausa e o valor é configurável', async () => {
    const { pipeline, engine, game } = await makeHarness({ likesPerBlock: 120 });
    await game.pause();
    await pipeline.handle(like({ count: 100 }), 'real', 'room1');
    await game.resume();
    expect(engine.getState().pendingLikes).toBe(0);
    await game.updateConfig({ likesPerBlock: 10 });
    await pipeline.handle(like({ count: 25 }), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(2);
    expect(engine.getState().pendingLikes).toBe(5);
  });
});

describe('comentários "13" / "22" (padrão: 20 = 1 bloco)', () => {
  let seq = 0;
  const comment = (text: string, userId = `u${++seq}`, at = Date.now() + seq * 10_000): DiagnosticLiveEvent =>
    ({ type: 'comment', msgId: `c${++seq}`, roomId: 'room1', userId, userName: 'Ana', at, text });

  it('reconhece só o número da equipe', () => {
    expect(commentVote('13')).toBe('lula');
    expect(commentVote(' #22!! ')).toBe('bolsonaro');
    for (const text of ['1322', '13 13', 'vai 13', '22 é melhor', '113', '', 'treze']) expect(commentVote(text)).toBeNull();
  });

  it('20 comentários "13" de pessoas diferentes derrubam 1 bloco para o 13; "22" vai para o 22', async () => {
    const { pipeline, engine } = await makeHarness();
    engine.updateConfig({ commentsPerBlock: 20 });
    for (let index = 0; index < 19; index += 1) await pipeline.handle(comment('13'), 'real', 'room1');
    expect(engine.getState().teams.lula.score).toBe(0);
    expect(engine.getState().pendingComments.lula).toBe(19);
    const last = await pipeline.handle(comment('13'), 'real', 'room1');
    expect(last).toMatchObject({ status: 'applied', event: { team: 'lula', amount: 1, kind: 'comment', effect: 'comment' } });
    for (let index = 0; index < 25; index += 1) await pipeline.handle(comment('22'), 'real', 'room1');
    expect(engine.getState().teams).toMatchObject({ lula: { score: 1 }, bolsonaro: { score: 1 } });
    expect(engine.getState().pendingComments).toEqual({ lula: 0, bolsonaro: 5 });
  });

  it('comentário comum é ignorado e não é gravado', async () => {
    const { pipeline, store } = await makeHarness();
    expect(await pipeline.handle(comment('bom dia'), 'real', 'room1')).toMatchObject({ status: 'ignored', reason: 'not_a_vote' });
    expect(await store.stats()).toEqual([]);
  });

  it('anti-spam: a mesma pessoa só conta 1 comentário a cada 3 s; mensagem repetida não conta', async () => {
    const { pipeline, engine } = await makeHarness();
    const t = Date.now();
    await pipeline.handle(comment('13', 'spammer', t), 'real', 'room1');
    expect(await pipeline.handle(comment('13', 'spammer', t + 500), 'real', 'room1')).toMatchObject({ status: 'ignored', reason: 'comment_rate_limited' });
    await pipeline.handle(comment('13', 'spammer', t + 3_500), 'real', 'room1');
    const repeated = comment('13', 'other', t + 10_000);
    await pipeline.handle(repeated, 'real', 'room1');
    await pipeline.handle({ ...repeated }, 'real', 'room1');
    expect(engine.getState().pendingComments.lula).toBe(3);
  });

  it('desligado no painel: nenhum comentário conta; nova rodada zera o acumulado', async () => {
    const { pipeline, engine, game } = await makeHarness();
    await game.updateConfig({ commentVotes: false });
    await pipeline.handle(comment('22'), 'real', 'room1');
    expect(engine.getState().pendingComments.bolsonaro).toBe(0);
    await game.updateConfig({ commentVotes: true });
    await pipeline.handle(comment('22'), 'real', 'room1');
    expect(engine.getState().pendingComments.bolsonaro).toBe(1);
    await game.resetRound();
    expect(engine.getState().pendingComments).toEqual({ lula: 0, bolsonaro: 0 });
  });
});
