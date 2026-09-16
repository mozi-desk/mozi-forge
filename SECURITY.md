# Security

Use the repository's private vulnerability reporting facility when available.
If it is unavailable, open an issue requesting a private reporting channel without
including exploit details, credentials or private data. Maintainers will arrange
an appropriate channel; this project makes no response-time commitment.

Report the affected revision, impact and a minimal reproduction with synthetic
data. Do not send real provider credentials or private session logs.

The example executes a local shell. Run it in a development environment with
appropriately scoped filesystem access. Evaluate external prompts and plugins
before allowing them to execute code. Human review gates govern training workflow;
they do not provide operating-system isolation.
