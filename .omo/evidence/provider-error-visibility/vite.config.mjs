import { defineConfig } from '../../../frontend/node_modules/vite/dist/node/index.js';
import react from '../../../frontend/node_modules/@vitejs/plugin-react/dist/index.js';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({root:here,plugins:[react()],resolve:{dedupe:['react','react-dom'],alias:{react:here+'../../../frontend/node_modules/react','react-dom':here+'../../../frontend/node_modules/react-dom'}},build:{outDir:here+'temporary/harness-dist',emptyOutDir:true}});
