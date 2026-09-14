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

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info'
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
