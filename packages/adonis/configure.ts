import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/collaboration` — auto-wires the package:
 *
 * 1. registers the collaboration service provider in `adonisrc.ts`;
 * 2. publishes `config/collaboration.ts` (engine, path, redis, authorize,
 *    storage).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/collaboration/collaboration_provider');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/collaboration.stub', {});
}
