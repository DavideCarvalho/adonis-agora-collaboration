import { readFile } from 'node:fs/promises';

/**
 * Ace commands barrel — same pattern as @adonisjs/lucid. The Adonis kernel
 * calls getMetaData()/getCommand() through the "./commands" export listed in
 * the adonisrc.ts `commands` array.
 */

interface CommandMeta {
  commandName: string;
  filePath: string;
  [key: string]: unknown;
}

let commandsMetaData: CommandMeta[] | undefined;

export async function getMetaData(): Promise<CommandMeta[]> {
  if (commandsMetaData) {
    return commandsMetaData;
  }

  const commandsIndex = await readFile(new URL('./commands.json', import.meta.url), 'utf-8');
  commandsMetaData = (JSON.parse(commandsIndex) as { commands: CommandMeta[] }).commands;

  return commandsMetaData;
}

export async function getCommand(metaData: { commandName: string }) {
  const commands = await getMetaData();
  const command = commands.find(({ commandName }) => metaData.commandName === commandName);
  if (!command) {
    return null;
  }

  const { default: commandConstructor } = await import(
    new URL(command.filePath, import.meta.url).href
  );
  return commandConstructor;
}
