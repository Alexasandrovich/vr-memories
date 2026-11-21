const {chromium}=require('playwright');
const fs=require('node:fs');
(async()=>{
const b=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await b.newPage();page.on('pageerror',e=>console.error(e.message));page.on('console',msg=>{if(msg.type()==='error')console.error(msg.text())});
 await page.goto(process.argv[2]);
 await page.waitForFunction(()=>typeof window.replay==='function',null,{timeout:60000});
 for(let eye=0;eye<2;eye++)for(let mode=0;mode<2;mode++){
 const fd=fs.openSync(require('node:path').join(process.argv[3],'edge-'+eye+'-'+mode+'.rgb'),'w');
 try{for(let t=0;t<=52;t++){
 const buf=await page.evaluate(([t,eye,mode])=>window.replay(t,eye,mode),[t,eye,mode]);fs.writeSync(fd,Buffer.from(buf,'base64'));
 }}finally{fs.closeSync(fd);}
 }
 console.log('Rendered 212 WebGL eye images');
}finally{await b.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
