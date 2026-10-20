import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SettingsSchema, type Settings } from '../shared/types';
import { writeJson } from './files';

export class Preferences {
  constructor(readonly directory: string) {}
  async get(): Promise<Settings> {
    try {
      return SettingsSchema.parse(
        JSON.parse(await fs.readFile(path.join(this.directory, 'settings.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return SettingsSchema.parse({});
      throw error;
    }
  }
  async save(update: Partial<Settings>): Promise<Settings> {
    const value = SettingsSchema.parse({ ...(await this.get()), ...update });
    await writeJson(path.join(this.directory, 'settings.json'), value);
    return value;
  }
  async session(root: string, key: string): Promise<string | undefined> {
    return (await this.local())[root]?.sessions?.[key];
  }
  async setSession(root: string, key: string, id: string) {
    const data = await this.local();
    data[root] ??= {};
    data[root].sessions ??= {};
    data[root].sessions[key] = id;
    await writeJson(path.join(this.directory, 'local.json'), data);
  }
  async environment(root: string): Promise<Record<string, string>> {
    return (await this.local())[root]?.env ?? {};
  }
  async setEnvironment(root: string, env: Record<string, string>) {
    const data = await this.local();
    data[root] ??= {};
    data[root].env = env;
    await writeJson(path.join(this.directory, 'local.json'), data);
  }
  private async local(): Promise<
    Record<string, { sessions?: Record<string, string>; env?: Record<string, string> }>
  > {
    try {
      return JSON.parse(await fs.readFile(path.join(this.directory, 'local.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}
