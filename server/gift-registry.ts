import type { GiftMappingRow, GiftRegistryEntry, Store } from './store/types.js';
import { GIFT_SEED, GIFT_SEED_VERSION, KNOWN_UNMAPPED, type SeedMapping } from './gift-seed.js';
import { GIFT_SLOTS, getSlot, type GiftSlot } from './gift-slots.js';

export interface SlotView extends GiftSlot {
  giftId: string | null;
  blocks: number;
  active: boolean;
  /** Metadados do registro (nome/imagem/moedas reais do TikTok), quando conhecidos. */
  giftName: string | null;
  giftImageUrl: string | null;
  giftCoins: number | null;
  mapped: boolean;
}

export class GiftMappingError extends Error {}

/** Giftids do TikTok são numéricos. Rejeitamos qualquer outra coisa em eventos reais. */
export const GIFT_ID_PATTERN = /^\d{1,20}$/;

export class GiftRegistry {
  private mappings = new Map<string, GiftMappingRow>();
  private byGiftId = new Map<string, string>();
  private registry = new Map<string, GiftRegistryEntry>();

  constructor(private readonly store: Store) {}

  async init(): Promise<void> {
    const rows = await this.store.listGiftMappings();
    for (const slot of GIFT_SLOTS) {
      if (rows.some((row) => row.slotId === slot.slotId)) continue;
      await this.store.saveGiftMapping({
        slotId: slot.slotId,
        giftId: null,
        blocks: slot.defaultBlocks,
        active: true,
        boundName: null,
        boundCoins: null,
        updatedAt: Date.now(),
      });
    }
    await this.reload();
  }

  async reload(): Promise<void> {
    this.mappings.clear();
    this.byGiftId.clear();
    for (const row of await this.store.listGiftMappings()) {
      this.mappings.set(row.slotId, row);
      if (row.giftId) this.byGiftId.set(row.giftId, row.slotId);
    }
    this.registry.clear();
    for (const entry of await this.store.listGiftRegistry()) this.registry.set(entry.giftId, entry);
  }

  /**
   * Aplica o mapeamento inicial informado pelo operador, uma única vez por banco e somente
   * em slots vazios. Depois disso o painel é a fonte da verdade (nada é sobrescrito).
   */
  async applySeed(seed: SeedMapping[] = GIFT_SEED): Promise<{ applied: string[]; skipped: string[]; alreadyApplied: boolean }> {
    const key = `gift.seed.v${GIFT_SEED_VERSION}`;
    if (await this.store.getSetting<boolean>(key)) return { applied: [], skipped: [], alreadyApplied: true };
    const applied: string[] = [];
    const skipped: string[] = [];
    await this.store.upsertGiftRegistry([
      ...seed.map((item) => ({ giftId: item.giftId, name: item.name, imageUrl: null, coins: null, source: 'manual' as const })),
      ...KNOWN_UNMAPPED.map((item) => ({ giftId: item.giftId, name: item.name, imageUrl: null, coins: null, source: 'manual' as const })),
    ]);
    await this.reload();
    for (const item of seed) {
      const current = this.mappings.get(item.slotId);
      if (current?.giftId || this.byGiftId.has(item.giftId)) {
        skipped.push(item.slotId);
        continue;
      }
      await this.assign(item.slotId, { giftId: item.giftId, allowManual: true });
      applied.push(item.slotId);
    }
    await this.store.setSetting(key, true);
    return { applied, skipped, alreadyApplied: false };
  }

  /** Procura pelo giftId real. Nunca por nome. */
  resolve(giftId: string): { slot: GiftSlot; mapping: GiftMappingRow } | null {
    const slotId = this.byGiftId.get(giftId);
    if (!slotId) return null;
    const slot = getSlot(slotId);
    const mapping = this.mappings.get(slotId);
    return slot && mapping ? { slot, mapping } : null;
  }

  /** Simulação: resolve o slot diretamente, sem depender de um giftId real mapeado. */
  resolveSlot(slotId: string): { slot: GiftSlot; mapping: GiftMappingRow } | null {
    const slot = getSlot(slotId);
    if (!slot) return null;
    const mapping = this.mappings.get(slotId) ?? {
      slotId, giftId: null, blocks: slot.defaultBlocks, active: true, boundName: null, boundCoins: null, updatedAt: 0,
    };
    return { slot, mapping };
  }

