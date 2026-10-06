// Embedded trusted source avoids loading modules from a sandbox-controlled directory.
export const UNIX_LOCAL_FILE_WORKER = String.raw`
import errno
import json
import os
import select
import signal
import stat
import sys
from contextlib import contextmanager, ExitStack
from pathlib import Path

TRAVERSE = getattr(os, "O_SEARCH", getattr(os, "O_PATH", None))
if TRAVERSE is None:
    raise RuntimeError("Search-only directory descriptors are unavailable")
TRAVERSE |= os.O_DIRECTORY | os.O_NOFOLLOW
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
HOST_UID = os.geteuid()

def cancel(signum, frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(1)

signal.signal(signal.SIGTERM, cancel)

@contextmanager
def defer_cancellation():
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)

def select_identity(identity):
    if not identity or identity["isCurrentUser"]:
        return
    if HOST_UID != 0:
        raise PermissionError(errno.EPERM, "Changing the file worker user requires root")
    os.initgroups(identity["username"], identity["gid"])
    os.setegid(identity["gid"])
    os.seteuid(identity["uid"])

@contextmanager
def host_identity():
    current_uid = os.geteuid()
    try:
        if HOST_UID == 0:
            os.seteuid(0)
        yield
    finally:
        if HOST_UID == 0:
            os.seteuid(current_uid)

def preserve_ownership(fd, info):
    with host_identity():
        os.fchown(fd, info.st_uid, info.st_gid)

if sys.platform == "darwin":
    if not all(hasattr(select, name) for name in ("kqueue", "kevent", "KQ_FILTER_VNODE", "KQ_EV_ADD", "KQ_EV_CLEAR", "KQ_NOTE_ATTRIB")):
        raise RuntimeError("File metadata change notifications are unavailable")
    import ctypes
    system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    system.fcopyfile.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    system.fcopyfile.restype = ctypes.c_int
    system.acl_init.argtypes = [ctypes.c_int]
    system.acl_init.restype = ctypes.c_void_p
    system.acl_set_fd.argtypes = [ctypes.c_int, ctypes.c_void_p]
    system.acl_set_fd.restype = ctypes.c_int
    system.acl_free.argtypes = [ctypes.c_void_p]
    system.acl_free.restype = ctypes.c_int
elif not all(hasattr(os, name) for name in ("listxattr", "getxattr", "setxattr", "removexattr")):
    raise RuntimeError("File access metadata preservation is unavailable")

def close(fd):
    failing = sys.exc_info()[0] is not None
    try:
        os.close(fd)
    except OSError:
        if not failing:
            raise

def checked_path(spec):
    # Resolve the original spelling as the selected user, not only its host-resolved target.
    path = spec["accessPath"]
    if "rootTarget" in spec and str(Path(path).resolve(strict=True)) != spec["rootTarget"]:
        raise OSError(errno.ELOOP, "Sandbox root changed during file validation", path)
    if spec["preserveLeaf"]:
        resolved = str(Path(path).parent.resolve(strict=True) / Path(path).name)
    else:
        existing = Path(path)
        while True:
            try:
                existing.lstat()
                break
            except FileNotFoundError:
                existing = existing.parent
        resolved = str(existing.resolve(strict=True) / Path(path).relative_to(existing))
    if resolved != spec["path"]:
        raise OSError(errno.ELOOP, "Sandbox path changed during file validation", path)
    return resolved

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

def create_file(directory, name):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, 0o666, dir_fd=directory)
    try:
        input_file(fd)
    finally:
        close(fd)

def write_new(path):
    with parent(path, create=True) as (directory, name):
        create_file(directory, name)

def file_attributes(fd):
    with host_identity():
        attributes = os.listxattr(fd)
        if {"security.ima", "security.evm"}.intersection(attributes):
            raise OSError(errno.ENOTSUP, "Cannot replace files with integrity signatures")
        return {name: os.getxattr(fd, name) for name in attributes}

def copy_attributes(source, destination):
    if sys.platform == "darwin":
        # COPYFILE_ACL | COPYFILE_XATTR preserves access rules without copying data or set-ID modes.
        if system.fcopyfile(source, destination, None, (1 << 0) | (1 << 2)) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
    else:
        attributes = file_attributes(source)
        destination_attributes = os.listxattr(destination)
        for attribute in destination_attributes:
            if attribute not in attributes or attribute == "security.capability":
                os.removexattr(destination, attribute)
        for attribute, value in attributes.items():
            if attribute != "security.capability":
                if attribute == "security.selinux" and attribute in destination_attributes and os.getxattr(destination, attribute) == value:
                    continue
                os.setxattr(destination, attribute, value)
        return attributes

def restrict_directory_access(fd):
    if sys.platform == "darwin":
        # Remove inherited access before creating a file that another user could open.
        empty = system.acl_init(0)
        if not empty:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        try:
            if system.acl_set_fd(fd, empty) != 0:
                error = ctypes.get_errno()
                raise OSError(error, os.strerror(error))
        finally:
            system.acl_free(empty)
    os.fchmod(fd, 0o700)

@contextmanager
def staging_directory(directory):
    temporary = ".openai-agents-" + os.urandom(16).hex()
    created = False
    outer = None
    stage = None
    private = False
    inner_created = False
    try:
        with defer_cancellation():
            # The SDK staging directory needs owner access regardless of the host umask.
            previous_umask = os.umask(0o077)
            try:
                os.mkdir(temporary, 0o700, dir_fd=directory)
            finally:
                os.umask(previous_umask)
            created = True
            outer = os.open(temporary, DIRECTORY, dir_fd=directory)
            owner = os.fstat(outer)
            if owner.st_uid != os.geteuid():
                raise PermissionError(errno.EPERM, "Temporary directory ownership changed")
            private = HOST_UID == 0 and owner.st_uid != 0
            if private:
                # Seal the outer directory before anything is created inside it.
                # The selected user can still publish through the held inner descriptor.
                with host_identity():
                    os.fchown(outer, 0, -1)
                    restrict_directory_access(outer)
                    os.mkdir("files", 0o700, dir_fd=outer)
                    inner_created = True
                    stage = os.open("files", DIRECTORY, dir_fd=outer)
                    os.fchown(stage, owner.st_uid, os.getegid())
            else:
                stage = outer
            restrict_directory_access(stage)
        yield stage
    finally:
        with defer_cancellation():
            with host_identity():
                if stage is not None and stage != outer:
                    close(stage)
                if private:
                    if inner_created:
                        os.rmdir("files", dir_fd=outer)
                    # Restore only the empty outer before unlinking from a sticky parent.
                    os.fchown(outer, owner.st_uid, owner.st_gid)
            if outer is not None:
                current = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
                if (current.st_dev, current.st_ino) != (owner.st_dev, owner.st_ino):
                    raise OSError(errno.ESTALE, "Temporary directory changed")
                close(outer)
            if created:
                os.rmdir(temporary, dir_fd=directory)

def replace_file(directory, name, source_fd):
    with staging_directory(directory) as stage, ExitStack() as resources:
        fd = None
        try:
            with defer_cancellation():
                fd = os.open("content", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage)
                os.fchmod(fd, 0o600)
            input_file(fd)
            changes = None
            if sys.platform == "darwin":
                with defer_cancellation():
                    changes = select.kqueue()
                    resources.callback(changes.close)
                    changes.control([select.kevent(source_fd, filter=select.KQ_FILTER_VNODE, flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=select.KQ_NOTE_ATTRIB)], 0, 0)
            info = regular(source_fd, name)
            created = os.fstat(fd)
            attributes = copy_attributes(source_fd, fd)
            # Content changes must not restore set-user-ID or set-group-ID privileges.
            os.fchmod(fd, stat.S_IMODE(info.st_mode) & 0o777)
            if (created.st_uid, created.st_gid) != (info.st_uid, info.st_gid):
                # Only this newly created descriptor needs the original owner restored.
                preserve_ownership(fd, info)
            if attributes is not None and file_attributes(source_fd) != attributes:
                raise OSError(errno.ESTALE, "File metadata changed during update", name)
            if changes is not None and changes.control([], 1, 0):
                raise OSError(errno.ESTALE, "File metadata changed during update", name)
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (
                current.st_dev, current.st_ino, current.st_ctime_ns,
                current.st_mode, current.st_uid, current.st_gid,
            ) != (
                info.st_dev, info.st_ino, info.st_ctime_ns,
                info.st_mode, info.st_uid, info.st_gid,
            ):
                raise OSError(errno.ESTALE, "File changed during update", name)
            os.rename("content", name, src_dir_fd=stage, dst_dir_fd=directory)
        finally:
            with defer_cancellation():
                if fd is not None:
                    try:
                        with host_identity():
                            try:
                                os.unlink("content", dir_fd=stage)
                            except FileNotFoundError:
                                pass
                    finally:
                        close(fd)

def write_destination(path):
    with parent(path, create=True) as (directory, name):
        try:
            fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            create_file(directory, name)
            return
        try:
            regular(fd, path)
            replace_file(directory, name, fd)
        finally:
            close(fd)

def check_removal(directory, name):
    if sys.platform == "darwin":
        # Darwin's _DELETE_OK checks both file and parent ACLs, including sticky-directory rules.
        if not os.access(name, 1 << 12, dir_fd=directory, effective_ids=True, follow_symlinks=False):
            os.stat(name, dir_fd=directory, follow_symlinks=False)
            raise PermissionError(errno.EACCES, "Source entry does not allow removal", name)
        return
    if not os.access(".", os.W_OK | os.X_OK, dir_fd=directory, effective_ids=True):
        raise PermissionError(errno.EACCES, "Source directory does not allow removal", name)
    parent_info = os.fstat(directory)
    entry_info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    uid = os.geteuid()
    if parent_info.st_mode & stat.S_ISVTX and uid not in (0, parent_info.st_uid, entry_info.st_uid):
        raise PermissionError(errno.EPERM, "Source directory does not allow removal", name)

def run(request):
    operation = request["operation"]
    if operation == "probe":
        if not {os.open, os.stat, os.mkdir, os.rmdir, os.unlink, os.rename, os.access}.issubset(os.supports_dir_fd) or os.access not in os.supports_effective_ids or os.scandir not in os.supports_fd or os.stat not in os.supports_follow_symlinks or not all(hasattr(os, name) for name in ("fchdir", "fchown", "fchmod")):
            raise RuntimeError("Descriptor-relative file operations are unavailable")
        Path("/").resolve(strict=True)
        sys.stdout.write("ready")
        return
    select_identity(request.get("identity"))
    path = checked_path(request["path"])
    if operation == "create":
        write_new(path)
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
        destination = checked_path(request["destination"]) if "destination" in request else path
        unlink_path = checked_path(request["unlinkPath"]) if request.get("unlinkPath") is not None else None
        with ExitStack() as handles:
            directory, name = handles.enter_context(parent(path))
            if unlink_path is not None:
                unlink_directory, unlink_name = handles.enter_context(parent(unlink_path))
                check_removal(unlink_directory, unlink_name)
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
                    write_destination(destination)
                    os.unlink(unlink_name, dir_fd=unlink_directory)
                else:
                    replace_file(directory, name, fd)
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
