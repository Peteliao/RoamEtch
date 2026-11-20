import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          charts: ['uplot'],
          vendor: ['dexie', 'i18next', 'fflate', 'exifr']
        }
      }
    }
  },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        name: 'TrackMint迹刻 · 行程记录',
        short_name: 'TrackMint',
        description: 'Offline-first trip recorder with dual-region adaptive maps',
        theme_color: '#0b1220',
        background_color: '#0b1220',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/(tile\.openstreetmap\.org|.*\.tile\.openstreetmap\.org)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tiles-osm',
              expiration: { maxEntries: 600, maxAgeSeconds: 30 * 24 * 3600 }
            }
          },
          {
            urlPattern: /^https:\/\/(webrd0\d\.is\.autonavi\.com|wprd0\d\.is\.autonavi\.com)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tiles-amap',
              expiration: { maxEntries: 600, maxAgeSeconds: 30 * 24 * 3600 }
            }
          },
          {
            urlPattern: /^https:\/\/t\d\.tianditu\.gov\.cn\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tiles-tianditu',
              expiration: { maxEntries: 600, maxAgeSeconds: 30 * 24 * 3600 }
            }
          },
          {
            urlPattern: /^https:\/\/(server\.arcgisonline\.com|.*\.opentopomap\.org)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tiles-global-extra',
              expiration: { maxEntries: 400, maxAgeSeconds: 30 * 24 * 3600 }
            }
          },
          {
            urlPattern: /^https:\/\/api\.open-meteo\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-elevation',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 }
            }
          }
        ]
      }
    })
  ]
});