  async noteSeen(giftId: string, info: { name?: string | null; imageUrl?: string | null; coins?: number | null }): Promise<boolean> {
    const known = this.registry.has(giftId);
    await this.store.touchGift(giftId, info);
    const current = this.registry.get(giftId);
    const now = Date.now();
    this.registry.set(giftId, {
      giftId,
      name: info.name ?? current?.name ?? null,
      imageUrl: info.imageUrl ?? current?.imageUrl ?? null,
      coins: info.coins ?? current?.coins ?? null,
      source: current?.source ?? 'event',
      firstSeenAt: current?.firstSeenAt ?? now,
      lastSeenAt: now,
      seenCount: (current?.seenCount ?? 0) + 1,
    });
    return !known;
  }

  async importCatalog(gifts: Array<{ giftId: string; name: string | null; imageUrl: string | null; coins: number | null }>): Promise<number> {
    const valid = gifts.filter((gift) => GIFT_ID_PATTERN.test(gift.giftId));
    await this.store.upsertGiftRegistry(valid.map((gift) => ({ ...gift, source: 'catalog' as const })));
    for (const entry of await this.store.listGiftRegistry()) this.registry.set(entry.giftId, entry);
    return valid.length;
  }

  /**
   * Associa (ou desassocia) um giftId real a um dos 12 slots.
   * Exige que o presente exista no registro, a não ser com `allowManual` (digitado pelo
   * administrador). Um mesmo giftId nunca aponta para dois slots.
   */
  async assign(slotId: string, patch: { giftId?: string | null; blocks?: number; active?: boolean; allowManual?: boolean }): Promise<SlotView> {
    const slot = getSlot(slotId);
    if (!slot) throw new GiftMappingError(`Slot desconhecido: ${slotId}`);
    const current = this.mappings.get(slotId) ?? {
      slotId, giftId: null, blocks: slot.defaultBlocks, active: true, boundName: null, boundCoins: null, updatedAt: 0,
    };
    const next: GiftMappingRow = { ...current };

    if (patch.giftId !== undefined) {
      if (patch.giftId === null) {
        next.giftId = null;
        next.boundName = null;
        next.boundCoins = null;
      } else {
        const giftId = patch.giftId.trim();
        if (!GIFT_ID_PATTERN.test(giftId)) throw new GiftMappingError('O giftId do TikTok deve ser numérico.');
        const owner = this.byGiftId.get(giftId);
        if (owner && owner !== slotId) throw new GiftMappingError(`O giftId ${giftId} já está associado ao slot ${owner}.`);
        let known = this.registry.get(giftId);
        if (!known) {
          if (!patch.allowManual) throw new GiftMappingError(`O giftId ${giftId} ainda não foi visto. Atualize a lista de presentes ou confirme a associação manual.`);
          await this.store.upsertGiftRegistry([{ giftId, name: null, imageUrl: null, coins: null, source: 'manual' }]);
          known = (await this.store.listGiftRegistry()).find((entry) => entry.giftId === giftId);
          if (known) this.registry.set(giftId, known);
        }
        next.giftId = giftId;
        next.boundName = known?.name ?? null;
        next.boundCoins = known?.coins ?? null;
      }
    }
    if (patch.blocks !== undefined) {
      if (!Number.isInteger(patch.blocks) || patch.blocks < 1 || patch.blocks > 5000) throw new GiftMappingError('Blocos devem ser um inteiro entre 1 e 5000.');
      next.blocks = patch.blocks;
    }
    if (patch.active !== undefined) next.active = patch.active;

    await this.store.saveGiftMapping(next);
    await this.reload();
    return this.view().find((entry) => entry.slotId === slotId)!;
  }

  view(): SlotView[] {
    return GIFT_SLOTS.map((slot) => {
      const mapping = this.mappings.get(slot.slotId);
      const entry = mapping?.giftId ? this.registry.get(mapping.giftId) : undefined;
      return {
        ...slot,
        giftId: mapping?.giftId ?? null,
        blocks: mapping?.blocks ?? slot.defaultBlocks,
        active: mapping?.active ?? true,
        giftName: entry?.name ?? mapping?.boundName ?? null,
        giftImageUrl: entry?.imageUrl ?? null,
        giftCoins: entry?.coins ?? mapping?.boundCoins ?? null,
        mapped: Boolean(mapping?.giftId),
      };
    });
  }

  known(): Array<GiftRegistryEntry & { slotId: string | null }> {
    return [...this.registry.values()].map((entry) => ({ ...entry, slotId: this.byGiftId.get(entry.giftId) ?? null }));
  }
}
