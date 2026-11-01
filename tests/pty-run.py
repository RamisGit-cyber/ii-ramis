#!/usr/bin/env python3
"""Запускает команду в настоящем псевдотерминале (как будто её набрал человек) и подаёт ответ.
Использование: pty-run.py [--human | --agent | --clean-env] <ответ> <команда> [аргументы...]
Печатает всё, что команда вывела на экран. Нужен тестам, чтобы проверить вопросы установщика (ответ «да», «нет», пустая строка).

Режимы нужны, потому что тесты сами запускаются из-под Claude, а установщик по задумке отличает человека от Claude:
  (без флага)  окружение и родители как есть;
  --agent      добавляет CLAUDECODE=1 (как у процесса, запущенного Claude);
  --clean-env  убирает все переменные Claude (но родитель-Claude остаётся);
  --human      убирает переменные И делает процесс сиротой (родитель = init), как команда, набранная в обычном Терминале.
"""
import fcntl
import os
import pty
import sys
import termios

args = sys.argv[1:]
mode = None
if args and args[0] in ('--human', '--agent', '--clean-env'):
    mode = args.pop(0)
answer = args[0]
command = args[1:]

env = dict(os.environ)
if mode in ('--human', '--clean-env'):
    for name in list(env):
        if name == 'CLAUDECODE' or name == 'AI_AGENT' or name.startswith('CLAUDE_CODE_'):
            del env[name]
if mode == '--agent':
    env['CLAUDECODE'] = '1'
    env['CLAUDE_CODE_ENTRYPOINT'] = 'cli'

def spawn_orphan():
    """Процесс-сирота с собственным терминалом: его родитель (init) не Claude, как у команды из обычного Терминала."""
    master, slave = pty.openpty()
    middle = os.fork()
    if middle == 0:
        if os.fork() != 0:
            os._exit(0)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for target in (0, 1, 2):
            os.dup2(slave, target)
        os.close(master)
        os.execvpe(command[0], command, env)
    os.close(slave)
    return middle, master


if mode == '--human':
    pid, fd = spawn_orphan()
else:
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, env)
os.write(fd, (answer + '\n').encode())
output = b''
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
os.waitpid(pid, 0)
sys.stdout.write(output.decode('utf-8', 'replace'))
