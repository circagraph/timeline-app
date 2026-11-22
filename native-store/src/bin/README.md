# native-store/src/bin

Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only

Command-line tools built from the native store (`cargo build --manifest-path native-store/Cargo.toml --release --locked --bin <name>`). The server runs `cg-convert` from `native-store/target/release/` unless `OCH_CONVERTER` names another; `cg-seed` is for the benchmarks ([`bench/`](../../../bench/README.md)).

## Contents

| File                             | What it is for                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`cg-convert.rs`](cg-convert.rs) | Converts between SQLite timeline files and JSON for the server, one file per process, within size and resource limits. |
| [`cg-seed.rs`](cg-seed.rs)       | Writes benchmark timelines as SQLite files, without the converter's size limits.                                       |
