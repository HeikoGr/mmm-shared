# Security Policy

## Supported versions

Only the latest state of `main` receives fixes. The MagicMirror modules include this repository as a
git submodule and pick up a fix with their next release.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on
[this repository](https://github.com/HeikoGr/mmm-shared/security/advisories/new).

Include which module and version you saw it in, what an attacker can reach (the mirror's web port,
the local machine) and the steps to reproduce. Never attach a `config.js`, credentials or unredacted
logs.

You will get an answer within two weeks. The advisory is published once the affected modules ship a
fixed version.

## What this code handles

- the module configuration each browser sends once (`CONFIGURE`), which can carry credentials of the
  module that uses it
- the browser sockets of every open mirror page and which module instance they belong to
- log entries of the modules: `createLogger()` replaces values under keys such as `password`,
  `token`, `apikey`, `secret`, `qrcode` with `***redacted***`; secrets inside free text (messages,
  URLs) are up to the module that writes them
