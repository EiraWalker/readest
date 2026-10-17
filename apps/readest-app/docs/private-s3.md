# Private S3 on Windows

This build uses a personal S3-compatible bucket for the library, replica data,
resource bundles, reading statistics, and sync-passphrase metadata. It does not
require a Readest account or a separate API/database deployment.

The first supported target is Windows. A new library binds to one bucket; use a
separate application data directory for another library. The normal build remains
available with its existing account and provider behavior.

## Build and run

From the monorepo, with the existing dependencies and Windows toolchain installed:

```powershell
pnpm --filter @readest/readest-app tauri:build:private-s3
```

The private Tauri overlay uses the product name **Readest Private**, the application
identifier **com.readest.private-s3**, and the **readest-private** URL scheme. Copy
the resulting executable into a new installation directory before launching it.
Its configuration and library are created in the adjacent **ReadestPrivate**
directory. Do not copy an existing library into this directory.

For daily use, run the supplied **Start Readest Private.cmd** beside the executable.
It sets `WEBVIEW2_USER_DATA_FOLDER` to the adjacent **WebView2** directory before
starting the app. The identifier separates this build from the ordinary app;
the launcher gives each installation copy its own WebView profile. An equivalent
launcher in the installation directory is:

```bat
@echo off
setlocal
set "WEBVIEW2_USER_DATA_FOLDER=%~dp0WebView2"
start "" /D "%~dp0" "%~dp0readest-private.exe"
endlocal
```

In Settings → Integrations → S3, configure the private bucket. Qiniu's North China
region uses **cn-north-1** and **https://s3.cn-north-1.qiniucs.com**. Use the actual
S3 bucket name shown by the provider. Credentials are entered separately on each
device and stored in Windows Credential Manager; only a device-local reference
is written to configuration. Private credentials are excluded from exports,
backups, and settings replicas.

The first connection binds the library to that endpoint and bucket. To rotate
credentials, disconnect and reconnect the same space with the replacement keys.
A different space requires a separate library; remote settings cannot redirect
this library's S3 connection.

Manage Sync remains available from the settings menu and Integrations. It uses
the existing category switches and optional sync-passphrase controls. The private
build removes Readest Cloud, official Voice, the official DeepL proxy, and email
inbox entry points. Local and independently configured providers remain available.

## Data behavior

- Books, covers, progress and annotations use the existing file-sync format and
  merge rules. Their triggers, retries, deletion semantics and existing concurrent
  write limitations remain unchanged.
- OPDS retains an existing local settings limitation: a reader window holding old
  settings can overwrite a catalog change when it later saves. Close reader
  windows before editing OPDS catalogs.
- Replica categories keep their existing adapters and CRDT merge rules. Each
  device writes its cumulative category state independently. Pulls discover
  device objects rather than treating a device clock as a global arrival cursor.
- Incremental pulls acknowledge local metadata application separately from fetch.
  Unchanged acknowledged rows do not overwrite later local edits; unsuccessful
  application or decryption remains eligible for retry. This acknowledgement is
  session-local, and startup still performs a full pull. Binary download and
  repair retries retain their existing behavior.
- Application also rechecks local preparation, queued uploads and later committed
  state after asynchronous reads or decryption. An older response waits for a
  later pull instead of replacing an edit being prepared or uploaded. Field clocks
  are assigned before encryption so a slow earlier encryption cannot win over a
  later edit.
- Settings wait for the first remote read. An empty space receives locally saved
  preferences, including changes saved before connecting and restarting. An
  existing space applies its settings first instead of receiving device defaults.
- When Windows WebView2 provides Web Locks, windows sharing a profile serialize
  replica, salt, and statistics writes by space and device. This does not change
  the existing file-sync engine's concurrent-write limits.
- Resource bundles retain the existing file-first, manifest-last transfer and
  integrity checks. Reading statistics retain their independent event identity
  and longer-duration merge rules.
- Only the fields already covered by optional credential encryption are encrypted.
  Books and notes do not gain a new whole-library encryption layer or passphrase.
- Encrypted replica values are stored separately from mutable metadata. Forgetting
  a passphrase publishes a reset and removes revoked ciphertext objects without
  overwriting another device's metadata. Late revoked ciphertext is ignored and
  cleaned on subsequent synchronization. Bucket version-history erasure is not
  part of this feature.

The Qiniu endpoint tested during implementation accepts stale **If-Match** PUTs.
The private replica transport therefore does not rely on conditional writes for
correctness.

## Acceptance

Use two independent application directories and WebView profiles with the same
bucket and distinct device identities. Exercise actual import, reading, notes,
settings, statistics, resource transfers, restarts, credential storage and the
existing passphrase flow. Block official account/storage/sync APIs during these
flows. Keep regular update checks separate from the sync network assertion.

The Windows single-instance plugin is keyed by application identifier. With one
private binary, run the two profiles in sequence; two simultaneous windows require
separate test identifiers. Never use the daily installation for acceptance.

Requirements and scope: [Issue #5](https://github.com/EiraWalker/readest/issues/5).
