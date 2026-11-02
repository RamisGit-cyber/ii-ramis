// Слежение за `cd`: после `cd папка && команда` относительные пути в команде означают уже другое место.
// Возвращает: undefined, если токены не cd; строку (новый рабочий путь), если цель понятна; null, если цель неизвестна (переменная, `cd -`, шаблон).
import os from 'node:os';
import path from 'node:path';
import { verbName, commandIndex } from './shell-parse.mjs';

export const CD_VERBS = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir']);
const CD_FLAGS = /^-(?:L|P|e|@|path|literalpath)$/i;

export function directoryAfter(tokens, current) {
  const first = commandIndex(tokens);
  if (first === -1 || !CD_VERBS.has(verbName(tokens[first]))) return undefined;
  if (verbName(tokens[first]) === 'popd') return null;
  const args = tokens.slice(first + 1).filter((a) => !CD_FLAGS.test(a));
  if (args.length === 0) return os.homedir();
  if (args.length > 1) return null;
  const target = args[0].replace(/\\/g, path.sep === '\\' ? '\\' : '/');
  if (/[$`*?[\]{}]|^-$|^~[^/\\]|\$\(\)/.test(target) || target === '') return null;
  const expanded = target === '~' ? os.homedir() : /^~[/\\]/.test(target) ? path.join(os.homedir(), target.slice(2)) : target;
  if (!path.isAbsolute(expanded) && current === null) return null;
  return path.resolve(current ?? os.homedir(), expanded);
}
