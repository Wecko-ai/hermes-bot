# NOTICE

This plugin comes from **Hermes Bot Kit** by Thomas Bekkers,
https://github.com/thomasbek3/hermes-bot-kit (release v2026.11.24.1, commit
96dde7c, folder `remote-cua/`), under the MIT License (full text in `LICENSE`).

Changes for HermesBot (2026-11-25): `install.sh` only takes named profiles,
copies from this repo (no download), runs dry unless `--apply`; this NOTICE
and the LICENSE are installed with the plugin. The plugin code is unchanged.
HermesBot drives its lease (take over / hand back) through
`scripts/remote-cua-lease.py`, which loads this plugin's `lease.py`.
