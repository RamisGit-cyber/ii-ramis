#!/usr/bin/env python3
"""Запускает команду в настоящем псевдотерминале (как будто её набрал человек) и подаёт ответ.
Использование: pty-run.py <ответ> <команда> [аргументы...]
Печатает всё, что команда вывела на экран. Нужен тестам, чтобы проверить вопросы установщика (ответ «да», «нет», пустая строка)."""
import os
import pty
import sys

answer = sys.argv[1]
command = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
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
