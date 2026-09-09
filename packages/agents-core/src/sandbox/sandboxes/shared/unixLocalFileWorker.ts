// Embedded trusted source avoids loading modules from a sandbox-controlled directory.
export const UNIX_LOCAL_FILE_WORKER = String.raw`
import errno
import json
import os
import stat
import sys
from contextlib import contextmanager, ExitStack

TRAVERSE = getattr(os, "O_SEARCH", getattr(os, "O_PATH", os.O_RDONLY)) | os.O_DIRECTORY | os.O_NOFOLLOW
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK

def close(fd):
    failing = sys.exc_info()[0] is not None
    try:
        os.close(fd)
    except OSError:
        if not failing:
            raise

@contextmanager
def parent(path, create=False):
    fd = os.open("/", TRAVERSE)
    try:
        parts = path.split("/")
        for name in parts[1:-1]:
            if not name:
                continue
            try:
                child = os.open(name, TRAVERSE, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(name, TRAVERSE, dir_fd=fd)
            close(fd)
            fd = child
        yield fd, parts[-1] or "."
    finally:
        close(fd)

def regular(fd, path):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        raise OSError(errno.EINVAL, "Sandbox path is not a regular file", path)
    return info

def output_file(fd, limit=None):
    count = 0
    while True:
        data = os.read(fd, 65536)
        if not data:
            return
        count += len(data)
        if limit is not None and count > limit:
            raise OSError(errno.EFBIG, "Image file exceeds the 10 MB limit")
        sys.stdout.buffer.write(data)

def input_file(fd):
    while True:
        data = sys.stdin.buffer.read(65536)
        if not data:
            return
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]

def ownership(fd, request):
    if "owner" in request:
        os.fchown(fd, request["owner"]["uid"], request["owner"]["gid"])

def write_new(path, request, exclusive):
    with parent(path, create=True) as (directory, name):
        flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
        if exclusive:
            flags |= os.O_EXCL
        fd = os.open(name, flags, 0o666, dir_fd=directory)
    try:
        regular(fd, path)
        os.ftruncate(fd, 0)
        input_file(fd)
        ownership(fd, request)
    finally:
        close(fd)

def run(request):
    operation = request["operation"]
    if operation == "probe":
        if not {os.open, os.stat, os.mkdir, os.unlink}.issubset(os.supports_dir_fd) or os.scandir not in os.supports_fd or os.stat not in os.supports_follow_symlinks or not hasattr(os, "fchdir") or not hasattr(os, "fchown"):
            raise RuntimeError("Descriptor-relative file operations are unavailable")
        sys.stdout.write("ready")
        return
    path = request["path"]
    if operation == "create":
        write_new(path, request, True)
        return
    if operation == "delete":
        with parent(path) as (directory, name):
            os.unlink(name, dir_fd=directory)
        return
    if operation == "exists" or operation == "directoryExists":
        try:
            with parent(path) as (directory, name):
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    raise OSError(errno.ELOOP, "Sandbox path changed to a symbolic link", path)
                result = True
                if operation == "directoryExists":
                    result = stat.S_ISDIR(info.st_mode)
                    if result:
                        try:
                            fd = os.open(name, TRAVERSE, dir_fd=directory)
                            try:
                                os.fchdir(fd)
                            finally:
                                close(fd)
                        except PermissionError:
                            result = False
            sys.stdout.write(json.dumps(result))
        except FileNotFoundError:
            sys.stdout.write("false")
        return
    if operation == "list":
        with parent(path) as (directory, name):
            fd = os.open(name, DIRECTORY, dir_fd=directory)
        try:
            with os.scandir(fd) as entries:
                result = [{"name": entry.name, "type": "dir" if entry.is_dir(follow_symlinks=False) else "file" if entry.is_file(follow_symlinks=False) else "other"} for entry in entries]
            sys.stdout.write(json.dumps(result))
        finally:
            close(fd)
        return
    if operation == "read" or operation == "image":
        with parent(path) as (directory, name):
            fd = os.open(name, FILE_READ, dir_fd=directory)
        try:
            info = regular(fd, path)
            limit = request.get("limit")
            if limit is not None and info.st_size > limit:
                raise OSError(errno.EFBIG, "Image file exceeds the 10 MB limit", path)
            output_file(fd, limit)
        finally:
            close(fd)
        return
    if operation == "update":
        destination = request.get("destination", path)
        unlink_path = request.get("unlinkPath")
        with ExitStack() as handles:
            directory, name = handles.enter_context(parent(path))
            if unlink_path is not None:
                unlink_directory, unlink_name = handles.enter_context(parent(unlink_path))
            flags = FILE_READ if unlink_path is not None else os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
            fd = os.open(name, flags, dir_fd=directory)
            try:
                regular(fd, path)
                with os.fdopen(fd, "rb", closefd=False) as source:
                    current = source.read()
                sys.stdout.buffer.write(b"READY\n")
                sys.stdout.buffer.write(current)
                del current
                sys.stdout.buffer.flush()
                # EOF transfers the source bytes; the worker retains both source handles.
                os.close(1)
                if sys.stdin.buffer.read(1) != b"W":
                    return
                if unlink_path is not None:
                    write_new(destination, request, False)
                    os.unlink(unlink_name, dir_fd=unlink_directory)
                else:
                    os.lseek(fd, 0, os.SEEK_SET)
                    os.ftruncate(fd, 0)
                    input_file(fd)
                    ownership(fd, request)
            finally:
                close(fd)
        return
    raise ValueError("Unsupported file operation")

try:
    run(json.loads(sys.argv[1]))
except OSError as error:
    sys.stderr.write(json.dumps({"code": errno.errorcode.get(error.errno, "EIO"), "message": error.strerror}))
    sys.exit(1)
except Exception:
    sys.stderr.write(json.dumps({"code": "EIO", "message": "UnixLocal file worker failed"}))
    sys.exit(1)
`;
