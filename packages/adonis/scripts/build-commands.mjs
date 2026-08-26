/**
 * Gera dist/commands/commands.json — mesmo formato do `adonis-kit index`
 * (não publicado no npm), lendo os estáticos das classes compiladas.
 *
 * Formato: { commands: [{ commandName, description, help, namespace,
 * aliases, flags, args, options, filePath }], version: 1 }
 */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const commandsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'commands',
);

const files = (await readdir(commandsDir)).filter(
  (file) => file.endsWith('.js') && !['main.js'].includes(file),
);

const commands = [];

for (const filePath of files.sort()) {
  const module = await import(path.join(commandsDir, filePath));
  const Command = module.default;
  if (!Command?.commandName) continue;

  const namespace = Command.commandName.includes(':')
    ? Command.commandName.split(':')[0]
    : undefined;

  commands.push({
    commandName: Command.commandName,
    description: Command.description ?? '',
    help: Command.help ?? '',
    namespace,
    aliases: Command.aliases ?? [],
    flags: Command.flags ?? [],
    args: Command.args ?? [],
    options: Command.options ?? {},
    filePath,
  });
}

const output = path.join(commandsDir, 'commands.json');
await writeFile(output, `${JSON.stringify({ commands, version: 1 })}\n`);
console.log(`commands.json gerado com ${commands.length} comando(s) → ${output}`);
