import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5199, strictPort: true } });
await server.listen();
console.log('up');
setTimeout(() => process.exit(0), 30000);
