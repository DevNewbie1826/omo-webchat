import { resolve } from 'node:path';
const root = resolve(import.meta.dir, 'temporary/harness-dist');
const server = Bun.serve({hostname:'127.0.0.1',port:18219,async fetch(request){const pathname=new URL(request.url).pathname;const file=Bun.file(resolve(root,'.'+(pathname==='/'?'/index.html':pathname)));return await file.exists()?new Response(file):new Response('Not found',{status:404});}});
console.log(JSON.stringify({ready:true,pid:process.pid,port:server.port}));
process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});
