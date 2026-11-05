#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int record_child(const char *tag) {
    FILE *file = fopen(tag, "w");
    if (file == NULL) {
        return -1;
    }
    int written = fprintf(file, "%ld\n", (long)getpid());
    return fclose(file) == 0 && written > 0 ? 0 : -1;
}

int main(int argc, char **argv) {
    int ready_pipe[2];
    if (pipe(ready_pipe) == -1) {
        return 1;
    }
    pid_t child = fork();
    if (child == -1) {
        return 2;
    }
    if (child > 0) {
        close(ready_pipe[1]);
        // The tracked command waits until the child reaches the release barrier.
        char ready;
        if (read(ready_pipe[0], &ready, 1) == 1) {
            return 0;
        }
        // A sandbox may terminate the child instead of returning from setsid().
        waitpid(child, NULL, 0);
        return 3;
    }
    close(ready_pipe[0]);
    if (argc > 1 && record_child(argv[1]) == -1) {
        return 8;
    }
    int detached = setsid() != -1;
    // The tagged mode tests shutdown even if the sandbox denies detachment.
    if ((!detached && argc == 1) || write(ready_pipe[1], "1", 1) != 1) {
        return 4;
    }
    close(ready_pipe[1]);

    // Let the host attempt revocation before the write. Exit if the test fails.
    for (int attempt = 0; attempt < 3000; ++attempt) {
        if (access("release", F_OK) == 0) {
            FILE *marker = fopen("../original/marker", "w");
            if (marker == NULL) {
                return 5;
            }
            fputs("old grant", marker);
            return fclose(marker) == 0 ? 0 : 6;
        }
        usleep(10000);
    }
    return 7;
}
