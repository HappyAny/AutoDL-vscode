# Security

## Credential Handling

AutoDL tokens are stored through VS Code SecretStorage. The extension also supports `AUTODL_TOKEN` as a local environment fallback. Do not commit tokens, root passwords, private keys, SSH config contents, or generated catalog caches.

When connecting to instances, the extension may copy the AutoDL root password to the clipboard. For unattended SSH and folder sync, prefer `AutoDL: Set SSH Public Key` before creating instances.

## SSH Behavior

Managed AutoDL SSH hosts are written to `~/.ssh/config` as `autodl-*` aliases. These hosts use a separate `~/.ssh/autodl-vscode-known_hosts` file to keep AutoDL proxy host-key handling isolated from the user's normal known-hosts file.

Use `AutoDL: Clean SSH Config` to remove stale AutoDL-managed SSH blocks.

## Reporting Issues

Do not include secrets in public issues. Redact:

- AutoDL tokens
- root passwords
- SSH private keys
- Jupyter tokens and domains
- private hostnames
- full instance UUIDs when not needed
