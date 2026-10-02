// Étape 218 (Léo : « mettre sur le téléphone quand le PC est éteint ou pas ») : la page est servie PAR le PC.
// PC éteint, le téléphone n'aurait donc qu'une erreur du navigateur. Ce service worker garde une copie des
// fichiers de la page (jamais des réponses de Jaris) : PC éteint, la page s'ouvre quand même et dit clairement
// que le PC ne répond pas. PC allumé, les fichiers sont toujours repris du PC d'abord (jamais une vieille
// version tant que le PC répond).
'use strict'

var CACHE = 'jaris-page-v1'
var FILES = ['/', '/app.js', '/app.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/logo.png']

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(FILES)
      })
      .then(function () {
        return self.skipWaiting()
      })
  )
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE
            })
            .map(function (key) {
              return caches.delete(key)
            })
        )
      })
      .then(function () {
        return self.clients.claim()
      })
  )
})

self.addEventListener('fetch', function (event) {
  var request = event.request
  if (request.method !== 'GET') return
  var url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Les échanges avec Jaris ne sont jamais gardés : seulement les fichiers de la page.
  if (url.pathname.indexOf('/api/') === 0) return
  var key = request.mode === 'navigate' ? '/' : url.pathname
  if (FILES.indexOf(key) < 0) return
  event.respondWith(
    fetch(request)
      .then(function (response) {
        // Le relais renvoie une page d'erreur quand le PC ne répond pas : on garde alors la copie.
        if (!response.ok) throw new Error('PC injoignable')
        var copy = response.clone()
        caches.open(CACHE).then(function (cache) {
          cache.put(key, copy)
        })
        return response
      })
      .catch(function () {
        return caches.match(key).then(function (cached) {
          return cached || Response.error()
        })
      })
  )
})
