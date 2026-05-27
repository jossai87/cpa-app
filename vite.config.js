import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// https://vitejs.dev/config/
export default defineConfig(function (_a) {
    var _b;
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
    return {
        plugins: [react()],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        server: {
            port: 3000,
            proxy: {
                '/api': {
                    target: (_b = env.VITE_API_URL) !== null && _b !== void 0 ? _b : 'http://localhost:4000',
                    changeOrigin: true,
                    rewrite: function (p) { return p.replace(/^\/api/, ''); },
                },
            },
        },
        build: {
            outDir: 'dist',
            sourcemap: false,
            rollupOptions: {
                output: {
                    manualChunks: {
                        vendor: ['react', 'react-dom', 'react-router-dom'],
                        query: ['@tanstack/react-query'],
                        amplify: ['aws-amplify'],
                    },
                },
            },
        },
    };
});
