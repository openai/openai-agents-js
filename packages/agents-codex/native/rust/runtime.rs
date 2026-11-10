//! Companion executable for Codex's sandbox and execution helper modes.

#[cfg(target_os = "linux")]
mod linux_apparmor_probe;
#[cfg(target_os = "linux")]
mod linux_supervisor;
#[cfg(target_os = "linux")]
mod local_command_path;

fn main() -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::path::Path;

        let mut args = std::env::args_os();
        let executable = args.next().expect("the runtime has argv[0]");
        let executable = Path::new(&executable);
        if executable.file_name() == Some("codex-linux-sandbox".as_ref())
            && args.next().as_deref() == Some(linux_apparmor_probe::ARG.as_ref())
            && args.next().is_none()
        {
            std::process::exit(if linux_apparmor_denies_userns_capabilities() {
                linux_apparmor_probe::CONFIRMED_EXIT_CODE
            } else {
                1
            });
        }
        // Only the SDK's explicit installed-runtime entrypoint owns this mode.
        if executable.file_name() == Some("codex-sdk-runtime".as_ref())
            && args.next().as_deref() == Some("--sdk-unix-local".as_ref())
        {
            let helper = executable.with_file_name("codex-linux-sandbox");
            return linux_supervisor::run(&helper, args);
        }
        if executable.file_name() == Some("codex-linux-sandbox".as_ref())
            && let Some(path) = std::env::var_os(local_command_path::COMMAND_PATH_ENV)
        {
            // Bubblewrap resolves and probes host helpers in the outer stage.
            // Only its inner stage will use PATH to exec the payload.
            let inner_stage = std::env::args_os()
                .skip(1)
                .take_while(|argument| argument != "--")
                .any(|argument| argument == "--apply-seccomp-then-exec");
            // SAFETY: this is the fresh helper before dispatch starts any threads.
            unsafe {
                std::env::set_var(
                    "PATH",
                    if inner_stage {
                        path.as_os_str()
                    } else {
                        local_command_path::LOCAL_HELPER_PATH.as_ref()
                    },
                );
                if inner_stage {
                    std::env::remove_var(local_command_path::COMMAND_PATH_ENV);
                }
            }
        }
    }
    codex_arg0::arg0_dispatch_or_else(|_| async {
        anyhow::bail!("this executable is an internal Codex execution helper")
    })
}

#[cfg(target_os = "linux")]
fn linux_apparmor_denies_userns_capabilities() -> bool {
    // SAFETY: these syscalls affect only the fresh, single-threaded helper.
    if unsafe { libc::unshare(libc::CLONE_NEWUSER) } != 0 {
        return false;
    }
    let Ok(label) = std::fs::read("/proc/self/attr/apparmor/current") else {
        return false;
    };
    if label != b"unprivileged_userns (enforce)\n" {
        return false;
    }
    let result = unsafe { libc::unshare(libc::CLONE_NEWNET) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
