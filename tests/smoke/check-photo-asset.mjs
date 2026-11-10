import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    'Check the photo Lambda asset on Linux x64 (CI or CloudShell).',
  );
}

const outputDir = path.resolve('infrastructure/aws/cdk.out');
const manifest = JSON.parse(
  await readFile(
    path.join(outputDir, 'Des424G02ScfrmsDev.assets.json'),
    'utf8',
  ),
);
const asset = Object.values(manifest.files).find(
  (file) => file.displayName === 'GetPhotoAccess/Code',
);
if (!asset?.source?.path) {
  throw new Error('Synthesize with enablePhotoAccess=true first.');
}

const assetDir = path.join(outputDir, asset.source.path);
const bundledHandler = await readFile(path.join(assetDir, 'index.js'), 'utf8');
if (!bundledHandler.includes('getPhotoAccessBootstrap')) {
  throw new Error('The photo Lambda asset omitted staff secret bootstrap.');
}
const nativeDir = path.join(assetDir, 'node_modules/@img/sharp-linux-x64/lib');
const nativeFiles = await readdir(nativeDir);
if (!nativeFiles.some((name) => name.endsWith('.node'))) {
  throw new Error('The photo Lambda asset has no Linux x64 sharp binary.');
}

const requireFromAsset = createRequire(path.join(assetDir, 'index.js'));
const sharp = requireFromAsset('sharp');
const image = await sharp({
  create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
})
  .jpeg()
  .toBuffer();
if (image.length === 0) {
  throw new Error('The packaged sharp module could not create a JPEG.');
}

console.log('Photo Lambda asset includes working Linux x64 sharp.');
