# smol-toml 1.9.1

Vendored unmodified `dist/index.cjs` from the npm `smol-toml@1.9.1` release
(npm tarball `smol-toml-1.9.1.tgz`).
Upstream: `squirrelchat/smol-toml` on GitHub.
License: BSD-3-Clause; see LICENSE.

The trusted worker uses the parser to validate the complete TOML document before
planning a semantic MCP patch. Serialization of existing configuration remains in
`deploy/toml-mcp-text-patcher.mjs`, matching the existing table patch behavior.
The bundled file requires no npm install or build step on the user's machine.
