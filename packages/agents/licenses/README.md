# Included source licenses

These copies identify the source used by this package's native Codex and V8 components. They do not replace the package's own license.

- `codex/LICENSE` and `codex/NOTICE`: copied from the unchanged OpenAI Codex tree pinned by `native/CODEX_REVISION`, [commit 7c2ce90716335c889a5076ded9a630459f9c9899](https://github.com/openai/codex/tree/7c2ce90716335c889a5076ded9a630459f9c9899).
- `rusty-v8/LICENSE`: from [denoland/rusty_v8 commit 5c15a6995c9bb4bacd3e341b59fff32c909c80bf](https://github.com/denoland/rusty_v8/blob/5c15a6995c9bb4bacd3e341b59fff32c909c80bf/LICENSE). This is the VCS commit recorded in the locked `v8` crate 150.4.0. The crate archive SHA-256 matches `native/Cargo.lock`: `42a978ff11f15b24e5c05a7123cf2b68f41e763546699781a924ef4e2cf43a49`.
- `v8/LICENSE`: from [V8 version 15.0.245.2](https://github.com/v8/v8/blob/15.0.245.2/LICENSE). The version comes from `v8/include/v8-version.h` in the same locked crate. That file matches the official version's header byte for byte, SHA-256 `0cd3c8840484af7a01ad49ac8d0d4e8eee998acceb51c47307af66fdafc3c39b`.

V8's license describes separately maintained libraries with their own terms. This directory contains the Codex, Rusty V8 and V8 source licenses named above; it is not a complete inventory of all transitive dependencies.
