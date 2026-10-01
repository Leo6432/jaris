// Page du téléphone (étape 214). Aucune bibliothèque : le code doit rester lisible et ne rien charger
// d'ailleurs (la page interdit tout script extérieur, voir l'en-tête Content-Security-Policy du serveur).
'use strict'
;(function () {
  var TOKEN_KEY = 'jaris.phone.token'
  var JOB_KEY = 'jaris.phone.job'
  var POLL_MS = 1200
  var MAX_RECORD_MS = 120000

  var $ = function (id) {
    return document.getElementById(id)
  }

  function readStorage(storage, key) {
    try {
      return storage.getItem(key)
    } catch (e) {
      return null
    }
  }
  function writeStorage(storage, key, value) {
    try {
      if (value === null) storage.removeItem(key)
      else storage.setItem(key, value)
    } catch (e) {
      // stockage indisponible (navigation privée) : la connexion ne survivra pas à la fermeture de la page
    }
  }

  var token = readStorage(localStorage, TOKEN_KEY)
  var busy = false

  function deviceName() {
    var ua = navigator.userAgent || ''
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua)) return 'iPad'
    if (/Android/.test(ua)) return 'Android'
    return 'Téléphone'
  }

  function api(method, path, body, contentType) {
    var headers = {}
    if (token) headers.Authorization = 'Bearer ' + token
    if (body !== undefined) headers['Content-Type'] = contentType || 'application/json'
    return fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
      cache: 'no-store'
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {}
        })
        .then(function (data) {
          if (res.status === 401 && path !== '/api/pair') {
            forgetToken('Ce téléphone a été déconnecté depuis le PC. Entre un nouveau code pour le reconnecter.')
            throw new Error('Non connecté.')
          }
          if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status)
          return data
        })
    })
  }

  // --- Affichage -------------------------------------------------------------------------------------

  /** Texte de Jaris : sûr (jamais interprété comme du HTML), avec seulement le gras **…** mis en forme. */
  function renderText(element, text) {
    element.textContent = ''
    String(text || '')
      .split(/(\*\*[^*\n]+\*\*)/)
      .forEach(function (part) {
        if (/^\*\*[^*\n]+\*\*$/.test(part)) {
          var strong = document.createElement('strong')
          strong.textContent = part.slice(2, -2)
          element.appendChild(strong)
        } else if (part) {
          element.appendChild(document.createTextNode(part))
        }
      })
  }

  function addMessage(role, text, options) {
    options = options || {}
    var list = $('messages')
    var empty = list.querySelector('.empty')
    if (empty) empty.remove()
    var item = document.createElement('li')
    item.className = 'message message--' + role + (options.pending ? ' message--pending' : '') + (options.error ? ' message--error' : '')
    var body = document.createElement('div')
    renderText(body, text)
    item.appendChild(body)
    if (options.image && /^data:image\//.test(options.image)) {
      var img = document.createElement('img')
      img.src = options.image
      img.alt = 'Image créée par Jaris'
      item.appendChild(img)
    }
    list.appendChild(item)
    list.scrollTop = list.scrollHeight
    return { item: item, body: body }
  }

  function showEmpty() {
    var list = $('messages')
    list.textContent = ''
    var li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'Écris ou envoie un message vocal : Jaris répond depuis ton PC, sans rien envoyer ailleurs.'
    list.appendChild(li)
  }

  function setStatus(text) {
    $('chat-status').textContent = text
  }

  function setBusy(value) {
    busy = value
    $('send').disabled = value
    $('mic').disabled = value
    document.querySelector('.chat__header .orb').classList.toggle('orb--busy', value)
    if (!value) setStatus('Connecté à ton PC')
  }

  // --- Appairage -------------------------------------------------------------------------------------

  function forgetToken(message) {
    token = null
    writeStorage(localStorage, TOKEN_KEY, null)
    showPair(message)
  }

  function showPair(message, code) {
    $('chat').hidden = true
    $('pair').hidden = false
    var error = $('pair-error')
    error.hidden = !message
    error.textContent = message || ''
    if (code) $('pair-code').value = code
  }

  function pair(code) {
    var digits = String(code || '').replace(/\D/g, '')
    if (digits.length !== 8) {
      showPair('Le code fait 8 chiffres.')
      return
    }
    $('pair-submit').disabled = true
    api('POST', '/api/pair', { code: digits, name: deviceName() })
      .then(function (data) {
        token = data.token
        writeStorage(localStorage, TOKEN_KEY, token)
        showChat()
      })
      .catch(function (err) {
        showPair(err.message, digits)
      })
      .then(function () {
        $('pair-submit').disabled = false
      })
  }

  // --- Conversation ----------------------------------------------------------------------------------

  function showChat() {
    $('pair').hidden = true
    $('chat').hidden = false
    api('GET', '/api/history')
      .then(function (data) {
        var messages = data.messages || []
        if (!messages.length) showEmpty()
        else {
          $('messages').textContent = ''
          messages.forEach(function (m) {
            addMessage(m.role === 'user' ? 'user' : 'assistant', m.content, { image: m.image })
          })
        }
        var pending = readStorage(sessionStorage, JOB_KEY)
        if (pending) follow(pending, addMessage('assistant', 'Jaris réfléchit…', { pending: true }), null)
      })
      .catch(function (err) {
        if (token) setStatus(err.message)
      })
  }

  /** Suit une réponse en cours jusqu'au bout. `userBubble` reçoit la transcription d'un message vocal. */
  function follow(jobId, pendingBubble, userBubble) {
    setBusy(true)
    writeStorage(sessionStorage, JOB_KEY, jobId)
    var finish = function () {
      writeStorage(sessionStorage, JOB_KEY, null)
      setBusy(false)
    }
    var tick = function () {
      api('GET', '/api/jobs/' + jobId)
        .then(function (job) {
          if (userBubble && job.transcript) renderText(userBubble.body, job.transcript)
          if (job.state === 'running') {
            renderText(pendingBubble.body, job.status || 'Jaris réfléchit…')
            setStatus(job.status || 'Jaris réfléchit…')
            setTimeout(tick, POLL_MS)
            return
          }
          pendingBubble.item.remove()
          if (job.state === 'done') addMessage('assistant', job.reply, { image: job.image })
          else {
            if (userBubble && !job.transcript) renderText(userBubble.body, 'Message vocal')
            addMessage('assistant', job.error || 'Erreur sur le PC.', { error: true })
          }
          finish()
        })
        .catch(function (err) {
          if (!token) return finish()
          if (/introuvable/i.test(err.message)) {
            // Jaris redémarré entre-temps : la réponse est peut-être déjà dans l'historique.
            pendingBubble.item.remove()
            finish()
            showChat()
            return
          }
          // Réseau coupé (tunnel, 4G) : on réessaie un peu plus tard, la réponse continue sur le PC.
          setStatus('Connexion perdue, nouvel essai…')
          setTimeout(tick, POLL_MS * 3)
        })
    }
    tick()
  }

  function sendText() {
    var input = $('input')
    var text = input.value.trim()
    if (!text || busy) return
    input.value = ''
    autosize()
    addMessage('user', text)
    var pending = addMessage('assistant', 'Jaris réfléchit…', { pending: true })
    setBusy(true)
    api('POST', '/api/message', { text: text })
      .then(function (data) {
        follow(data.jobId, pending, null)
      })
      .catch(function (err) {
        pending.item.remove()
        addMessage('assistant', err.message, { error: true })
        setBusy(false)
      })
  }

  function autosize() {
    var input = $('input')
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 140) + 'px'
  }

  // --- Message vocal ---------------------------------------------------------------------------------
  // Le téléphone enregistre dans son propre format (webm ou mp4 selon la marque), puis le décode et le
  // convertit LUI-MÊME en WAV 16 kHz mono : le PC reçoit toujours le même format simple, celui que sa
  // transcription locale lit directement, quel que soit le téléphone.

  var recorder = null
  var chunks = []
  var recordStart = 0
  var recordTimer = null
  var recordStream = null
  var cancelled = false

  function formatTime(ms) {
    var s = Math.floor(ms / 1000)
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
  }

  function stopTracks() {
    if (recordStream)
      recordStream.getTracks().forEach(function (t) {
        t.stop()
      })
    recordStream = null
  }

  function startRecording() {
    if (busy || recorder) return
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      addMessage('assistant', "Ce navigateur ne permet pas d'enregistrer un message vocal.", { error: true })
      return
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        recordStream = stream
        chunks = []
        cancelled = false
        recorder = new MediaRecorder(stream)
        recorder.ondataavailable = function (e) {
          if (e.data && e.data.size) chunks.push(e.data)
        }
        recorder.onstop = function () {
          stopTracks()
          clearInterval(recordTimer)
          $('recording').hidden = true
          $('composer').hidden = false
          var type = recorder.mimeType
          recorder = null
          if (!cancelled && chunks.length) sendVoice(new Blob(chunks, { type: type }))
        }
        recorder.start()
        recordStart = Date.now()
        $('composer').hidden = true
        $('recording').hidden = false
        $('recording-time').textContent = '0:00'
        recordTimer = setInterval(function () {
          var elapsed = Date.now() - recordStart
          $('recording-time').textContent = formatTime(elapsed)
          if (elapsed >= MAX_RECORD_MS) stopRecording(false)
        }, 250)
      })
      .catch(function () {
        addMessage('assistant', "Micro refusé : autorise le micro pour cette page dans les réglages du téléphone.", { error: true })
      })
  }

  function stopRecording(cancel) {
    if (!recorder) return
    cancelled = cancel
    recorder.stop()
  }

  function toWav16k(blob) {
    var AudioCtx = window.AudioContext || window.webkitAudioContext
    return blob.arrayBuffer().then(function (data) {
      var ctx = new AudioCtx()
      return new Promise(function (resolve, reject) {
        ctx.decodeAudioData(data, resolve, reject)
      }).then(function (decoded) {
        ctx.close()
        var length = Math.max(1, Math.ceil(decoded.duration * 16000))
        var offline = new OfflineAudioContext(1, length, 16000)
        var source = offline.createBufferSource()
        source.buffer = decoded
        source.connect(offline.destination)
        source.start()
        return offline.startRendering()
      })
    }).then(function (rendered) {
      return encodeWav(rendered.getChannelData(0), 16000)
    })
  }

  function encodeWav(samples, rate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2)
    var view = new DataView(buffer)
    var writeString = function (offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    writeString(0, 'RIFF')
    view.setUint32(4, 36 + samples.length * 2, true)
    writeString(8, 'WAVE')
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeString(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return new Blob([buffer], { type: 'audio/wav' })
  }

  function sendVoice(blob) {
    var userBubble = addMessage('user', 'Message vocal…')
    var pending = addMessage('assistant', 'Préparation du message vocal…', { pending: true })
    setBusy(true)
    toWav16k(blob)
      .then(function (wav) {
        return api('POST', '/api/voice', wav, 'audio/wav')
      })
      .then(function (data) {
        follow(data.jobId, pending, userBubble)
      })
      .catch(function (err) {
        pending.item.remove()
        renderText(userBubble.body, 'Message vocal')
        addMessage('assistant', err.message || "Le message vocal n'a pas pu être envoyé.", { error: true })
        setBusy(false)
      })
  }

  // --- Démarrage -------------------------------------------------------------------------------------

  $('pair-form').addEventListener('submit', function (e) {
    e.preventDefault()
    pair($('pair-code').value)
  })
  $('composer').addEventListener('submit', function (e) {
    e.preventDefault()
    sendText()
  })
  $('input').addEventListener('input', autosize)
  $('input').addEventListener('keydown', function (e) {
    // Entrée envoie sur un clavier physique ; sur téléphone, la touche « retour » ajoute une ligne.
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault()
      sendText()
    }
  })
  $('mic').addEventListener('click', startRecording)
  $('recording-send').addEventListener('click', function () {
    stopRecording(false)
  })
  $('recording-cancel').addEventListener('click', function () {
    stopRecording(true)
  })

  // Le code du QR voyage après « # » : jamais envoyé au serveur dans l'adresse, effacé dès qu'il est lu.
  function codeFromAddress() {
    var match = location.hash.match(/code=(\d{8})/)
    if (match) history.replaceState(null, '', location.pathname)
    return match ? match[1] : null
  }
  // Lien du QR ouvert alors que la page l'était déjà : le navigateur ne la recharge pas, seul le « # » change.
  window.addEventListener('hashchange', function () {
    var code = codeFromAddress()
    if (code && !token) {
      showPair('', code)
      pair(code)
    }
  })
  var initialCode = codeFromAddress()
  if (token) showChat()
  else if (initialCode) {
    showPair('', initialCode)
    pair(initialCode)
  } else showPair('')
})()
