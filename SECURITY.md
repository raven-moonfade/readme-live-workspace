# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| < 1.0 | No |

## Reporting a vulnerability

Please use **GitHub Security Advisories** to report vulnerabilities privately:

https://github.com/raven-moonfade/readme-live-workspace/security/advisories/new

Do not open a public issue containing credentials, tokens, cookies, private
room data, or other sensitive information.

Please include:

- affected version and Windows version;
- a minimal reproduction or proof of concept;
- impact and any known workaround;
- whether the issue requires a local attacker or only a remote service.

We will acknowledge a complete report as soon as possible and coordinate a
fix and disclosure window with the reporter.

## Scope

The project handles Bilibili and Douyin session credentials, local history,
exported reports, and a local overlay IPC channel. Reports about credential
handling, local process isolation, arbitrary file access, or unintended
network exposure are in scope.

The project does not control platform APIs. Platform-side outages, account
restrictions, or changes to third-party services are not security
vulnerabilities in this repository.
