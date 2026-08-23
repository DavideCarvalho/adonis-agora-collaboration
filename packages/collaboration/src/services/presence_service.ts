import { Redis } from 'ioredis';

/**
 * Presença cross-instance da colaboração.
 *
 * Mesma filosofia do @adonisjs/transmit: cada instância conhece as conexões
 * LOCAIS (em memória) e propaga eventos via Redis pub/sub pra que qualquer
 * instância enxergue quem está online no documento inteiro — não só na
 * instância que recebeu a conexão.
 *
 * Canal: `collab:presence` (payload identifica o docName).
 *  - heartbeat local → publish de join/leave;
 *  - subscriber atualiza o mapa agregado e notifica os callbacks.
 */

export interface PresenceMember {
  userId: string;
  name?: string;
  avatarUrl?: string | null;
  /** Instância que segura a conexão (id do processo). */
  instanceId: string;
}

type PresenceListener = (docName: string, members: PresenceMember[]) => void;

interface PresenceMessage {
  kind: 'join' | 'leave';
  docName: string;
  member?: PresenceMember;
  userId?: string;
  instanceId?: string;
}

export class PresenceService {
  private publisher?: Redis;
  private subscriber?: Redis;
  private localMembers = new Map<string, Map<string, PresenceMember>>();
  private remoteMembers = new Map<string, Map<string, PresenceMember>>();
  private listeners = new Set<PresenceListener>();
  private instanceId = `${process.pid}-${randomHex(4)}`;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(redisUrl?: string) {
    if (redisUrl) {
      this.publisher = new Redis(redisUrl);
      this.subscriber = new Redis(redisUrl);
      void this.subscriber.subscribe('collab:presence');
      this.subscriber.on('message', (_channel: string, message: string) => {
        this.handleRemoteMessage(JSON.parse(message) as PresenceMessage);
      });
      this.heartbeatTimer = setInterval(() => this.publishLocalHeartbeats(), 30_000);
    }
  }

  /** Registra uma conexão local num documento. */
  async join(docName: string, member: Omit<PresenceMember, 'instanceId'>): Promise<void> {
    if (!this.localMembers.has(docName)) {
      this.localMembers.set(docName, new Map());
    }
    const full = { ...member, instanceId: this.instanceId };
    this.localMembers.get(docName)!.set(member.userId, full);
    await this.publish({ kind: 'join', docName, member: full });
    this.notify(docName);
  }

  async leave(docName: string, userId: string): Promise<void> {
    const members = this.localMembers.get(docName);
    members?.delete(userId);
    await this.publish({ kind: 'leave', docName, userId, instanceId: this.instanceId });
    this.notify(docName);
  }

  /** Membros conhecidos de um documento (locais + remotos via pub/sub). */
  list(docName: string): PresenceMember[] {
    const deduped = new Map<string, PresenceMember>();
    for (const member of this.remoteMembers.get(docName)?.values() ?? []) {
      deduped.set(member.userId, member);
    }
    // Local ganha do remoto (é a fonte mais fresca).
    for (const member of this.localMap(docName).values()) {
      deduped.set(member.userId, member);
    }
    return [...deduped.values()];
  }

  onPresenceChange(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.publisher) await this.publisher.quit();
    if (this.subscriber) await this.subscriber.quit();
  }

  /* ───────────────────────── internals ───────────────────────── */

  private localMap(docName: string): Map<string, PresenceMember> {
    return this.localMembers.get(docName) ?? new Map();
  }

  private async publish(message: PresenceMessage): Promise<void> {
    if (!this.publisher) return;
    await this.publisher.publish('collab:presence', JSON.stringify(message));
  }

  private async publishLocalHeartbeats(): Promise<void> {
    for (const [docName, members] of this.localMembers) {
      for (const member of members.values()) {
        await this.publish({ kind: 'join', docName, member });
      }
    }
  }

  private handleRemoteMessage(message: PresenceMessage): void {
    if (!this.remoteMembers.has(message.docName)) {
      this.remoteMembers.set(message.docName, new Map());
    }
    const byUser = this.remoteMembers.get(message.docName)!;

    if (message.kind === 'join' && message.member) {
      byUser.set(message.member.userId, message.member);
    } else if (message.kind === 'leave' && message.userId) {
      // Só remove se veio da mesma instância que registrou.
      const current = byUser.get(message.userId);
      if (!current || current.instanceId === message.instanceId) {
        byUser.delete(message.userId);
      }
    }

    this.notify(message.docName);
  }

  private notify(docName: string): void {
    for (const listener of this.listeners) {
      listener(docName, this.list(docName));
    }
  }
}

function randomHex(bytes: number): string {
  return Array.from({ length: bytes }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
