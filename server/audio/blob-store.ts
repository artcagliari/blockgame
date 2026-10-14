import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../store/types.js';

/** Onde ficam os bytes dos áudios. Metadados ficam sempre no Store (PostgreSQL). */
export interface AudioBlobStore {
  readonly kind: 'database' | 'filesystem';
  put(id: string, data: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | null>;
  delete(id: string): Promise<void>;
}

const ID = /^[a-f0-9-]{36}$/;

/** Padrão: binário no próprio PostgreSQL (persiste entre deploys sem volume). */
export class DatabaseBlobStore implements AudioBlobStore {
  readonly kind = 'database' as const;
  constructor(private readonly store: Store) {}
  put(id: string, data: Buffer) { return this.store.putAudioBlob(id, data); }
  get(id: string) { return this.store.getAudioBlob(id); }
  async delete() { /* removido junto com os metadados em deleteAudioClip */ }
}

/** Alternativa: diretório persistente (ex.: volume do Railway montado em AUDIO_STORAGE_DIR). */
export class FilesystemBlobStore implements AudioBlobStore {
  readonly kind = 'filesystem' as const;
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new Error('Identificador de áudio inválido.');
    return path.join(this.dir, `${id}.bin`);
  }

  async put(id: string, data: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(id);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, data);
    await rename(temp, target);
  }

  async get(id: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
