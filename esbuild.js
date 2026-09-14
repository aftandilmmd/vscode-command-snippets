const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Copy the codicon font + stylesheet into media/ so the webview can load them locally. */
function copyCodicons() {
  const from = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  const to = path.join(__dirname, 'media');
  if (!fs.existsSync(from)) {
    console.warn('[codicons] @vscode/codicons not installed, skipping copy');
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
  console.log('[codicons] copied codicon.css + codicon.ttf into media/');
}

async function main() {
  copyCodicons();

  const shared = {
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    logLevel: 'info'
  };

  const contexts = await Promise.all([
    esbuild.context({
      ...shared,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      external: ['vscode']
    }),
    // Standalone stdio MCP server: runs outside VS Code, so nothing is external.
    esbuild.context({
      ...shared,
      entryPoints: ['src/mcp/server.ts'],
      outfile: 'dist/mcp-server.js',
      banner: { js: '#!/usr/bin/env node' }
    })
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
