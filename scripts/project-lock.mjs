import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Advisory single-writer lock shared by the CLI and compact MCP server. */
export class ProjectLock {
  constructor(stateDir) { this.path = join(stateDir, '.writer-lock'); this.stateDir = stateDir; }
  readOwner() {
    try {
      const raw = readFileSync(join(this.path, 'owner.json'), 'utf8');
      if (Buffer.byteLength(raw) > 4096) return null;
      const value = JSON.parse(raw);
      return Number.isSafeInteger(value.pid) && typeof value.id === 'string' ? value : null;
    } catch { return null; }
  }
  acquire(label = 'mutation') {
    mkdirSync(this.stateDir, {recursive: true, mode: 0o700});
    try { mkdirSync(this.path, {mode: 0o700}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = this.readOwner();
      throw new Error(`Project writer is busy${owner ? ` (${owner.label}, pid ${owner.pid})` : ''}. Wait for the job or cancel it. A crashed writer leaves a lock for explicit inspection.`);
    }
    const owner = {id: randomUUID(), pid: process.pid, label, created_at: new Date().toISOString()};
    try { writeFileSync(join(this.path, 'owner.json'), JSON.stringify(owner), {mode: 0o600, flag: 'wx'}); }
    catch (error) { rmSync(this.path, {recursive: true, force: true}); throw error; }
    let released = false;
    return () => {
      if (released) return;
      if (this.readOwner()?.id !== owner.id) throw new Error('Project lock ownership changed; refusing to remove another writer lock.');
      rmSync(this.path, {recursive: true}); released = true;
    };
  }
  async withLock(label, action) { const release = this.acquire(label); try { return await action(); } finally { release(); } }
}
