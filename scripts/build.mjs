import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { visibleMusicServices } from '../public/service-visibility.js';

const source = new URL('../public/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const assets = {};
async function visit(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name), route = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) { await visit(path, route); continue; }
    if (!types[extname(entry.name)]) continue;
    let bytes = await readFile(path);
    if (route === '/index.html') {
      let html = bytes.toString();
      html = html.replace(/<button[^>]*data-filter="qq"[^>]*>QQ Music<\/button>/g, '').replace(/<button[^>]*data-search-provider="qq"[^>]*>QQ Music<\/button>/g, '');
      html = html.replace(/<button\b[^>]*(?:data-filter|data-search-provider)="([^"]+)"[^>]*>[^<]*<\/button>/g, (button, provider) => visibleMusicServices.includes(provider) || provider === 'all' && visibleMusicServices.length > 1 ? button : '');
      html = html.replace(/<option\b[^>]*value="(spotify|apple|qq|youtube|ytmusic)"[^>]*>[^<]*<\/option>/g, (option, provider) => visibleMusicServices.includes(provider) ? option : '');
      html = html.replace('aria-label="Spotify playback progress"', 'aria-label="Music playback progress"');
      html = html.replaceAll('encrypted on the host Mac', 'encrypted in Jamama’s cloud storage').replaceAll('encrypted on the host Mac.', 'encrypted in Jamama’s cloud storage.');
      html = html.replace('Off: keep Jamama’s connection only in server memory, with an eight-hour inactivity limit.', 'Off: use a temporary encrypted connection that expires after eight inactive hours.');
      html = html.replace('QQ playlists are available on the Mac; requested songs must also exist on the host’s service.', 'Requested songs must also exist on the host’s music service.');
      bytes = Buffer.from(html);
    }
    if (route === '/app.js') {
      let code = bytes.toString();
      code = code.replace(/<option\b[^>]*value="(spotify|apple|qq|youtube|ytmusic)"[^>]*>[^<]*<\/option>/g, (option, provider) => visibleMusicServices.includes(provider) ? option : '');
      code = code.replace('Connect Spotify or Apple Music to load your own library. QQ Music search is available now.', 'Connect Apple Music or Spotify to load your library, or search the catalog.');
      code = code.replace("'<button class=\"button primary\" data-filter=\"qq\">Search QQ Music</button>'", "'<button class=\"button primary\" data-view=\"search\">Search Apple Music</button>'");
      code = code.replace('function renderListening() {', "function renderListening() { $('listening-panel').hidden = true; return;");
      code = code.replace('function renderPlayerSetup() {', "function renderPlayerSetup() { playerSetup.mode = 'web';");
      code = code.replace(/<button data-player-mode="mac"[^>]*>Spotify on this Mac<\/button>/, '');
      bytes = Buffer.from(code);
    }
    assets[route] = { type: types[extname(entry.name)], data: bytes.toString('base64') };
  }
}
await visit(fileURLToPath(source));
assets['/live-room.js'] = { type: types['.js'], data: Buffer.from(`export function createLiveRoom({url,token,onRoom,onEnded,onOffline,retryDelay=650}){
  const target=new URL(url); target.protocol=target.protocol==='wss:'?'https:':'http:';target.pathname=target.pathname.replace(/\\/socket$/,'');
  let timer,controller,closed=false,failures=0;
  async function tick(){if(closed)return;controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
    try{const response=await fetch(target.href,{headers:{Authorization:'Bearer '+token},credentials:'same-origin',signal:controller.signal,cache:'no-store'});
      if(closed)return;if([401,404].includes(response.status)){closed=true;onEnded();return;}if(!response.ok)throw new Error('Room unavailable');
      const room=await response.json();if(closed)return;failures=0;onRoom(room);
    }catch{if(!closed){failures++;onOffline();}}finally{clearTimeout(timeout);if(!closed)timer=setTimeout(tick,Math.min(10000,retryDelay*Math.max(1,failures)));}}
  void tick();return{close(){closed=true;clearTimeout(timer);controller?.abort();}};
}`).toString('base64') };
await writeFile('worker/assets.mjs', `export const assets = ${JSON.stringify(assets)};\n`);
await mkdir('dist/server', { recursive: true });
await build({ entryPoints: ['worker/index.js'], outfile: 'dist/server/index.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['browser'], minify: true });
console.log(`Built Jamama with ${Object.keys(assets).length} real application assets.`);
