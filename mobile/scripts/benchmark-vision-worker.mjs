#!/usr/bin/env node
// Real CPU Chromium + production classic Worker. This is not a camera-FPS test.
// Requires Python with Playwright and its installed Chromium (or --chromium PATH).
// Usage: node scripts/benchmark-vision-worker.mjs --frames 30 --out /tmp/vision.json
// --fixture /tmp/pose.jpg --fixture-source URL --side 640 --warmup 5 --require-hands 2
// --python python3 (or PLAYWRIGHT_PYTHON), --chromium PATH (or CHROMIUM)
import { readFile, readdir, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]);
  return a;
}, []));
const frames = Number(opts.frames ?? 30), warmup = Number(opts.warmup ?? 5);
const side = Number(opts.side ?? 640), requireHands = Number(opts['require-hands'] ?? 0);
if (![frames, warmup, side, requireHands].every(Number.isInteger) || frames < 1 || warmup < 0 ||
    side < 64 || side > 2048 || requireHands < 0 || requireHands > 2) throw new Error('Invalid benchmark arguments');
const dist = path.join(mobile, 'dist'), publicRoot = path.join(mobile, 'public');
const temporary = await mkdtemp(path.join(tmpdir(), 'motion-vision-benchmark-'));
let server;
const sha = data => createHash('sha256').update(data).digest('hex');
const sourceUrl = String(opts['fixture-source'] ?? 'https://storage.googleapis.com/mediapipe-assets/pose.jpg');
const PYTHON = String.raw`
import json, sys
from playwright.sync_api import sync_playwright
c = json.load(sys.stdin)
with sync_playwright() as p:
    launch = dict(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
    if c.get('chromium'):
        launch['executable_path'] = c['chromium']
    browser = p.chromium.launch(**launch)
    page = browser.new_page()
    logs = []
    page.on('console', lambda m: logs.append(m.type + ': ' + m.text))
    page.on('pageerror', lambda e: logs.append('pageerror: ' + str(e)))
    page.goto(c['url'], wait_until='load')
    page.wait_for_function('typeof window.runVisionBenchmark === "function"', timeout=120000)
    result = page.evaluate('(c) => window.runVisionBenchmark(c)', c['config'])
    result['browserVersion'] = browser.version
    result['browserLogs'] = logs[-30:]
    print(json.dumps(result))
    browser.close()
`;
function child(command, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Benchmark timeout')); }, 300000);
    p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(command + ' failed (' + code + '): ' + stderr.slice(-6000) + stdout.slice(-6000)));
    });
    p.stdin.end(input ?? '');
  });
}
async function assetFile(relative) {
  for (const root of [dist, publicRoot]) {
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(root + path.sep)) throw new Error('Unsafe asset path');
    try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error('Asset missing: ' + relative + '; run npm run build first');
}
try {
  const fixturePath = opts.fixture ? path.resolve(String(opts.fixture)) : path.join(temporary, 'pose.jpg');
  if (!opts.fixture) await child('curl', ['--fail','--silent','--show-error','--location','--retry','2', sourceUrl,'--output',fixturePath]);
  const fixture = await readFile(fixturePath);
  const assets = await readdir(path.join(dist, 'assets'));
  const workerName = assets.find(n => /^vision\.worker-.*\.js$/.test(n));
  const workerUrl = String(opts.worker ?? (workerName ? '/assets/' + workerName : ''));
  if (!workerUrl.startsWith('/assets/')) throw new Error('Production vision.worker bundle missing; build first');
  const workerBytes = await readFile(await assetFile(workerUrl.slice(1)));
  const visionPkgPath = path.join(mobile, 'node_modules/@mediapipe/tasks-vision');
  const visionPackage = JSON.parse(await readFile(path.join(visionPkgPath,'package.json'),'utf8'));
  const visionModule = path.join(visionPkgPath,'vision_bundle.mjs'), corePath = path.join(mobile,'src/vision-core.ts');
  const browserSource = [
    'import { FilesetResolver, PoseLandmarker, HandLandmarker } from ' + JSON.stringify(visionModule) + ';',
    'import { inferenceSize, handCropBox, packHandCrop, HAND_CROP_SIDE } from ' + JSON.stringify(corePath) + ';',
    String.raw`
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stats(values) {
  const a = [...values].sort((a,b) => a-b);
  return { samples:a.length, mean:a.reduce((s,v) => s+v,0)/Math.max(1,a.length),
    p50:a[Math.floor((a.length-1)*.5)]??0, p95:a[Math.floor((a.length-1)*.95)]??0, max:a.at(-1)??0 };
}
function differences(a,b) {
  let n=0,sum=0,max=0;
  const walk=(x,y) => {
    if(typeof x==='number' && typeof y==='number') {
      if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error('Nonfinite landmarks');
      const d=Math.abs(x-y); n++;sum+=d;max=Math.max(max,d);
    } else if(Array.isArray(x)&&Array.isArray(y)) {
      if(x.length!==y.length) throw new Error('Landmark array shape mismatch'); x.forEach((v,i)=>walk(v,y[i]));
    } else if(x&&y&&typeof x==='object'&&typeof y==='object') {
      if(Object.keys(x).sort().join()!==Object.keys(y).sort().join()) throw new Error('Landmark object shape mismatch');
      for(const k of Object.keys(x)) walk(x[k],y[k]);
    } else if(x!==y) throw new Error('Result shape/value mismatch');
  };
  walk(a,b);return {comparedNumbers:n,meanAbsolute:sum/Math.max(n,1),maxAbsolute:max};
}
window.runVisionBenchmark=async c=>{
  const img=new Image(); img.src='/__fixture'; await img.decode();
  const size=inferenceSize(img.naturalWidth,img.naturalHeight,c.side);
  // Check the prior main-canvas sampling against transferred-bitmap sampling
  // independently from landmark parity; this repeated image is not a video.
  const legacyCanvas=document.createElement('canvas');
  legacyCanvas.width=size.width;legacyCanvas.height=size.height;
  const legacyContext=legacyCanvas.getContext('2d',{alpha:false});
  legacyContext.drawImage(img,0,0,size.width,size.height);
  const bitmapCanvas=new OffscreenCanvas(size.width,size.height),bitmapContext=bitmapCanvas.getContext('2d',{alpha:false});
  const samplingBitmap=await createImageBitmap(img);
  bitmapContext.drawImage(samplingBitmap,0,0,size.width,size.height);samplingBitmap.close();
  const legacyPixels=legacyContext.getImageData(0,0,size.width,size.height).data;
  const bitmapPixels=bitmapContext.getImageData(0,0,size.width,size.height).data;
  let pixelSum=0,pixelMax=0,changedComponents=0;
  for(let i=0;i<legacyPixels.length;i++){
    const delta=Math.abs(legacyPixels[i]-bitmapPixels[i]);
    pixelSum+=delta;pixelMax=Math.max(pixelMax,delta);if(delta)changedComponents++;
  }
  const samplingComparison={components:legacyPixels.length,changedComponents,
    changedFraction:changedComponents/legacyPixels.length,meanAbsolute:pixelSum/legacyPixels.length,maxAbsolute:pixelMax,
    method:'DOM canvas drawImage(original image) versus OffscreenCanvas drawImage(original-size ImageBitmap), same inference dimensions'};
  const files=await FilesetResolver.forVisionTasks(new URL('/wasm',location.href).href);
  const pose=await PoseLandmarker.createFromOptions(files,{
    canvas:new OffscreenCanvas(1,1),baseOptions:{modelAssetPath:new URL('/models/pose_landmarker_full.task',location.href).href,delegate:'CPU'},
    runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.55,minPosePresenceConfidence:.55,minTrackingConfidence:.55});
  const hand=await HandLandmarker.createFromOptions(files,{
    canvas:new OffscreenCanvas(1,1),baseOptions:{modelAssetPath:new URL('/models/hand_landmarker.task',location.href).href,delegate:'CPU'},
    runningMode:'IMAGE',numHands:1});
  const worker=new Worker(c.workerUrl),pending=new Map();
  let readyResolve,readyReject;
  const readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  worker.onmessage=e=>{
    const r=e.data;
    if(r.type==='ready') readyResolve(r);
    else if(r.type==='result'||r.type==='error') {
      if(r.id!==undefined&&pending.has(r.id)) {
        const p=pending.get(r.id);pending.delete(r.id);
        if(r.type==='error')p.reject(new Error(r.message));else p.resolve(r);
      } else if(r.type==='error') {
        readyReject(new Error(r.message));for(const p of pending.values())p.reject(new Error(r.message));pending.clear();
      }
    }
  };
  worker.onerror=e=>{readyReject(new Error(e.message));for(const p of pending.values())p.reject(new Error(e.message));};
  worker.postMessage({type:'init',wasmBaseUrl:new URL('/wasm',location.href).href,
    poseModelUrl:new URL('/models/pose_landmarker_full.task',location.href).href,
    handModelUrl:new URL('/models/hand_landmarker.task',location.href).href,cpuOnly:true});
  const ready=await readyPromise;if(ready.delegate!=='CPU')throw new Error('Expected CPU Worker delegate');
  const image=new OffscreenCanvas(size.width,size.height),imageContext=image.getContext('2d',{alpha:false});
  const crop=new OffscreenCanvas(HAND_CROP_SIDE,HAND_CROP_SIDE),cropContext=crop.getContext('2d');
  async function frame(mode,index) {
    const wallStart=performance.now();
    // Match production capture: transfer original pixels, then scale once via
    // the inference canvas in either execution backend.
    const bitmapPromise=createImageBitmap(img);
    const bitmapCallMs=performance.now()-wallStart;
    const bitmap=await bitmapPromise;
    const bitmapMs=performance.now()-wallStart;let result,mainSyncMs;
    if(mode==='worker') {
      const p=new Promise((resolve,reject)=>pending.set(index,{resolve,reject}));
      const start=performance.now();
      worker.postMessage({type:'frame',id:index,bitmap,timestampMs:index*34,capturedAtMs:Date.now(),
        width:img.naturalWidth,height:img.naturalHeight,inferenceSide:c.side,hands:['left','right']},[bitmap]);
      mainSyncMs=performance.now()-start;result=await p;
    } else {
      const start=performance.now();imageContext.drawImage(bitmap,0,0,image.width,image.height);bitmap.close();
      const copyMs=performance.now()-start,poseStart=performance.now();
      const p=pose.detectForVideo(image,index*34),poseMs=performance.now()-poseStart;
      const handsStart=performance.now(),hands=[];
      for(const side of ['left','right']) {
        const box=p.landmarks[0]&&handCropBox(p.landmarks[0],side,image.width,image.height);if(!box)continue;
        cropContext.clearRect(0,0,HAND_CROP_SIDE,HAND_CROP_SIDE);
        cropContext.drawImage(image,box.sx,box.sy,box.side,box.side,0,0,HAND_CROP_SIDE,HAND_CROP_SIDE);
        const packed=packHandCrop(hand.detect(crop).landmarks[0],side,box,image.width,image.height);
        if(packed)hands.push(packed);
      }
      const handsMs=performance.now()-handsStart;mainSyncMs=performance.now()-start;
      result={landmarks:p.landmarks,worldLandmarks:p.worldLandmarks,hands,
        timings:{copyMs,poseMs,handsMs,totalMs:mainSyncMs}};
    }
    return {result,wallMs:performance.now()-wallStart,bitmapMs,bitmapCallMs,mainSyncMs};
  }
  let effectiveWarmup = 0;
  for (let i = 1; i <= 120; i++) {
    const r = await frame('worker', i);
    effectiveWarmup = i;
    const state = r.result.handState ?? 'ready';
    if (state === 'error' || r.result.handError) throw new Error('Worker hand model initialization failed: ' + (r.result.handError ?? state));
    if (i >= Math.max(c.warmup, 1) && state === 'ready') break;
    if (i === 120) throw new Error('Worker hand model did not become ready');
    await sleep(20);
  }
  async function phase(mode) {
    if (mode === 'main') for(let i=1;i<=effectiveWarmup;i++){await frame(mode,i);await sleep(0);}
    const rows=[],gaps=[];let last=performance.now();
    const timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;},10);
    const phaseStart=performance.now();
    for(let i=1;i<=c.frames;i++){rows.push(await frame(mode,effectiveWarmup+i));await sleep(0);}
    const durationMs=performance.now()-phaseStart;await sleep(25);clearInterval(timer);
    return {rows,summary:{frames:rows.length,durationMs,sequentialThroughputFramesPerSecond:rows.length*1000/durationMs,
      frameWallMs:stats(rows.map(r=>r.wallMs)),bitmapMs:stats(rows.map(r=>r.bitmapMs)),
      bitmapCallMs:stats(rows.map(r=>r.bitmapCallMs)),
      mainSynchronousWorkMs:stats(rows.map(r=>r.mainSyncMs)),heartbeatGapMs:stats(gaps),
      mainThreadSynchronousTotalMs:stats(rows.map(r=>r.bitmapCallMs+r.mainSyncMs)),
      heartbeatOvershootMs:stats(gaps.map(v=>Math.max(0,v-10))),
      stagesMs:Object.fromEntries(['copyMs','poseMs','handsMs','totalMs'].map(k=>[k,stats(rows.map(r=>r.result.timings[k]))]))}};
  }
  try {
    const main=await phase('main'),offthread=await phase('worker');
    const comparisons=main.rows.map((r,i)=>{
      const other=offthread.rows[i].result;if(other.handError)throw new Error('Worker hand error: '+other.handError);
      if (other.handState !== undefined && other.handState !== 'ready') throw new Error('Worker hand state not ready during measurement');
      return differences({landmarks:r.result.landmarks,worldLandmarks:r.result.worldLandmarks,hands:r.result.hands},
        {landmarks:other.landmarks,worldLandmarks:other.worldLandmarks,hands:other.hands});
    });
    const output=offthread.rows.map(r=>({poses:r.result.landmarks.length,posePoints:r.result.landmarks.map(p=>p.length),
      hands:r.result.hands.map(h=>({handedness:h.handedness,points:h.points.length}))}));
    const poseNonempty=output.every(r=>r.poses>0&&r.posePoints.every(n=>n===33));
    const validHands=output.every(r=>r.hands.every(h=>h.points===21));
    const bothHandsObserved=output.some(r=>new Set(r.hands.map(h=>h.handedness)).size===2);
    const minHands=Math.min(...output.map(r=>r.hands.length)),maxAbsolute=Math.max(...comparisons.map(r=>r.maxAbsolute));
    return {passed:poseNonempty&&validHands&&minHands>=c.requireHands&&maxAbsolute<=.0001,
      environment:{userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,cpuOnly:true,headless:true,crossOriginIsolated},
      frame:{originalWidth:img.naturalWidth,originalHeight:img.naturalHeight,inferenceWidth:size.width,inferenceHeight:size.height},
      samplingComparison,
      workerReady:ready,effectiveWarmupFrames:effectiveWarmup,fullModel:true,requestedHandSides:['left','right'],bothHandsObserved,
      minDetectedHands:minHands,poseNonempty,validHands,outputShapes:output,
      comparison:{maxAbsolute,perFrame:comparisons},main:main.summary,worker:offthread.summary,
      boundaries:['CPU delegate, headless Chromium; sequential repeated-image inference, not camera FPS.',
        'Both paths use an original-size bitmap and the same 2D canvas scaling; real video capture is not measured.',
        'Main synchronous work is inference/crop work for main, and postMessage for worker; bitmap call time is reported separately and included in mainThreadSynchronousTotalMs.',
        'Heartbeat measures main event-loop scheduling; real camera/GPU/device heat/battery are not measured.',
        'Landmark equality checks implementation parity on this fixture, not recognition accuracy.']};
  } finally {worker.terminate();pose.close();hand.close();}
};
`].join('\n');
  const {build}=await import(pathToFileURL(path.join(mobile,'node_modules/vite/dist/node/index.js')).href);
  const built=await build({configFile:false,root:mobile,logLevel:'error',
    plugins:[{name:'benchmark-entry',resolveId(id){if(id==='virtual:benchmark')return '\0virtual:benchmark';},
      load(id){if(id==='\0virtual:benchmark')return browserSource;}}],
    build:{write:false,target:'es2022',minify:false,
      rollupOptions:{input:'virtual:benchmark',output:{inlineDynamicImports:true}}}});
  const bundle=(Array.isArray(built)?built:[built]).flatMap(b=>b.output).find(o=>o.type==='chunk').code;
  server=createServer(async(req,res)=>{
    try {
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><script type="module" src="/__benchmark.js"></script>');return;}
      if(pathname==='/__benchmark.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle);return;}
      if(pathname==='/__fixture'){res.setHeader('Content-Type',fixture[0]===0x89?'image/png':'image/jpeg');res.end(fixture);return;}
      const file=await assetFile(pathname.slice(1));
      res.setHeader('Content-Type',{'.js':'text/javascript','.wasm':'application/wasm','.task':'application/octet-stream'}[path.extname(file)]??'application/octet-stream');
      res.end(await readFile(file));
    }catch(e){res.statusCode=404;res.end(String(e.message));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const raw=await child(String(opts.python??process.env.PLAYWRIGHT_PYTHON??'python3'),['-c',PYTHON],JSON.stringify({
    chromium:opts.chromium??process.env.CHROMIUM??null,
    url:'http://127.0.0.1:'+server.address().port,config:{frames,warmup,side,requireHands,workerUrl}}));
  const report=JSON.parse(raw);
  report.benchmark={generatedAt:new Date().toISOString(),requestedFrames:frames,requestedWarmup:warmup,
    inferenceSide:side,requiredHands:requireHands,note:opts.note??null,
    python:String(opts.python??process.env.PLAYWRIGHT_PYTHON??'python3'),
    chromium:opts.chromium??process.env.CHROMIUM??'Playwright default'};
  report.fixture={path:fixturePath,sourceUrl:opts.fixture&&!opts['fixture-source']?null:sourceUrl,bytes:fixture.length,sha256:sha(fixture)};
  report.assets={tasksVisionVersion:visionPackage.version,workerUrl,workerSha256:sha(workerBytes),sharedCoreSha256:sha(await readFile(corePath))};
  for(const name of ['models/pose_landmarker_full.task','models/hand_landmarker.task','wasm/vision_wasm_internal.js','wasm/vision_wasm_internal.wasm']){
    const bytes=await readFile(await assetFile(name));report.assets[name]={bytes:bytes.length,sha256:sha(bytes)};
  }
  const json=JSON.stringify(report,null,2)+'\n';if(opts.out)await writeFile(path.resolve(String(opts.out)),json);
  console.log(json);if(!report.passed)process.exitCode=1;
}finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await rm(temporary,{recursive:true,force:true});
}
