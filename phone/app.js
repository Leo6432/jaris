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

  function api(method, path, body, contentType, timeoutMs) {
    var headers = authHeaders()
    if (body !== undefined) headers['Content-Type'] = contentType || 'application/json'
    var controller = timeoutMs && window.AbortController ? new AbortController() : null
    var timer = controller
      ? setTimeout(function () {
          controller.abort()
        }, timeoutMs)
      : null
    return fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    })
      .catch(function (err) {
        if (controller && controller.signal.aborted) throw new Error("L'envoi à ton PC n'a pas abouti à temps : vérifie le réseau, puis réessaie.")
        throw err
      })
      .then(function (res) {
        clearTimeout(timer)
        return handleResponse(res, path)
      })
  }

  function handleResponse(res, path) {
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
    loadModel('chat')
    loadModel('voice')
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
  // Étape 216 (Léo, sur iPhone : « ça bloque sur Envoi à ton PC ») : le son du micro est lu DIRECTEMENT,
  // échantillon par échantillon, puis ramené à 16 kHz et mis en WAV ici. Avant, le téléphone l'enregistrait
  // dans son format (MediaRecorder), puis le décodait et le convertissait : trois étapes propres à chaque
  // navigateur, dont une pouvait ne jamais répondre sans rien dire. Désormais chaque étape a une fin visible.
  // La réponse revient en WAV, lue avec la voix de Jaris.

  var UPLOAD_TIMEOUT_MS = 60000
  /** Le micro doit envoyer du son à la page dans ce délai, sinon on le dit au lieu d'attendre. */
  var NO_SOUND_MS = 3000
  /** Trop court pour contenir une phrase : on ne dérange pas le PC pour rien. */
  var MIN_SPEECH_MS = 400

  var voice = {
    state: 'idle', // idle | listening | working | speaking
    ctx: null,
    stream: null,
    nodes: null,
    chunks: [],
    frames: 0,
    rate: 48000,
    timer: null,
    startedAt: 0,
    heard: false,
    lastLoudAt: 0,
    level: 0,
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
    $('voice-model').disabled = state !== 'idle'
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

  /** Coupe le micro et libère tout ce qui écoutait. Sans effet si rien n'écoute. */
  function releaseMic() {
    clearInterval(voice.timer)
    voice.timer = null
    if (voice.nodes) {
      voice.nodes.processor.onaudioprocess = null
      try {
        voice.nodes.source.disconnect()
        voice.nodes.processor.disconnect()
      } catch (e) {
        // déjà déconnectés
      }
    }
    voice.nodes = null
    if (voice.stream)
      voice.stream.getTracks().forEach(function (t) {
        t.stop()
      })
    voice.stream = null
    if (voice.ctx) voice.ctx.close().catch(function () {})
    voice.ctx = null
    $('voice-orb').style.setProperty('--level', '0')
  }

  function startListening() {
    if (conversationBusy) {
      setVoiceState('idle', 'Jaris répond encore au Chat : attends un instant.')
      return
    }
    var AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AudioCtx) {
      setVoiceState('idle', "Ce navigateur ne permet pas d'utiliser le micro.")
      return
    }
    unlockAudio()
    // Créé et relancé PENDANT le toucher : sinon l'iPhone le laisse en pause et aucun son n'arrive.
    var ctx = new AudioCtx()
    if (ctx.resume) ctx.resume().catch(function () {})
    voice.ctx = ctx
    setVoiceState('listening', 'Je t’écoute…')
    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        if (voice.state !== 'listening' || voice.ctx !== ctx) {
          stream.getTracks().forEach(function (t) {
            t.stop()
          })
          return
        }
        voice.stream = stream
        voice.chunks = []
        voice.frames = 0
        voice.rate = ctx.sampleRate
        voice.heard = false
        voice.lastLoudAt = 0
        var source = ctx.createMediaStreamSource(stream)
        var processor = ctx.createScriptProcessor(4096, 1, 1)
        processor.onaudioprocess = function (event) {
          if (voice.state !== 'listening') return
          var data = event.inputBuffer.getChannelData(0)
          voice.chunks.push(new Float32Array(data))
          voice.frames += data.length
          var sum = 0
          for (var i = 0; i < data.length; i++) sum += data[i] * data[i]
          voice.level = Math.sqrt(sum / data.length)
          if (voice.level > SPEECH_LEVEL) {
            voice.heard = true
            voice.lastLoudAt = Date.now()
          }
        }
        source.connect(processor)
        // Indispensable pour que le navigateur fasse tourner le traitement ; la sortie reste silencieuse.
        processor.connect(ctx.destination)
        voice.nodes = { source: source, processor: processor }
        voice.startedAt = Date.now()
        voice.timer = setInterval(watchListening, 150)
      })
      .catch(function () {
        releaseMic()
        setVoiceState('idle', 'Micro refusé : autorise le micro pour cette page dans les réglages du téléphone.')
      })
  }

  /** Volume, pause qui envoie toute seule (comme l'Agent vocal du PC), durée maximale, micro muet. */
  function watchListening() {
    var now = Date.now()
    $('voice-orb').style.setProperty('--level', String(Math.min(1, voice.level * 8)))
    if (!voice.frames && now - voice.startedAt > NO_SOUND_MS) {
      releaseMic()
      setVoiceState('idle', "Le micro n'envoie aucun son à la page. Touche Jaris pour réessayer ; si ça recommence, dis-le-moi.")
      return
    }
    if (now - voice.startedAt >= MAX_RECORD_MS) return finishListening(true)
    if (voice.heard && now - voice.lastLoudAt > SILENCE_MS) return finishListening(true)
    if (!voice.heard && now - voice.startedAt > NOTHING_HEARD_MS) {
      releaseMic()
      setVoiceState('idle', "Je n'ai rien entendu. Touche Jaris pour réessayer.")
    }
  }

  function finishListening(send) {
    var chunks = voice.chunks
    var frames = voice.frames
    var rate = voice.rate
    voice.chunks = []
    releaseMic()
    if (!send) return setVoiceState('idle', 'Touche Jaris pour parler')
    if (frames < (rate * MIN_SPEECH_MS) / 1000) return setVoiceState('idle', 'Trop court : touche Jaris, parle, puis fais une pause.')
    sendTalk(encodeWav(downsampleTo16k(chunks, frames, rate), 16000))
  }

  /** Le son du micro (souvent 48 kHz) ramené à 16 kHz, en moyennant chaque groupe d'échantillons. */
  function downsampleTo16k(chunks, frames, rate) {
    var input = new Float32Array(frames)
    var offset = 0
    chunks.forEach(function (chunk) {
      input.set(chunk, offset)
      offset += chunk.length
    })
    if (rate === 16000) return input
    var ratio = rate / 16000
    var output = new Float32Array(Math.floor(frames / ratio))
    for (var i = 0; i < output.length; i++) {
      var start = Math.floor(i * ratio)
      var end = Math.min(frames, Math.floor((i + 1) * ratio))
      var sum = 0
      for (var j = start; j < end; j++) sum += input[j]
      output[i] = end > start ? sum / (end - start) : input[start]
    }
    return output
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

  function sendTalk(wav) {
    setConversationBusy(true)
    setVoiceState('working', 'Envoi à ton PC…')
    $('voice-replay').hidden = true
    showVoiceExchange('…', '', null)
    // Un envoi qui ne répond jamais (réseau, tunnel) finit par un message, jamais par une attente sans fin.
    api('POST', '/api/talk', wav, 'audio/wav', UPLOAD_TIMEOUT_MS)
      .then(function (data) {
        setVoiceState('working', 'Transcription sur ton PC…')
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
    else if (voice.state === 'listening') finishListening(true)
    else if (voice.state === 'speaking') stopSpeaking()
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

  // --- Modèle et réflexion --------------------------------------------------------------------------
  // Étape 216 (Léo : « on peut pas choisir les modèles, pas comme le PC ») : le même sélecteur que le PC, et le
  // même réglage — choisi ici, il l'est aussi sur le PC. Chat et Vocal ont chacun le leur, comme sur le PC.

  var modelInfo = { chat: null, voice: null }
  var sheetMode = null

  function thinkLabelOf(info) {
    var thinking = info && info.thinking
    if (!thinking || thinking.selected === null || thinking.selected === undefined) return null
    var option = (thinking.options || []).filter(function (o) {
      return o.value === thinking.selected
    })[0]
    return option ? option.label : null
  }

  function modelLabelOf(info) {
    if (!info || info.selected === null || info.selected === undefined) return 'Auto'
    var role = (info.roles || []).filter(function (r) {
      return r.value === info.selected
    })[0]
    return role ? role.label : 'Personnalisé'
  }

  function renderModelChip(mode) {
    var info = modelInfo[mode]
    var think = thinkLabelOf(info)
    $(mode + '-model').querySelector('.model-chip__label').textContent = modelLabelOf(info) + (think ? ' · ' + think : '')
  }

  function loadModel(mode) {
    return api('GET', '/api/model?mode=' + mode)
      .then(function (info) {
        modelInfo[mode] = info
        renderModelChip(mode)
        if (sheetMode === mode) renderSheet()
      })
      .catch(function (err) {
        if (sheetMode === mode) showSheetError(err.message)
      })
  }

  function showSheetError(message) {
    $('sheet-error').hidden = !message
    $('sheet-error').textContent = message || ''
  }

  function openSheet(mode) {
    sheetMode = mode
    $('sheet-scope').textContent =
      mode === 'chat' ? 'Pour le Chat : le même réglage que le Chat du PC.' : 'Pour le Vocal : le même réglage que l’Agent vocal du PC.'
    showSheetError('')
    $('sheet').hidden = false
    renderSheet()
    loadModel(mode)
  }

  function closeSheet() {
    sheetMode = null
    $('sheet').hidden = true
  }

  function sheetRow(label, hint, selected, disabled, onPick) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'sheet__row' + (selected ? ' sheet__row--active' : '')
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', selected ? 'true' : 'false')
    button.disabled = disabled
    var text = document.createElement('span')
    text.className = 'sheet__row-text'
    var name = document.createElement('span')
    name.className = 'sheet__row-label'
    name.textContent = label
    var small = document.createElement('span')
    small.className = 'sheet__row-hint'
    small.textContent = hint
    text.appendChild(name)
    text.appendChild(small)
    button.appendChild(text)
    var check = document.createElement('span')
    check.className = 'sheet__check'
    check.setAttribute('aria-hidden', 'true')
    button.appendChild(check)
    button.addEventListener('click', onPick)
    return button
  }

  function renderSheet() {
    var mode = sheetMode
    var info = modelInfo[mode]
    var list = $('sheet-models')
    list.textContent = ''
    var thinks = $('sheet-thinks')
    thinks.textContent = ''
    var note = $('sheet-think-note')
    if (!info) {
      note.hidden = false
      note.textContent = 'Chargement depuis ton PC…'
      return
    }
    var offline = info.installed === null
    list.appendChild(
      sheetRow('Auto', 'Jaris choisit le modèle selon la question', info.selected === null, offline, function () {
        choose('/api/model', { mode: mode, model: null })
      })
    )
    ;(info.roles || []).forEach(function (role) {
      list.appendChild(
        sheetRow(role.label, role.model + (role.installed ? '' : ' — pas installé sur le PC'), info.selected === role.value, offline || !role.installed, function () {
          choose('/api/model', { mode: mode, model: role.value })
        })
      )
    })
    var thinking = info.thinking
    note.hidden = false
    if (offline) note.textContent = 'Ollama ne répond pas sur le PC : impossible de changer de modèle pour l’instant.'
    else if (!thinking) note.textContent = 'Choisis d’abord un modèle : en Auto, il change selon la question.'
    else if (thinking.kind === 'none') note.textContent = 'Ce modèle ne réfléchit pas avant de répondre.'
    else if (thinking.kind === 'unknown') note.textContent = 'Ollama ne dit pas si ce modèle sait réfléchir.'
    else note.hidden = true
    if (offline || !thinking || !thinking.options || !thinking.options.length) return
    var values = [{ value: null, label: 'Auto' }].concat(thinking.options)
    values.forEach(function (option) {
      var button = document.createElement('button')
      button.type = 'button'
      var selected = option.value === null ? thinking.selected === null || thinking.selected === undefined : option.value === thinking.selected
      button.className = 'chip' + (selected ? ' chip--active' : '')
      button.setAttribute('role', 'radio')
      button.setAttribute('aria-checked', selected ? 'true' : 'false')
      button.textContent = option.label
      button.addEventListener('click', function () {
        choose('/api/think', { mode: mode, think: option.value })
      })
      thinks.appendChild(button)
    })
  }

  function choose(path, body) {
    showSheetError('')
    api('POST', path, body)
      .then(function (info) {
        modelInfo[body.mode] = info
        renderModelChip(body.mode)
        if (sheetMode === body.mode) renderSheet()
      })
      .catch(function (err) {
        showSheetError(err.message)
      })
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
    finishListening(false)
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
  ;['chat', 'voice'].forEach(function (mode) {
    $(mode + '-model').addEventListener('click', function () {
      openSheet(mode)
    })
  })
  $('sheet-close').addEventListener('click', closeSheet)
  // Toucher le fond sombre ferme le panneau, comme sur une appli de téléphone.
  $('sheet').addEventListener('click', function (e) {
    if (e.target === $('sheet')) closeSheet()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('viewer').hidden) closeViewer()
    if (e.key === 'Escape' && !$('sheet').hidden) closeSheet()
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
