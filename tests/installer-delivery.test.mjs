import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile), root=path.resolve(import.meta.dirname,'..');

test('真实HTTPS轻量安装：中断保留旧版、再次运行206续传、完整缓存复用及损坏校验保护',async t=>{
  if(process.platform!=='darwin')return t.skip('需要真实macOS');
  let archive;try{archive=await fs.readFile(path.join(root,'dist/cli/releases/0.4.2/page-review-node.tar.gz'))}catch{return t.skip('先运行build:cli:light')}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'page-review-light-install-')),cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);await fs.chmod(key,0o600);
  const sha=createHash('sha256').update(archive).digest('hex'),requests=[];let base,cut=true,bad=false,stall=false;
  const server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},async(req,res)=>{
    requests.push({url:req.url,range:req.headers.range});
    if(req.url==='/install.sh'){res.end((await fs.readFile(path.join(root,'cli/install.sh'),'utf8')).replace('__API_ORIGIN__',base));return}
    if(req.url==='/releases/0.4.2/SHA256SUMS.node'){res.end((bad?'0'.repeat(64):sha)+'  page-review-node.tar.gz\n');return}
    if(req.url==='/releases/0.4.2/page-review-node.tar.gz'){
      const offset=req.headers.range?Number(/^bytes=(\d+)-$/.exec(req.headers.range)?.[1]):0;
      if(offset>=archive.length){res.writeHead(416,{'content-range':`bytes */${archive.length}`});res.end();return}
      res.writeHead(offset?206:200,{'content-type':'application/gzip','content-length':archive.length-offset,...(offset?{'content-range':`bytes ${offset}-${archive.length-1}/${archive.length}`}:{})});
      if(cut||stall){const n=Math.floor(archive.length/2);res.write(archive.subarray(0,n),()=>{if(cut){cut=false;res.destroy()}});return}
      res.end(archive.subarray(offset));return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='https://127.0.0.1:'+server.address().port;
  const installDir=path.join(dir,'bin'),config=path.join(dir,'connection.json');await fs.mkdir(installDir);await fs.writeFile(path.join(installDir,'page-review'),'previous-cli');await fs.writeFile(config,'preserve-connection');
  const env={...process.env,NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1',PAGE_REVIEW_INSTALL_DIR:installDir,PAGE_REVIEW_CACHE_DIR:path.join(dir,'cache'),PAGE_REVIEW_CONFIG:config,CURL_CA_BUNDLE:cert};
  const run=extra=>exec('/bin/sh',['-c',`curl -fsSL '${base}/install.sh' | sh`],{env:{...env,...extra},maxBuffer:1e6});
  try{
    await assert.rejects(run(),e=>/下载未完成/.test(e.stderr));assert.equal(await fs.readFile(path.join(installDir,'page-review'),'utf8'),'previous-cli');
    const resumed=await run();assert.match(resumed.stdout,/已安装.*node/);assert.match(resumed.stderr,/\[1\/4\].*已有Node/);assert(requests.some(x=>x.range&&Number(x.range.match(/\d+/)[0])>0));assert(!requests.some(x=>x.url.includes('darwin-')));
    const binary=path.join(installDir,'page-review');assert.equal((await exec(binary,['--version'],{env})).stdout.trim(),'0.4.2');assert.equal((await fs.stat(binary)).mode&0o777,0o755);
    const downloads=()=>requests.filter(x=>x.url.endsWith('.tar.gz')).length,before=downloads(),cached=await run();assert.match(cached.stderr,/完整缓存/);assert.equal(downloads(),before);
    const installed=await fs.readFile(binary);bad=true;await assert.rejects(run(),e=>/校验失败/.test(e.stderr));assert((await fs.readFile(binary)).equals(installed));assert.equal(await fs.readFile(config,'utf8'),'preserve-connection');bad=false;
    stall=true;const start=performance.now();await assert.rejects(run({PAGE_REVIEW_CACHE_DIR:path.join(dir,'stall-cache'),PAGE_REVIEW_DOWNLOAD_TIMEOUT:'1'}),e=>/下载未完成/.test(e.stderr));assert(performance.now()-start<6000);assert((await fs.readFile(binary)).equals(installed));
    console.log(JSON.stringify({archiveBytes:archive.length,interruptionProtected:true,resume206:true,cacheReuse:true,shaFailureProtected:true,timeoutBounded:true,connectionPreserved:true}));
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})}
});
