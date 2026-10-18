# Readest patch

Vendored from the published `turso_ext` 0.6.1 crate, upstream commit
`76af5a1250cd98bb26c13862093a638714b0a3a6` (`extensions/core`).
`LICENSE.md` is the upstream MIT license at that commit.

The only source change makes `build.rs` use `CARGO_CFG_TARGET_OS` instead of
the build-script host's `cfg!(target_os)`. Windows still links `advapi32`;
Android cross-compilation from Windows does not.
