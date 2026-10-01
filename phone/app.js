// Page du téléphone (étapes 214-215). Aucune bibliothèque : le code doit rester lisible et ne rien charger
// d'ailleurs (la page interdit tout script extérieur, voir l'en-tête Content-Security-Policy du serveur).
// Quatre onglets : Chat (écrit), Vocal (comme l'Agent vocal du PC), Image et Vidéo (créer + galerie).
// Tout le calcul se fait sur le PC : le téléphone n'envoie que du texte ou un enregistrement, et affiche.
'use strict'
;(function () {
  var TOKEN_KEY = 'jaris.phone.token'
  var TAB_KEY = 'jaris.phone.tab'
  var JOB_KEY = 'jaris.phone.job'
  var STUDIO_KEY = 'jaris.phone.studio'
  var QUALITY_KEY = 'jaris.phone.quality'
  var DURATION_KEY = 'jaris.phone.duration'
  var POLL_MS = 1200
  var MAX_RECORD_MS = 60000
  /** Silence après avoir parlé qui envoie tout seul, comme l'Agent vocal du PC. */
  var SILENCE_MS = 1500
  /** Rien entendu du tout : on arrête au lieu d'écouter le vide indéfiniment. */
  var NOTHING_HEARD_MS = 10000
  var SPEECH_LEVEL = 0.03
  var GALLERY_PAGE = { image: 12, video: 6 }
  var TABS = ['chat', 'voice', 'image', 'video']

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
  var currentTab = 'chat'
  /** Une seule conversation à la fois (Chat OU Vocal) : la même que sur le PC. */
  var conversationBusy = false
  var studioBusy = false

  function deviceName() {
    var ua = navigator.userAgent || ''
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua)) return 'iPad'
    if (/Android/.test(ua)) return 'Android'
    return 'Téléphone'
  }

  function authHeaders() {
    return token ? { Authorization: 'Bearer ' + token } : {}
  }

  function checkAuth(res, path) {
    if (res.status === 401 && path !== '/api/pair') {
      forgetToken('Ce téléphone a été déconnecté depuis le PC. Entre un nouveau code pour le reconnecter.')
      throw new Error('Non connecté.')
    }
  }

  function api(method, path, body, contentType) {
    var headers = authHeaders()
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
          checkAuth(res, path)
          if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status)
          return data
        })
    })
  }

  /** Fichier protégé (voix, image, vidéo) : jamais une adresse publique, toujours avec le jeton. */
  function apiBlobUrl(path) {
    return fetch(path, { headers: authHeaders(), cache: 'no-store' }).then(function (res) {
      checkAuth(res, path)
      if (!res.ok) throw new Error('Fichier indisponible.')
      return res.blob().then(function (blob) {
        return URL.createObjectURL(blob)
      })
    })
  }

  /** Suit un travail du PC jusqu'au bout. Un réseau coupé (4G, tunnel) n'arrête rien : on réessaie. */
  function pollJob(jobId, onRunning, onEnd) {
    var tick = function () {
      api('GET', '/api/jobs/' + jobId)
        .then(function (job) {
          if (job.state === 'running') {
            onRunning(job)
            setTimeout(tick, POLL_MS)
            return
          }
          onEnd(job, null)
        })
        .catch(function (err) {
          if (!token) return onEnd(null, err)
          // Jaris redémarré entre-temps : ce travail n'existe plus sur le PC.
          if (/introuvable/i.test(err.message)) return onEnd(null, err)
          setStatus('Connexion perdue, nouvel essai…')
          setTimeout(tick, POLL_MS * 3)
        })
    }
    tick()
  }

  // --- Affichage commun ------------------------------------------------------------------------------

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

  function setStatus(text) {
    $('top-status').textContent = text || 'Connecté à ton PC'
  }

  function refreshBusyLook() {
    $('top-orb').classList.toggle('orb--busy', conversationBusy || studioBusy)
    $('send').disabled = conversationBusy
    if (!conversationBusy && !studioBusy) setStatus('')
  }

  function setConversationBusy(value) {
    conversationBusy = value
    refreshBusyLook()
  }

  function selectTab(name) {
    if (TABS.indexOf(name) < 0) name = 'chat'
    var previous = currentTab
    currentTab = name
    writeStorage(localStorage, TAB_KEY, name)
    TABS.forEach(function (tab) {
      $('tab-' + tab).hidden = tab !== name
    })
    Array.prototype.forEach.call(document.querySelectorAll('.tabbar__item'), function (button) {
      var active = button.getAttribute('data-target') === name
      button.classList.toggle('tabbar__item--active', active)
      if (active) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })
    // Ce qui a été dit au Vocal fait partie de la conversation : le Chat le montre en y revenant.
    if (name === 'chat' && previous !== 'chat' && !conversationBusy) loadHistory()
    if (name === 'image' || name === 'video') {
      loadStudioStatus()
      loadGallery(name)
    }
  }

  // --- Appairage -------------------------------------------------------------------------------------

  function forgetToken(message) {
    token = null
    writeStorage(localStorage, TOKEN_KEY, null)
    showPair(message)
  }

  function showPair(message, code) {
    $('app').hidden = true
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
        showApp()
      })
      .catch(function (err) {
        showPair(err.message, digits)
      })
      .then(function () {
        $('pair-submit').disabled = false
      })
  }

  function showApp() {
    $('pair').hidden = true
    $('app').hidden = false
    // Le Chat recharge la conversation en s'ouvrant ; ailleurs on la charge quand même, pour reprendre une
    // réponse en cours.
    currentTab = null
    selectTab(readStorage(localStorage, TAB_KEY) || 'chat')
    if (currentTab !== 'chat') loadHistory()
    resumeStudio()
  }

  // --- Chat ------------------------------------------------------------------------------------------

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
    li.textContent = 'Écris à Jaris : il répond depuis ton PC, sans rien envoyer ailleurs. Pour lui parler, va dans Vocal.'
    list.appendChild(li)
  }

  function loadHistory() {
    return api('GET', '/api/history')
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
        if (pending && !conversationBusy) followChat(pending, addMessage('assistant', 'Jaris réfléchit…', { pending: true }))
      })
      .catch(function (err) {
        if (token) setStatus(err.message)
      })
  }

  function followChat(jobId, pendingBubble) {
    setConversationBusy(true)
    writeStorage(sessionStorage, JOB_KEY, jobId)
    pollJob(
      jobId,
      function (job) {
        renderText(pendingBubble.body, job.status || 'Jaris réfléchit…')
        setStatus(job.status || 'Jaris réfléchit…')
      },
      function (job, err) {
        writeStorage(sessionStorage, JOB_KEY, null)
        pendingBubble.item.remove()
        setConversationBusy(false)
        if (!job) {
          // La réponse est peut-être déjà dans l'historique (Jaris redémarré entre-temps).
          if (token) loadHistory()
          return
        }
        if (job.state === 'done') addMessage('assistant', job.reply, { image: job.image })
        else addMessage('assistant', job.error || 'Erreur sur le PC.', { error: true })
      }
    )
  }

  function sendText() {
    var input = $('input')
    var text = input.value.trim()
    if (!text || conversationBusy) return
    input.value = ''
    autosize()
    addMessage('user', text)
    var pending = addMessage('assistant', 'Jaris réfléchit…', { pending: true })
    setConversationBusy(true)
    api('POST', '/api/message', { text: text })
      .then(function (data) {
        followChat(data.jobId, pending)
      })
      .catch(function (err) {
        pending.item.remove()
        addMessage('assistant', err.message, { error: true })
        setConversationBusy(false)
      })
  }

  function autosize() {
    var input = $('input')
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 140) + 'px'
  }

  // --- Vocal -----------------------------------------------------------------------------------------
  // Le téléphone enregistre dans son propre format (webm ou mp4 selon la marque), puis le décode et le
  // convertit LUI-MÊME en WAV 16 kHz mono : le PC reçoit toujours le même format simple, celui que sa
  // transcription locale lit directement. La réponse revient en WAV, lue avec la voix de Jaris.

  var voice = {
    state: 'idle', // idle | listening | working | speaking
    recorder: null,
    stream: null,
    chunks: [],
    cancelled: false,
    meter: null,
    meterTimer: null,
    startedAt: 0,
    heard: false,
    silentSince: 0,
    replyUrl: null
  }
  var silentUrl = null

  function setVoiceState(state, text) {
    voice.state = state
    var orb = $('voice-orb')
    orb.className = 'voice__orb' + (state === 'idle' ? '' : ' voice__orb--' + state)
    $('voice-state').textContent = text
    $('voice-cancel').hidden = state !== 'listening'
    $('voice-help').hidden = state !== 'idle'
  }

  /**
   * iPhone : un son ne peut démarrer que pendant un geste. On « ouvre » donc le lecteur au moment du toucher
   * avec un silence, et c'est ce même lecteur qui jouera la réponse quelques secondes plus tard.
   */
  function unlockAudio() {
    var audio = $('voice-audio')
    if (!silentUrl) silentUrl = URL.createObjectURL(encodeWav(new Float32Array(1600), 16000))
    audio.src = silentUrl
    var played = audio.play()
    if (played && played.catch) played.catch(function () {})
  }

  function stopMeter() {
    clearInterval(voice.meterTimer)
    voice.meterTimer = null
    if (voice.meter) voice.meter.ctx.close().catch(function () {})
    voice.meter = null
  }

  function stopTracks() {
    if (voice.stream)
      voice.stream.getTracks().forEach(function (t) {
        t.stop()
      })
    voice.stream = null
  }

  function startListening() {
    if (conversationBusy) {
      setVoiceState('idle', 'Jaris répond encore au Chat : attends un instant.')
      return
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setVoiceState('idle', "Ce navigateur ne permet pas d'utiliser le micro.")
      return
    }
    unlockAudio()
    var AudioCtx = window.AudioContext || window.webkitAudioContext
    // Créé pendant le toucher : sinon l'iPhone le laisse suspendu et la pause ne serait jamais détectée.
    var meterCtx = AudioCtx ? new AudioCtx() : null
    setVoiceState('listening', 'Je t’écoute…')
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        if (voice.state !== 'listening') {
          stream.getTracks().forEach(function (t) {
            t.stop()
          })
          if (meterCtx) meterCtx.close().catch(function () {})
          return
        }
        voice.stream = stream
        voice.chunks = []
        voice.cancelled = false
        voice.heard = false
        voice.silentSince = 0
        var recorder = new MediaRecorder(stream)
        voice.recorder = recorder
        recorder.ondataavailable = function (e) {
          if (e.data && e.data.size) voice.chunks.push(e.data)
        }
        recorder.onstop = function () {
          stopTracks()
          stopMeter()
          voice.recorder = null
          if (voice.cancelled || !voice.chunks.length) return
          sendTalk(new Blob(voice.chunks, { type: recorder.mimeType }))
        }
        recorder.start()
        voice.startedAt = Date.now()
        startMeter(meterCtx, stream)
      })
      .catch(function () {
        if (meterCtx) meterCtx.close().catch(function () {})
        setVoiceState('idle', 'Micro refusé : autorise le micro pour cette page dans les réglages du téléphone.')
      })
  }

  /** Mesure le volume pour envoyer tout seul après une pause, comme l'Agent vocal du PC. */
  function startMeter(ctx, stream) {
    if (ctx) {
      try {
        if (ctx.resume) ctx.resume().catch(function () {})
        var analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(stream).connect(analyser)
        voice.meter = { ctx: ctx, analyser: analyser, samples: new Float32Array(analyser.fftSize) }
      } catch (e) {
        voice.meter = null
      }
    }
    voice.meterTimer = setInterval(function () {
      var now = Date.now()
      if (now - voice.startedAt >= MAX_RECORD_MS) return stopListening(false)
      if (!voice.meter) return
      voice.meter.analyser.getFloatTimeDomainData(voice.meter.samples)
      var sum = 0
      for (var i = 0; i < voice.meter.samples.length; i++) sum += voice.meter.samples[i] * voice.meter.samples[i]
      var level = Math.sqrt(sum / voice.meter.samples.length)
      $('voice-orb').style.setProperty('--level', String(Math.min(1, level * 8)))
      if (level > SPEECH_LEVEL) {
        voice.heard = true
        voice.silentSince = 0
      } else if (voice.heard) {
        if (!voice.silentSince) voice.silentSince = now
        else if (now - voice.silentSince > SILENCE_MS) stopListening(false)
      } else if (now - voice.startedAt > NOTHING_HEARD_MS) {
        stopListening(true)
        setVoiceState('idle', "Je n'ai rien entendu. Touche Jaris pour réessayer.")
      }
    }, 100)
  }

  function stopListening(cancel) {
    // Tout de suite : sinon le minuteur du volume pourrait rappeler cette fonction avant la fin de l'arrêt.
    stopMeter()
    var recording = Boolean(voice.recorder && voice.recorder.state !== 'inactive')
    voice.cancelled = cancel
    if (recording) voice.recorder.stop()
    else stopTracks()
    // Touché avant même que le micro ait démarré : rien à envoyer, on revient au repos.
    if (cancel || !recording) setVoiceState('idle', 'Touche Jaris pour parler')
    else setVoiceState('working', 'Envoi à ton PC…')
  }

  function stopSpeaking() {
    var audio = $('voice-audio')
    audio.pause()
    setVoiceState('idle', 'Touche Jaris pour parler')
  }

  function showVoiceExchange(transcript, reply, image) {
    $('voice-last').hidden = false
    $('voice-transcript').textContent = transcript || '…'
    renderText($('voice-reply'), reply || '')
    var img = $('voice-image')
    if (image && /^data:image\//.test(image)) {
      img.src = image
      img.hidden = false
    } else {
      img.hidden = true
      img.removeAttribute('src')
    }
  }

  function playReply() {
    var audio = $('voice-audio')
    if (!voice.replyUrl) return
    audio.src = voice.replyUrl
    var played = audio.play()
    setVoiceState('speaking', 'Jaris parle… touche-le pour l’arrêter')
    if (played && played.catch)
      played.catch(function () {
        // Lecture refusée par le téléphone (mode silencieux, autre geste) : un bouton pour l'écouter.
        $('voice-replay-label').textContent = 'Écouter la réponse'
        $('voice-replay').hidden = false
        setVoiceState('idle', 'Touche « Écouter la réponse », ou Jaris pour reparler')
      })
  }

  function sendTalk(blob) {
    setConversationBusy(true)
    $('voice-replay').hidden = true
    showVoiceExchange('…', '', null)
    toWav16k(blob)
      .then(function (wav) {
        return api('POST', '/api/talk', wav, 'audio/wav')
      })
      .then(function (data) {
        pollJob(
          data.jobId,
          function (job) {
            if (job.transcript) $('voice-transcript').textContent = job.transcript
            setVoiceState('working', job.status || 'Jaris réfléchit…')
            setStatus(job.status || 'Jaris réfléchit…')
          },
          function (job, err) {
            setConversationBusy(false)
            if (!job) return setVoiceState('idle', (err && err.message) || 'Erreur sur le PC.')
            if (job.transcript) $('voice-transcript').textContent = job.transcript
            if (job.state !== 'done') {
              if (!job.transcript) $('voice-last').hidden = true
              return setVoiceState('idle', job.error || 'Erreur sur le PC.')
            }
            showVoiceExchange(job.transcript, job.reply, job.image)
            if (!job.audio) return setVoiceState('idle', 'Touche Jaris pour reparler (la voix n’est pas disponible sur le PC).')
            apiBlobUrl('/api/jobs/' + job.id + '/audio')
              .then(function (url) {
                if (voice.replyUrl) URL.revokeObjectURL(voice.replyUrl)
                voice.replyUrl = url
                $('voice-replay-label').textContent = 'Réécouter'
                $('voice-replay').hidden = false
                playReply()
              })
              .catch(function () {
                setVoiceState('idle', 'Touche Jaris pour reparler (voix non reçue).')
              })
          }
        )
      })
      .catch(function (err) {
        setConversationBusy(false)
        $('voice-last').hidden = true
        setVoiceState('idle', err.message || "Le message n'a pas pu être envoyé.")
      })
  }

  function onVoiceOrb() {
    if (voice.state === 'idle') startListening()
    else if (voice.state === 'listening') stopListening(false)
    else if (voice.state === 'speaking') stopSpeaking()
  }

  function toWav16k(blob) {
    var AudioCtx = window.AudioContext || window.webkitAudioContext
    return blob
      .arrayBuffer()
      .then(function (data) {
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
      })
      .then(function (rendered) {
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

  // --- Image et Vidéo --------------------------------------------------------------------------------
  // Le téléphone ne télécharge et n'installe rien : il propose seulement ce qui est DÉJÀ prêt sur le PC.

  var studio = null
  var galleries = {
    image: { items: [], shown: 0, thumbs: {} },
    video: { items: [], shown: 0, thumbs: {} }
  }
  var canPlayWebm = (function () {
    try {
      return Boolean(document.createElement('video').canPlayType('video/webm'))
    } catch (e) {
      return false
    }
  })()

  function loadStudioStatus() {
    return api('GET', '/api/studio')
      .then(function (data) {
        studio = data
        applyStudio('image', data.image)
        applyStudio('video', data.video)
        renderVideoOptions(data.video)
      })
      .catch(function (err) {
        if (token) showStudioError(currentTab === 'video' ? 'video' : 'image', err.message)
      })
  }

  function applyStudio(kind, info) {
    var notice = $(kind + '-unavailable')
    notice.hidden = info.ready
    notice.textContent = info.ready ? '' : info.reason || 'Pas encore prêt sur ton PC.'
    $(kind + '-form').hidden = !info.ready
  }

  function chipGroup(container, values, selected, label, onPick) {
    container.textContent = ''
    values.forEach(function (value) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'chip' + (value.id === selected ? ' chip--active' : '')
      button.setAttribute('role', 'radio')
      button.setAttribute('aria-checked', value.id === selected ? 'true' : 'false')
      button.textContent = label(value)
      button.addEventListener('click', function () {
        onPick(value.id)
      })
      container.appendChild(button)
    })
  }

  function renderVideoOptions(info) {
    if (!info.ready) return
    var qualities = info.qualities || []
    var quality = readStorage(localStorage, QUALITY_KEY)
    if (!qualities.some(function (q) { return q.id === quality })) quality = qualities.length ? qualities[0].id : ''
    var durations = info.durations || []
    var duration = Number(readStorage(localStorage, DURATION_KEY))
    if (durations.indexOf(duration) < 0) duration = durations.indexOf(2) >= 0 ? 2 : durations[0]
    chipGroup($('video-qualities'), qualities, quality, function (q) {
      return q.label
    }, function (id) {
      writeStorage(localStorage, QUALITY_KEY, id)
      renderVideoOptions(info)
    })
    chipGroup(
      $('video-durations'),
      durations.map(function (d) {
        return { id: d }
      }),
      duration,
      function (d) {
        return d.id + ' s'
      },
      function (id) {
        writeStorage(localStorage, DURATION_KEY, String(id))
        renderVideoOptions(info)
      }
    )
    $('video-form').setAttribute('data-quality', quality)
    $('video-form').setAttribute('data-duration', String(duration))
  }

  function showStudioError(kind, message) {
    var error = $(kind + '-error')
    error.hidden = !message
    error.textContent = message || ''
  }

  function formatDate(timestamp) {
    try {
      return new Date(timestamp).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    } catch (e) {
      return ''
    }
  }

  function mediaPath(kind, fileName) {
    return '/api/' + (kind === 'image' ? 'images/' : 'videos/') + encodeURIComponent(fileName)
  }

  function loadGallery(kind) {
    return api('GET', kind === 'image' ? '/api/images' : '/api/videos')
      .then(function (data) {
        var gallery = galleries[kind]
        gallery.items = data.items || []
        gallery.shown = 0
        $(kind + '-gallery').textContent = ''
        if (!gallery.items.length) {
          var li = document.createElement('li')
          li.className = 'gallery__empty'
          li.textContent = kind === 'image' ? 'Aucune image pour l’instant : décris-en une au-dessus.' : 'Aucune vidéo pour l’instant : décris-en une au-dessus.'
          $(kind + '-gallery').appendChild(li)
        }
        showMore(kind)
      })
      .catch(function (err) {
        if (token) showStudioError(kind, err.message)
      })
  }

  function showMore(kind) {
    var gallery = galleries[kind]
    var next = gallery.items.slice(gallery.shown, gallery.shown + GALLERY_PAGE[kind])
    next.forEach(function (item) {
      $(kind + '-gallery').appendChild(renderTile(kind, item))
    })
    gallery.shown += next.length
    $(kind + '-more').hidden = gallery.shown >= gallery.items.length
  }

  function renderTile(kind, item) {
    var li = document.createElement('li')
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'tile tile--' + kind
    button.setAttribute('aria-label', (kind === 'image' ? 'Voir l’image ' : 'Voir la vidéo ') + item.label)
    var frame = document.createElement('span')
    frame.className = 'tile__frame'
    button.appendChild(frame)
    if (kind === 'video') {
      var play = document.createElement('span')
      play.className = 'tile__play'
      play.setAttribute('aria-hidden', 'true')
      frame.appendChild(play)
    }
    var caption = document.createElement('span')
    caption.className = 'tile__caption'
    var title = document.createElement('span')
    title.className = 'tile__label'
    title.textContent = item.label
    var date = document.createElement('span')
    date.className = 'tile__date'
    date.textContent = formatDate(item.timestamp)
    caption.appendChild(title)
    caption.appendChild(date)
    button.appendChild(caption)
    button.addEventListener('click', function () {
      openViewer(kind, item)
    })
    li.appendChild(button)
    loadThumbnail(kind, item, frame)
    return li
  }

  function loadThumbnail(kind, item, frame) {
    var thumbs = galleries[kind].thumbs
    var show = function (url) {
      if (kind === 'image') {
        var img = document.createElement('img')
        img.alt = ''
        img.src = url
        frame.insertBefore(img, frame.firstChild)
      } else {
        var video = document.createElement('video')
        video.muted = true
        video.playsInline = true
        video.setAttribute('playsinline', '')
        video.preload = 'metadata'
        // « #t=0.1 » : l'iPhone affiche alors la première image au lieu d'un cadre noir.
        video.src = url + '#t=0.1'
        frame.insertBefore(video, frame.firstChild)
      }
    }
    if (thumbs[item.fileName]) return show(thumbs[item.fileName])
    // Vidéo illisible sur ce téléphone : pas la peine de la télécharger juste pour une vignette noire.
    if (kind === 'video' && !canPlayWebm) return
    apiBlobUrl(kind === 'image' ? mediaPath('image', item.fileName) + '?thumb=1' : mediaPath('video', item.fileName))
      .then(function (url) {
        thumbs[item.fileName] = url
        show(url)
      })
      .catch(function () {})
  }

  /** Image en grand ouverte dans la visionneuse : libérée à la fermeture (les vidéos restent en vignette). */
  var viewerImageUrl = null

  function openViewer(kind, item) {
    var viewer = $('viewer')
    var media = $('viewer-media')
    media.textContent = ''
    $('viewer-title').textContent = item.label
    $('viewer-note').hidden = true
    var save = $('viewer-save')
    save.hidden = true
    viewer.hidden = false
    var loading = document.createElement('p')
    loading.className = 'viewer__loading'
    loading.textContent = 'Chargement depuis ton PC…'
    media.appendChild(loading)
    var cached = kind === 'video' ? galleries.video.thumbs[item.fileName] : null
    ;(cached ? Promise.resolve(cached) : apiBlobUrl(mediaPath(kind, item.fileName)))
      .then(function (url) {
        if (viewer.hidden) return
        if (kind === 'video') galleries.video.thumbs[item.fileName] = url
        media.textContent = ''
        if (kind === 'image') {
          viewerImageUrl = url
          var img = document.createElement('img')
          img.alt = item.label
          img.src = url
          media.appendChild(img)
        } else {
          var video = document.createElement('video')
          video.controls = true
          video.loop = true
          video.playsInline = true
          video.setAttribute('playsinline', '')
          video.src = url
          media.appendChild(video)
          if (canPlayWebm) {
            var played = video.play()
            if (played && played.catch) played.catch(function () {})
          } else {
            var note = $('viewer-note')
            note.textContent = 'Ton téléphone ne sait pas lire ce format de vidéo (WebM) : enregistre-la, ou regarde-la sur le PC.'
            note.hidden = false
          }
        }
        save.href = url
        save.setAttribute('download', item.fileName)
        save.hidden = false
      })
      .catch(function (err) {
        media.textContent = ''
        var note = $('viewer-note')
        note.textContent = err.message
        note.hidden = false
      })
  }

  function closeViewer() {
    var media = $('viewer-media')
    var video = media.querySelector('video')
    if (video) video.pause()
    media.textContent = ''
    $('viewer').hidden = true
    if (viewerImageUrl) URL.revokeObjectURL(viewerImageUrl)
    viewerImageUrl = null
  }

  function setStudioBusy(kind, jobId, status) {
    studioBusy = Boolean(jobId)
    ;['image', 'video'].forEach(function (k) {
      $(k + '-create').disabled = studioBusy
      $(k + '-progress').hidden = !(studioBusy && k === kind)
    })
    if (jobId) {
      $(kind + '-status').textContent = status || 'Préparation…'
      $(kind + '-stop').setAttribute('data-job', jobId)
      writeStorage(sessionStorage, STUDIO_KEY, JSON.stringify({ id: jobId, kind: kind }))
    } else writeStorage(sessionStorage, STUDIO_KEY, null)
    refreshBusyLook()
  }

  function followStudio(kind, jobId) {
    setStudioBusy(kind, jobId, 'Préparation…')
    showStudioError(kind, '')
    pollJob(
      jobId,
      function (job) {
        $(kind + '-status').textContent = job.status || 'En cours…'
        if (currentTab === kind) setStatus(kind === 'image' ? 'Image en cours…' : 'Vidéo en cours…')
      },
      function (job, err) {
        setStudioBusy(kind, null)
        if (!job) return showStudioError(kind, err ? err.message : 'Erreur sur le PC.')
        if (job.state === 'cancelled') return showStudioError(kind, 'Création arrêtée.')
        if (job.state !== 'done') return showStudioError(kind, job.error || 'Erreur sur le PC.')
        $(kind + '-prompt').value = ''
        loadGallery(kind).then(function () {
          var made = galleries[kind].items.filter(function (item) {
            return item.fileName === job.fileName
          })[0]
          if (made && currentTab === kind) openViewer(kind, made)
        })
      }
    )
  }

  function resumeStudio() {
    var saved = readStorage(sessionStorage, STUDIO_KEY)
    if (!saved || studioBusy) return
    try {
      var job = JSON.parse(saved)
      if (job && job.id && (job.kind === 'image' || job.kind === 'video')) followStudio(job.kind, job.id)
    } catch (e) {
      writeStorage(sessionStorage, STUDIO_KEY, null)
    }
  }

  function create(kind) {
    if (studioBusy) return
    var prompt = $(kind + '-prompt').value.trim()
    if (!prompt) {
      showStudioError(kind, kind === 'image' ? 'Décris l’image à créer.' : 'Décris la vidéo à créer.')
      return
    }
    var body = { prompt: prompt }
    if (kind === 'video') {
      body.quality = $('video-form').getAttribute('data-quality')
      body.seconds = Number($('video-form').getAttribute('data-duration'))
    }
    showStudioError(kind, '')
    $(kind + '-create').disabled = true
    api('POST', kind === 'image' ? '/api/image' : '/api/video', body)
      .then(function (data) {
        followStudio(kind, data.jobId)
      })
      .catch(function (err) {
        $(kind + '-create').disabled = studioBusy
        showStudioError(kind, err.message)
      })
  }

  function stopStudio(kind) {
    var jobId = $(kind + '-stop').getAttribute('data-job')
    if (!jobId) return
    $(kind + '-status').textContent = 'Arrêt en cours…'
    api('POST', '/api/jobs/' + jobId + '/cancel', {}).catch(function (err) {
      showStudioError(kind, err.message)
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
  Array.prototype.forEach.call(document.querySelectorAll('.tabbar__item'), function (button) {
    button.addEventListener('click', function () {
      selectTab(button.getAttribute('data-target'))
    })
  })
  $('voice-orb').addEventListener('click', onVoiceOrb)
  $('voice-cancel').addEventListener('click', function () {
    stopListening(true)
  })
  $('voice-replay').addEventListener('click', playReply)
  $('voice-audio').addEventListener('ended', function () {
    if (voice.state === 'speaking') setVoiceState('idle', 'Touche Jaris pour reparler')
  })
  ;['image', 'video'].forEach(function (kind) {
    $(kind + '-form').addEventListener('submit', function (e) {
      e.preventDefault()
      create(kind)
    })
    $(kind + '-stop').addEventListener('click', function () {
      stopStudio(kind)
    })
    $(kind + '-more').addEventListener('click', function () {
      showMore(kind)
    })
  })
  $('viewer-close').addEventListener('click', closeViewer)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('viewer').hidden) closeViewer()
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
  if (token) showApp()
  else if (initialCode) {
    showPair('', initialCode)
    pair(initialCode)
  } else showPair('')
})()
