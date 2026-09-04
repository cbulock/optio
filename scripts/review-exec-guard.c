/*
 * Optio review execution guard.
 *
 * Loaded with LD_PRELOAD only for Codex review app-server children. It is not
 * a general sandbox; it is a defence-in-depth boundary for normal Unix tools:
 * deny mutable git/GitHub operations and deny filesystem mutation beneath the
 * mounted Optio workspace, including when commands use absolute paths or are
 * launched from shell/Node/Python subprocesses.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static const char *base_name(const char *path) {
  const char *slash = strrchr(path ? path : "", '/');
  return slash ? slash + 1 : path;
}

static bool starts_with(const char *value, const char *prefix) {
  return value && prefix && strncmp(value, prefix, strlen(prefix)) == 0;
}

static bool is_workspace_path(const char *pathname, int dirfd) {
  char resolved[PATH_MAX] = {0};
  const char *candidate = pathname;
  if (!pathname) return false;
  if (pathname[0] != '/') {
    if (dirfd != AT_FDCWD) {
      char fd_path[64];
      snprintf(fd_path, sizeof(fd_path), "/proc/self/fd/%d", dirfd);
      ssize_t len = readlink(fd_path, resolved, sizeof(resolved) - 1);
      if (len > 0) {
        resolved[len] = '\0';
        size_t n = strlen(resolved);
        snprintf(resolved + n, sizeof(resolved) - n, "/%s", pathname);
        candidate = resolved;
      }
    } else if (getcwd(resolved, sizeof(resolved))) {
      size_t n = strlen(resolved);
      snprintf(resolved + n, sizeof(resolved) - n, "/%s", pathname);
      candidate = resolved;
    }
  }
  return starts_with(candidate, "/workspace/");
}

static void deny(const char *operation, const char *target) {
  fprintf(stderr, "Optio review guard blocked %s%s%s; review runs are read-only.\n", operation,
          target ? " on " : "", target ? target : "");
  errno = EPERM;
}

static bool git_read_only(char *const argv[]) {
  const char *sub = argv[1];
  if (!sub) return true;
  return strcmp(sub, "diff") == 0 || strcmp(sub, "show") == 0 ||
    strcmp(sub, "status") == 0 || strcmp(sub, "log") == 0 ||
    strcmp(sub, "rev-parse") == 0 || strcmp(sub, "ls-files") == 0 ||
    strcmp(sub, "grep") == 0 || strcmp(sub, "blame") == 0 ||
    strcmp(sub, "cat-file") == 0 || strcmp(sub, "show-ref") == 0 ||
    strcmp(sub, "symbolic-ref") == 0 ||
    (strcmp(sub, "branch") == 0 && argv[2] && strcmp(argv[2], "--show-current") == 0);
}

static bool gh_review_only(char *const argv[]) {
  return argv[1] && argv[2] && strcmp(argv[1], "pr") == 0 &&
    (strcmp(argv[2], "diff") == 0 || strcmp(argv[2], "view") == 0 ||
     strcmp(argv[2], "review") == 0);
}

static bool is_package_mutation(const char *cmd, char *const argv[]) {
  const char *sub = argv[1];
  if (!sub) return false;
  if (strcmp(cmd, "npm") == 0 || strcmp(cmd, "pnpm") == 0 || strcmp(cmd, "yarn") == 0 ||
      strcmp(cmd, "bun") == 0) {
    return strcmp(sub, "install") == 0 || strcmp(sub, "add") == 0 ||
      strcmp(sub, "remove") == 0 || strcmp(sub, "uninstall") == 0 ||
      strcmp(sub, "update") == 0 || strcmp(sub, "upgrade") == 0;
  }
  return strcmp(cmd, "pip") == 0 || strcmp(cmd, "pip3") == 0 ||
    strcmp(cmd, "apt") == 0 || strcmp(cmd, "apt-get") == 0 ||
    strcmp(cmd, "apk") == 0 || strcmp(cmd, "brew") == 0;
}

static bool should_block_exec(const char *filename, char *const argv[]) {
  const char *cmd = base_name(filename);
  if (strcmp(cmd, "git") == 0) return !git_read_only(argv);
  if (strcmp(cmd, "gh") == 0) return !gh_review_only(argv);
  if (strcmp(cmd, "glab") == 0 || strcmp(cmd, "aws") == 0 || strcmp(cmd, "curl") == 0 ||
      strcmp(cmd, "wget") == 0 || strcmp(cmd, "ssh") == 0 || strcmp(cmd, "scp") == 0 ||
      strcmp(cmd, "rsync") == 0) return true;
  if (strcmp(cmd, "rm") == 0 || strcmp(cmd, "mv") == 0 || strcmp(cmd, "cp") == 0 ||
      strcmp(cmd, "install") == 0 || strcmp(cmd, "touch") == 0 || strcmp(cmd, "truncate") == 0 ||
      strcmp(cmd, "dd") == 0 || strcmp(cmd, "tee") == 0 || strcmp(cmd, "chmod") == 0 ||
      strcmp(cmd, "chown") == 0 || strcmp(cmd, "chgrp") == 0 || strcmp(cmd, "ln") == 0 ||
      strcmp(cmd, "mkdir") == 0 || strcmp(cmd, "rmdir") == 0) return true;
  return is_package_mutation(cmd, argv);
}

int execve(const char *filename, char *const argv[], char *const envp[]) {
  static int (*real_execve)(const char *, char *const[], char *const[]) = NULL;
  if (!real_execve) real_execve = dlsym(RTLD_NEXT, "execve");
  if (should_block_exec(filename, argv)) { deny("command", filename); return -1; }
  return real_execve(filename, argv, envp);
}

int execveat(int dirfd, const char *filename, char *const argv[], char *const envp[], int flags) {
  static int (*real_execveat)(int, const char *, char *const[], char *const[], int) = NULL;
  if (!real_execveat) real_execveat = dlsym(RTLD_NEXT, "execveat");
  if (should_block_exec(filename, argv)) { deny("command", filename); return -1; }
  return real_execveat(dirfd, filename, argv, envp, flags);
}

static bool write_flags(int flags) {
  return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) != 0;
}

int open(const char *pathname, int flags, ...) {
  static int (*real_open)(const char *, int, ...) = NULL; if (!real_open) real_open = dlsym(RTLD_NEXT, "open");
  if (write_flags(flags) && is_workspace_path(pathname, AT_FDCWD)) { deny("file write", pathname); return -1; }
  if (!(flags & O_CREAT)) return real_open(pathname, flags);
  va_list ap; va_start(ap, flags); mode_t mode = va_arg(ap, mode_t); va_end(ap);
  return real_open(pathname, flags, mode);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
  static int (*real_openat)(int, const char *, int, ...) = NULL; if (!real_openat) real_openat = dlsym(RTLD_NEXT, "openat");
  if (write_flags(flags) && is_workspace_path(pathname, dirfd)) { deny("file write", pathname); return -1; }
  if (!(flags & O_CREAT)) return real_openat(dirfd, pathname, flags);
  va_list ap; va_start(ap, flags); mode_t mode = va_arg(ap, mode_t); va_end(ap);
  return real_openat(dirfd, pathname, flags, mode);
}

int open64(const char *pathname, int flags, ...) {
  static int (*real_open64)(const char *, int, ...) = NULL; if (!real_open64) real_open64 = dlsym(RTLD_NEXT, "open64");
  if (write_flags(flags) && is_workspace_path(pathname, AT_FDCWD)) { deny("file write", pathname); return -1; }
  if (!(flags & O_CREAT)) return real_open64(pathname, flags);
  va_list ap; va_start(ap, flags); mode_t mode = va_arg(ap, mode_t); va_end(ap);
  return real_open64(pathname, flags, mode);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
  static int (*real_openat64)(int, const char *, int, ...) = NULL; if (!real_openat64) real_openat64 = dlsym(RTLD_NEXT, "openat64");
  if (write_flags(flags) && is_workspace_path(pathname, dirfd)) { deny("file write", pathname); return -1; }
  if (!(flags & O_CREAT)) return real_openat64(dirfd, pathname, flags);
  va_list ap; va_start(ap, flags); mode_t mode = va_arg(ap, mode_t); va_end(ap);
  return real_openat64(dirfd, pathname, flags, mode);
}

int unlink(const char *pathname) { static int (*real)(const char *) = NULL; if (!real) real = dlsym(RTLD_NEXT, "unlink"); if (is_workspace_path(pathname, AT_FDCWD)) { deny("unlink", pathname); return -1; } return real(pathname); }
int unlinkat(int dirfd, const char *pathname, int flags) { static int (*real)(int,const char*,int) = NULL; if (!real) real = dlsym(RTLD_NEXT, "unlinkat"); if (is_workspace_path(pathname, dirfd)) { deny("unlink", pathname); return -1; } return real(dirfd, pathname, flags); }
int mkdir(const char *pathname, mode_t mode) { static int (*real)(const char*,mode_t) = NULL; if (!real) real = dlsym(RTLD_NEXT, "mkdir"); if (is_workspace_path(pathname, AT_FDCWD)) { deny("mkdir", pathname); return -1; } return real(pathname, mode); }
int mkdirat(int dirfd, const char *pathname, mode_t mode) { static int (*real)(int,const char*,mode_t) = NULL; if (!real) real = dlsym(RTLD_NEXT, "mkdirat"); if (is_workspace_path(pathname, dirfd)) { deny("mkdir", pathname); return -1; } return real(dirfd, pathname, mode); }
int rename(const char *oldpath, const char *newpath) { static int (*real)(const char*,const char*) = NULL; if (!real) real = dlsym(RTLD_NEXT, "rename"); if (is_workspace_path(oldpath, AT_FDCWD) || is_workspace_path(newpath, AT_FDCWD)) { deny("rename", oldpath); return -1; } return real(oldpath,newpath); }
int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) { static int (*real)(int,const char*,int,const char*) = NULL; if (!real) real = dlsym(RTLD_NEXT, "renameat"); if (is_workspace_path(oldpath, olddirfd) || is_workspace_path(newpath, newdirfd)) { deny("rename", oldpath); return -1; } return real(olddirfd,oldpath,newdirfd,newpath); }
