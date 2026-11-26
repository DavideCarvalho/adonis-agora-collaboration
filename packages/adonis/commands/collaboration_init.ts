import { BaseCommand, flags } from '@adonisjs/core/ace';
import {
  outdatedPartyKitWorkerMessage,
  partyKitWorkerStubStatus,
} from '../src/drivers/partykit/worker_stub.js';
import { assertSchemaName, lucidStorageOf } from '../src/storage/lucid_storage.js';
import { stubsRoot } from '../stubs/main.js';

/**
 * `node ace collaboration:init`
 *
 * Scaffolds the HTTP + edge layer of the collaboration package:
 *  - base directory for document definitions (scanned by the codegen hook);
 *  - migrations when a database is configured (storage-backed installs);
 *  - PartyKit worker (when engine = partykit).
 *
 * REST endpoints are registered automatically by the service provider —
 * set `routes.enabled: false` in config and call `collaborationRoutes()`
 * in `start/routes.ts` to control middleware yourself.
 *
 * `config/collaboration.ts` and the provider are published by
 * `node ace configure @adonis-agora/collaboration`.
 */
export default class CollaborationInit extends BaseCommand {
  static override commandName = 'collaboration:init';
  static override description =
    'Scaffold base directories, migrations and (optionally) the PartyKit worker';
  static override options = { startApp: true };

  @flags.string({
    description: 'Sync engine (yjs | automerge | partykit) — defaults to the one in config',
  })
  declare engine?: string;

  @flags.string({
    description:
      'Postgres schema for the tables — defaults to `schema` of lucidStorage() in config',
  })
  declare schema?: string;

  @flags.boolean({
    description:
      'Overwrite the generated PartyKit worker (partykit-worker/) — use it to upgrade an outdated worker',
  })
  declare force?: boolean;

  override async run(): Promise<void> {
    const appConfig = this.app.config.get<{
      engine?: string;
      partykit?: { roomHost: string };
      storage?: unknown;
    }>('collaboration', {});
    const schema = this.schema ?? lucidStorageOf(appConfig.storage)?.schema;
    if (schema !== undefined) assertSchemaName(schema);

    const resolvedEngine = this.engine ?? appConfig.engine ?? 'yjs';
    const hasDatabase = this.app.config.has('database');
    const codemods = await this.createCodemods();

    // 1. Base documents directory (scanned by the codegen init hook).
    await codemods.makeUsingStub(stubsRoot, 'collaboration/documents_dir.stub', {});
    this.logger.action('create app/collaboration/documents/').succeeded();

    // 2. Base migrations (when a database is configured).
    if (hasDatabase) {
      const prefix = Date.now();
      const tables = ['collab_documents', 'collab_versions', 'collab_comments'] as const;
      for (const [index, tableName] of tables.entries()) {
        await codemods.makeUsingStub(stubsRoot, `collaboration/migrations/${tableName}.stub`, {
          migration: {
            tableName,
            schema: schema ?? '',
            fileName: `${prefix}_${index}_create_${tableName}_table.ts`,
          },
        });
        this.logger.action(`create migration ${tableName}`).succeeded();
      }
    }

    // 3. PartyKit worker.
    if (resolvedEngine === 'partykit') {
      if (!appConfig.partykit?.roomHost) {
        this.logger.warning(
          'engine=partykit without config.partykit.roomHost — the driver will fail at runtime until configured',
        );
      }
      const workerPath = this.app.makePath('partykit-worker', 'party.ts');
      const status = await partyKitWorkerStubStatus(workerPath);
      // Only the worker is overwritten under --force: re-running the other
      // stubs must never clobber files the app has edited.
      codemods.overwriteExisting = this.force === true;
      await codemods.makeUsingStub(stubsRoot, 'partykit/worker/party.ts.stub', {});
      await codemods.makeUsingStub(stubsRoot, 'partykit/worker/package.json.stub', {});
      await codemods.makeUsingStub(stubsRoot, 'partykit/worker/partykit.toml.stub', {
        partykitWorkerName: this.app.appName ?? 'collab-worker',
        adonisBaseUrl: process.env.APP_URL ?? 'http://localhost:3333',
      });
      codemods.overwriteExisting = false;
      if (status === 'outdated' && this.force !== true) {
        this.logger.warning(outdatedPartyKitWorkerMessage('partykit-worker/party.ts'));
      }
      this.logger.info(
        [
          '',
          'PartyKit worker generated at partykit-worker/',
          '  1. cd partykit-worker && npm install',
          '  2. npx partykit secret put COLLAB_JWT_SECRET   # same value as config.partykit.jwtSecret',
          '     (no COLLAB_WORKER_SECRET needed: it is derived from COLLAB_JWT_SECRET)',
          '  3. npx partykit dev   # local',
          '  4. npx partykit deploy # production',
          '',
        ].join('\n'),
      );
    }

    this.logger.success(
      [
        'Collaboration initialized.',
        'REST endpoints are registered automatically by the provider (disable with routes.enabled=false).',
        'Next step: node ace make:collab-document <name>',
      ].join(' '),
    );
  }
}
