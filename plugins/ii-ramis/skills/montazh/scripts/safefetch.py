"""Безопасная загрузка по ссылке и распаковка архива (для шрифтов Афиши и модели маски).

Правила: только https, без учётных данных в адресе и без адресов-цифр (localhost, 192.168...), не больше 5 переходов
и все тоже https, размер ограничен, итоговая сверка SHA256 (хеш закреплён в плагине, ссылка нет), файл сначала во
временном имени и переименовывается только после совпадения хеша. Распаковка zip: берём только файлы с разрешёнными
именами из списка, без папок, ссылок и `..`, лимит размера и числа файлов. Ничего не запускается и не импортируется.
Только стандартная библиотека Python, работает на Mac и Windows."""
import hashlib
import ipaddress
import os
import re
import stat
import time
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

CHUNK = 64 * 1024


class FetchError(Exception):
    """Понятная причина отказа, её можно показать ученику."""


def check_url(url):
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme != "https":
        raise FetchError("ссылка должна начинаться с https://")
    if not parts.hostname or parts.username or parts.password:
        raise FetchError("в ссылке не должно быть имени пользователя и ключа перед адресом сайта")
    host = parts.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".internal"):
        raise FetchError("адрес компьютера или локальной сети не подходит")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise FetchError("ссылка с цифровым адресом не подходит, нужна обычная ссылка с названием сайта")
    # настоящее имя сайта: буквы, цифры, дефисы, точки, и последняя часть (зона) начинается с буквы; так не проходят 2130706433, 0x7f.1, 127.1
    if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*", host):
        raise FetchError("в ссылке нужно обычное имя сайта (например, github.com), а не адрес из цифр")
    if parts.port not in (None, 443):
        raise FetchError("нестандартный порт не подходит")
    return url.strip()


class _HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(urllib.parse.urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, destination, max_bytes, sha256, timeout=60):
    """Качает url в destination (имя файла), проверяет размер и SHA256. Возвращает путь."""
    check_url(url)
    if len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256.lower()):
        raise FetchError("внутренняя ошибка: контрольная сумма в плагине записана неверно")
    opener = urllib.request.build_opener(_HttpsOnlyRedirect)
    request = urllib.request.Request(url, headers={"User-Agent": "ii-ramis-plugin"})
    folder = os.path.dirname(os.path.abspath(destination))
    os.makedirs(folder, exist_ok=True)
    digest = hashlib.sha256()
    total = 0
    deadline = time.monotonic() + 300  # общий срок на всю загрузку, а не на каждое чтение
    handle, temp_path = tempfile.mkstemp(dir=folder, prefix=".download-")
    try:
        with os.fdopen(handle, "wb") as out, opener.open(request, timeout=timeout) as response:
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise FetchError(f"файл больше допустимого ({max_bytes // 1024 // 1024} МБ), не качаю")
            while True:
                block = response.read(CHUNK)
                if not block:
                    break
                total += len(block)
                if total > max_bytes:
                    raise FetchError(f"файл больше допустимого ({max_bytes // 1024 // 1024} МБ), остановил")
                if time.monotonic() > deadline:
                    raise FetchError("загрузка идёт слишком долго (больше 5 минут), остановил")
                digest.update(block)
                out.write(block)
        if digest.hexdigest() != sha256.lower():
            raise FetchError("контрольная сумма не совпала: это не тот файл, который ждёт плагин. Ничего не установлено")
        os.replace(temp_path, destination)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise FetchError(f"не скачалось: {getattr(error, 'reason', error)}") from error
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    return destination


def sha256_file(path, max_bytes):
    digest, total = hashlib.sha256(), 0
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            total += len(block)
            if total > max_bytes:
                raise FetchError("файл слишком большой")
            digest.update(block)
    return digest.hexdigest()


def extract_allowed(zip_path, target_dir, allowed_names, max_file_bytes, max_total_bytes):
    """Достаёт из zip только файлы с именами из allowed_names (имя без папок). Возвращает список имён."""
    allowed = set(allowed_names)
    done, total = [], 0
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as error:
        raise FetchError("это не zip-архив или он повреждён") from error
    with archive:
        infos = archive.infolist()
        if len(infos) > 50:
            raise FetchError("в архиве слишком много файлов")
        for info in infos:
            if info.is_dir():
                continue
            name = info.filename
            mode = info.external_attr >> 16
            if name not in allowed or "/" in name or "\\" in name or ".." in name or ":" in name:
                raise FetchError(f"в архиве лишний файл или путь «{name[:60]}», не распаковываю")
            if mode and stat.S_ISLNK(mode):
                raise FetchError("в архиве ссылка вместо файла, не распаковываю")
            if info.file_size > max_file_bytes:
                raise FetchError(f"файл «{name}» в архиве слишком большой")
            total += info.file_size
            if total > max_total_bytes:
                raise FetchError("архив после распаковки слишком большой")
        missing = allowed - {i.filename for i in infos}
        if missing:
            raise FetchError("в архиве не хватает файлов: " + ", ".join(sorted(missing)))
        os.makedirs(target_dir, exist_ok=True)
        for info in infos:
            if info.is_dir():
                continue
            target = os.path.join(target_dir, info.filename)
            temp = os.path.join(target_dir, ".tmp-" + info.filename)
            flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            written = 0
            try:
                descriptor = os.open(temp, flags, 0o644)
                with os.fdopen(descriptor, "wb") as out, archive.open(info) as source:
                    while True:
                        block = source.read(CHUNK)
                        if not block:
                            break
                        written += len(block)
                        if written > max_file_bytes:  # размер в заголовке архива могли подделать
                            raise FetchError(f"файл «{info.filename}» оказался больше заявленного")
                        out.write(block)
                os.replace(temp, target)  # замена имени целиком: обрезанный файл не остаётся, ссылка на этом месте заменяется, а не открывается
            finally:
                if os.path.lexists(temp):
                    os.unlink(temp)
            done.append(info.filename)
    return done


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)
