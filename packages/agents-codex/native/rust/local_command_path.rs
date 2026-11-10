pub(crate) const LOCAL_HELPER_PATH: &str = "/usr/bin:/bin";

#[cfg(target_os = "linux")]
pub(crate) const COMMAND_PATH_ENV: &str = "OPENAI_AGENTS_SDK_COMMAND_PATH";
