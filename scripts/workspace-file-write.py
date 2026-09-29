#!/usr/bin/env python3
"""Descriptor-relative workspace write. Invoked only by fileContentService.ts.

The root and each directory entry are opened without following symlinks. Every
mutation is relative to the pinned parent fd, never to a validated pathname.
"""
import errno
import hashlib
import json
import os
import stat
import sys
import uuid

LIMIT = 512 * 1024  # replaced per request by versionLimit, the server's MAX_WORKSPACE_FILE_CONTENT_BYTES
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Conflict(Exception):
    pass


class OutcomeUnknown(Exception):
    pass


def send(kind, **fields):
    sys.stdout.write(json.dumps({"kind": kind, **fields}) + "\n")
    sys.stdout.flush()


def gate(kind):
    send(kind)
    if sys.stdin.buffer.readline() != b"go\n":
        raise Conflict("File save was cancelled")


def snapshot(parent, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise Conflict("File changed or is a symlink") from exc
        raise
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Path is not a file")
        if before.st_size > LIMIT:
            raise Conflict("File exceeds the %d KiB version limit; reload or save a smaller file" % (LIMIT // 1024))
        chunks = []
        while True:
            chunk = os.read(fd, LIMIT + 1 - sum(map(len, chunks)))
            if not chunk:
                break
            chunks.append(chunk)
        data = b"".join(chunks)
        after = os.fstat(fd)
        if (len(data) != before.st_size or before.st_size != after.st_size or
                before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns):
            raise Conflict("File changed or was deleted since it was loaded")
        return (hashlib.sha256(data).hexdigest(), after.st_dev, after.st_ino, stat.S_IMODE(after.st_mode))
    finally:
        os.close(fd)


def parent_fd(root, parts, create):
    current = os.dup(root)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, dir_fd=current)
                except FileExistsError:
                    pass
            next_fd = os.open(part, DIRECTORY, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except OSError as exc:
        os.close(current)
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Conflict("Path escapes workspace or directory changed") from exc
        raise
    except BaseException:
        os.close(current)
        raise


def assert_parent(root, parts, parent):
    check = parent_fd(root, parts, False)
    try:
        a, b = os.fstat(check), os.fstat(parent)
        if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
            raise Conflict("Workspace directory changed during save")
    finally:
        os.close(check)


def write(request):
    global LIMIT
    LIMIT = request.get("versionLimit", LIMIT)
    parts = request["path"].split("/")
    if not parts or any(p in ("", ".", "..") for p in parts):
        raise ValueError("Invalid workspace path")
    # Darwin rejects symlinks across the full root path with O_NOFOLLOW_ANY.
    # On other Unix hosts, walk the absolute root one component at a time.
    root_path = request["root"]
    if not os.path.isabs(root_path):
        raise ValueError("Workspace root must be absolute")
    if hasattr(os, "O_NOFOLLOW_ANY"):
        root = os.open(root_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW_ANY)
    else:
        filesystem_root = os.open(os.path.sep, DIRECTORY)
        try:
            root = parent_fd(filesystem_root, [p for p in root_path.split(os.path.sep) if p], False)
        finally:
            os.close(filesystem_root)
    try:
        parent = parent_fd(root, parts[:-1], request["createDirs"])
        try:
            leaf = parts[-1]
            initial = snapshot(parent, leaf)
            if initial is not None and not request["overwrite"]:
                raise ValueError("File already exists: " + request["path"])
            expected = request.get("expectedVersion")
            if expected is not None and not request["forceOverwrite"] and (initial is None or initial[0] != expected):
                raise Conflict("File changed or was deleted since it was loaded")
            temp = ".pi-web-write-" + uuid.uuid4().hex
            backup_dir = None
            temp_fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                              initial[3] if initial else 0o666, dir_fd=parent)
            try:
                if initial:
                    os.fchmod(temp_fd, initial[3])
                remaining = request["size"]
                while remaining:
                    data = sys.stdin.buffer.read(min(65536, remaining))
                    if not data:
                        raise ValueError("Incomplete file content")
                    view = memoryview(data)
                    while view:
                        view = view[os.write(temp_fd, view):]
                    remaining -= len(data)
                written = os.fstat(temp_fd)
                os.close(temp_fd)
                temp_fd = -1
                gate("beforeCommit")
                assert_parent(root, parts[:-1], parent)
                if initial:
                    backup_dir = ".pi-web-backup-" + uuid.uuid4().hex
                    os.mkdir(backup_dir, dir_fd=parent)
                    backup = os.open(backup_dir, DIRECTORY, dir_fd=parent)
                    try:
                        try:
                            os.rename(leaf, "original", src_dir_fd=parent, dst_dir_fd=backup)
                        except FileNotFoundError as exc:
                            raise Conflict("File changed or was deleted since it was loaded") from exc
                        installed = False
                        try:
                            gate("afterDisplacement")
                            assert_parent(root, parts[:-1], parent)
                            if snapshot(backup, "original") != initial:
                                raise Conflict("File changed or was deleted since it was loaded")
                            os.link(temp, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                            installed = True
                            gate("afterInstallation")
                            if snapshot(backup, "original") != initial:
                                raise Conflict("File changed after installation; displaced entry retained")
                        except BaseException as exc:
                            try:
                                if stat.S_ISLNK(os.stat("original", dir_fd=backup, follow_symlinks=False).st_mode):
                                    os.symlink(os.readlink("original", dir_fd=backup), leaf, dir_fd=parent)
                                else:
                                    os.link("original", leaf, src_dir_fd=backup, dst_dir_fd=parent, follow_symlinks=False)
                                os.unlink("original", dir_fd=backup)
                            except OSError as restore_error:
                                error = OutcomeUnknown if installed else Conflict
                                raise error("File changed; displaced entry retained in " + backup_dir + ": " + str(restore_error)) from exc
                            if isinstance(exc, FileExistsError):
                                raise Conflict("File changed or was deleted since it was loaded") from exc
                            raise
                        os.unlink("original", dir_fd=backup)
                    finally:
                        os.close(backup)
                else:
                    assert_parent(root, parts[:-1], parent)
                    try:
                        os.link(temp, leaf, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    except FileExistsError as exc:
                        raise Conflict("File changed or was deleted since it was loaded") from exc
                send("result", size=written.st_size, modifiedAt=written.st_mtime * 1000, created=initial is None)
            finally:
                if temp_fd != -1:
                    os.close(temp_fd)
                try:
                    os.unlink(temp, dir_fd=parent)
                except FileNotFoundError:
                    pass
                if backup_dir:
                    try:
                        os.rmdir(backup_dir, dir_fd=parent)
                    except OSError as exc:
                        if exc.errno != errno.ENOTEMPTY:
                            raise OutcomeUnknown("File save cleanup failed after installation: " + str(exc)) from exc
        finally:
            os.close(parent)
    finally:
        os.close(root)


if __name__ == "__main__":
    try:
        write(json.loads(sys.stdin.buffer.readline()))
    except BaseException as exc:
        send("error", conflict=isinstance(exc, Conflict), uncertain=isinstance(exc, OutcomeUnknown), message=str(exc))
        sys.exit(1)
