# Circagraph Homebrew tap

The [Circagraph](https://github.com/circagraph/timeline-app) server for macOS.

```sh
brew install circagraph/tap/circagraph-server
circagraph-setup
```

`circagraph-setup` starts PostgreSQL 17 (with `brew services`) if needed, creates the
database, and starts the server on <http://localhost:5173>. See
`$(brew --prefix)/share/doc/circagraph-server/README.Homebrew` once installed.

Until 0.30 the formula was `openchronology-server` (Circagraph was called OpenChronology).
`brew update && brew upgrade` moves an installation of it to `circagraph-server`
(`formula_renames.json`), keeping its configuration and database; then run
`circagraph-migrate` once, which also moves its service and launchd agents to the new names.

The formula is published here by each stable release of `circagraph/timeline-app`
(`deploy/homebrew` there); please report problems in that repository.
